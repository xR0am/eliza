/**
 * The "reply unavailable" notice after a failed turn goes only to a sender who
 * asked: a DM or a guild message addressed to the bot. A guild message the
 * agent chose to answer on its own fails silently. Drives the real
 * MessageManager with Discord network objects stubbed.
 */
import { randomUUID } from "node:crypto";
import {
	ChannelType,
	createUniqueUuid,
	type Memory,
	type UUID,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const BOT_USER_ID = "888000000000000000";
const AUTHOR_ID = "555000111222333444";
const CHANNEL_ID = "777000000000000001";
const GUILD_ID = "111000000000000000";

function makeHarness({
	inboundId,
	content,
	dm = false,
	mentionsBot = false,
}: {
	inboundId: string;
	content: string;
	dm?: boolean;
	mentionsBot?: boolean;
}) {
	const memories = new Map<string, Memory>();
	const sends: string[] = [];
	const turns: string[] = [];
	const rooms = new Map<UUID, Record<string, unknown>>();
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "Eliza" },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		getSetting: () => undefined,
		getService: () => null,
		ensureConnection: vi.fn(async (params: { roomId: UUID }) => {
			rooms.set(params.roomId, { id: params.roomId, ...params });
		}),
		getRoom: vi.fn(async (roomId: UUID) => rooms.get(roomId) ?? null),
		getWorld: vi.fn(async () => null),
		getParticipantsForRoom: vi.fn(async () => []),
		reportError: vi.fn(),
		getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
		createMemory: vi.fn(async (memory: Memory) => {
			const id = memory.id ?? (randomUUID() as UUID);
			memories.set(id, { ...memory, id });
			return id;
		}),
		getMemories: vi.fn(async () => []),
		messageService: {
			// The agent took the turn, then generation failed before any reply.
			handleMessage: async (_runtime: unknown, message: Memory) => {
				if (message.id) memories.set(message.id, message);
				turns.push(message.id as string);
				throw Object.assign(new Error("reply grounding failed"), {
					code: "REPLY_GROUNDING_FAILED",
				});
			},
		},
		emitEvent: vi.fn(),
	} as unknown as ICompatRuntime;
	const botUser = { id: BOT_USER_ID, bot: true, username: "eliza" };
	// A guild where the bot can view, send, and read history in the channel.
	const guild = {
		id: GUILD_ID,
		members: { me: null, cache: new Map([[BOT_USER_ID, { user: botUser }]]) },
	};
	const channel = {
		id: CHANNEL_ID,
		name: "general",
		type: dm ? DiscordChannelType.DM : DiscordChannelType.GuildText,
		isThread: () => false,
		...(dm
			? {}
			: {
					guild,
					client: { user: botUser },
					permissionsFor: () => ({ has: () => true }),
				}),
		send: async (options: { content?: string }) => {
			sends.push(options.content ?? "");
			return {
				id: `99000000000000000${sends.length}`,
				content: options.content ?? "",
				url: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${sends.length}`,
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
			};
		},
		sendTyping: vi.fn(async () => {}),
	};
	const service = {
		client: { user: { id: BOT_USER_ID } },
		accountId: "default",
		getChannelType: async () => (dm ? ChannelType.DM : ChannelType.GROUP),
		discordSettings: {
			// Not strict mode: the agent may answer unaddressed guild messages.
			autoReply: true,
			shouldRespondOnlyToMentions: false,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "off",
		},
		buildMemoryFromMessage: vi.fn(async (inbound: DiscordMessage) => ({
			id: createUniqueUuid(runtime, inbound.id),
			entityId: createUniqueUuid(runtime, AUTHOR_ID),
			agentId: AGENT_ID,
			roomId: createUniqueUuid(runtime, CHANNEL_ID),
			content: { text: content, source: "discord" },
		})),
	} as unknown as IDiscordService;
	const inbound = {
		id: inboundId,
		content,
		createdTimestamp: Date.now(),
		author: {
			id: AUTHOR_ID,
			bot: false,
			username: "tester",
			globalName: "Tester",
			displayName: "Tester",
			discriminator: "0",
		},
		member: null,
		channel,
		channelId: CHANNEL_ID,
		guild: dm ? undefined : guild,
		interaction: null,
		reference: undefined,
		embeds: [],
		stickers: { size: 0 },
		attachments: { size: 0 },
		mentions: {
			users: new Map(mentionsBot ? [[BOT_USER_ID, botUser]] : []),
			roles: new Map(),
			repliedUser: undefined,
		},
	} as unknown as DiscordMessage;
	return {
		run: () => new MessageManager(service, runtime).handleMessage(inbound),
		sends,
		turns,
	};
}

describe("Discord failure notice after a failed turn", () => {
	it("stays silent in a guild channel when the message did not address the bot", async () => {
		const h = makeHarness({
			inboundId: "666000000000000010",
			content: "big airdrop live now, claim at example.com",
		});
		await h.run();
		// The turn reached generation and failed there.
		expect(h.turns).toHaveLength(1);
		expect(h.sends).toEqual([]);
	});

	it("sends the notice in a guild channel when the message @mentions the bot", async () => {
		const h = makeHarness({
			inboundId: "666000000000000011",
			content: `<@${BOT_USER_ID}> what's the status?`,
			mentionsBot: true,
		});
		await h.run();
		expect(h.turns).toHaveLength(1);
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]).not.toBe("");
	});

	it("sends the notice in a DM", async () => {
		const h = makeHarness({
			inboundId: "666000000000000012",
			content: "what's the status?",
			dm: true,
		});
		await h.run();
		expect(h.turns).toHaveLength(1);
		expect(h.sends).toHaveLength(1);
	});
});
