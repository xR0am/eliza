/**
 * Newline-delimited JSON-RPC ACP server (protocol v2) over stdio.
 */
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentRuntime } from "@elizaos/core";
import type { BenchmarkTask } from "@elizaos/agent/cli/benchmark.ts";
import { applyElizaAcpProfileEnv } from "../profile-env.ts";

const ACP_PROTOCOL_VERSION = 2;
const AGENT_NAME = "eliza-acp";

export type AcpMcpServerConfig =
  | {
      name: string;
      command: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
    }
  | {
      name: string;
      type: "http";
      url: string;
      headers?: Array<{ name: string; value: string }>;
    };

type SessionState = {
  sessionId: string;
  mcpServers: AcpMcpServerConfig[];
  cwd?: string;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type RunElizaAcpServerOptions = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

let runtimePromise: Promise<AgentRuntime> | undefined;
let runtimeAbort: AbortController | undefined;
const sessionPromptAbort = new Map<string, AbortController>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeLine(
  output: NodeJS.WritableStream,
  obj: Record<string, unknown>,
): void {
  output.write(`${JSON.stringify(obj)}\n`);
}

function notifySessionUpdate(
  output: NodeJS.WritableStream,
  sessionId: string,
  update: Record<string, unknown>,
): void {
  writeLine(output, {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

export function extractPromptText(params: Record<string, unknown> | undefined): string {
  const prompt = params?.prompt;
  if (!Array.isArray(prompt)) return "";
  const parts: string[] = [];
  for (const part of prompt) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function parseMcpServers(raw: unknown): AcpMcpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is AcpMcpServerConfig => {
    if (!isRecord(entry)) return false;
    if (typeof entry.name !== "string" || !entry.name) return false;
    if (entry.type === "http") {
      return typeof entry.url === "string" && entry.url.length > 0;
    }
    return typeof entry.command === "string" && entry.command.length > 0;
  });
}

function mergeSessionMcpIntoProcess(mcpServers: AcpMcpServerConfig[]): void {
  process.env.ELIZA_ACP_SESSION_MCP = JSON.stringify(mcpServers);
}

function negotiatedProtocolVersion(
  params: Record<string, unknown> | undefined,
): number {
  const requested = params?.protocolVersion;
  if (typeof requested === "number" && requested === 1) return 1;
  return ACP_PROTOCOL_VERSION;
}

function lightModeAck(promptText: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(promptText)
    .digest("hex")
    .slice(0, 16);
  return `ELIZA-ACP-LIGHT:${digest}`;
}

async function ensureRuntime(): Promise<AgentRuntime> {
  if (!runtimePromise) {
    applyElizaAcpProfileEnv();
    process.env.ELIZA_HEADLESS = "1";
    process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS = "1";
    runtimeAbort = new AbortController();
    runtimePromise = (async () => {
      const { bootElizaRuntime } = await import("@elizaos/agent/runtime/eliza.ts");
      return bootElizaRuntime({
        requireConfig: false,
        abortSignal: runtimeAbort.signal,
      });
    })();
  }
  return runtimePromise;
}

async function handleSessionPrompt(
  output: NodeJS.WritableStream,
  session: SessionState,
  params: Record<string, unknown> | undefined,
  requestId: string | number | null | undefined,
): Promise<void> {
  const sessionId = session.sessionId;
  const promptText = extractPromptText(params);
  const promptAbort = new AbortController();
  sessionPromptAbort.set(sessionId, promptAbort);

  try {
    if (process.env.ELIZA_ACP_LIGHT?.trim() === "1") {
      const delayMs = Number.parseInt(
        process.env.ELIZA_ACP_TEST_PROMPT_DELAY_MS ?? "0",
        10,
      );
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          promptAbort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      promptAbort.signal.throwIfAborted();
      const text = lightModeAck(promptText);
      notifySessionUpdate(output, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
      writeLine(output, {
        jsonrpc: "2.0",
        id: requestId,
        result: { stopReason: "end_turn" },
      });
      return;
    }

    const runtime = await ensureRuntime();
    const task: BenchmarkTask = {
      id: `acp-${sessionId}-${crypto.randomUUID()}`,
      prompt: promptText,
    };

    let streamedAny = false;
    const streamChunk = async (chunk: string) => {
      if (!chunk) return;
      streamedAny = true;
      notifySessionUpdate(output, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      });
    };

    const result = await runBenchmarkTaskWithStreaming(
      runtime,
      task,
      promptAbort.signal,
      streamChunk,
    );

    if (!streamedAny && result.response.trim()) {
      notifySessionUpdate(output, sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: result.response },
      });
    }

    writeLine(output, {
      jsonrpc: "2.0",
      id: requestId,
      result: { stopReason: "end_turn" },
    });
  } catch (err) {
    if (promptAbort.signal.aborted) {
      writeLine(output, {
        jsonrpc: "2.0",
        id: requestId,
        result: { stopReason: "cancelled" },
      });
      return;
    }
    writeLine(output, {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  } finally {
    sessionPromptAbort.delete(sessionId);
  }
}

async function runBenchmarkTaskWithStreaming(
  runtime: AgentRuntime,
  task: BenchmarkTask,
  abortSignal: AbortSignal,
  onChunk: (chunk: string) => Promise<void>,
): Promise<{ response: string; success: boolean }> {
  const cryptoMod = await import("node:crypto");
  const core = await import("@elizaos/core");
  const {
    ChannelType,
    createMessageMemory,
    PI_CODING_ACTION_PROFILE,
    stringToUuid,
  } = core;
  type UUID = import("@elizaos/core").UUID;

  const userId = cryptoMod.randomUUID() as UUID;
  const roomId = stringToUuid(`benchmark-${task.id}`);
  const worldId = stringToUuid(`benchmark-world-${task.id}`);
  const messageServerId = stringToUuid(`benchmark-server-${task.id}`) as UUID;

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "ACP",
    source: "benchmark",
    channelId: `benchmark-${task.id}`,
    type: ChannelType.DM,
    messageServerId,
    metadata: { ownership: { ownerId: userId } },
  });

  const message = createMessageMemory({
    id: cryptoMod.randomUUID() as UUID,
    entityId: userId,
    roomId,
    content: {
      text: task.prompt,
      source: "benchmark",
      channelType: ChannelType.DM,
    },
  });

  if (!runtime.messageService) {
    return {
      response: "",
      success: false,
    };
  }

  let callbackText = "";
  let streamText = "";
  const result = await runtime.messageService.handleMessage(
    runtime,
    message,
    async (content) => {
      if (content.text) callbackText += content.text;
      return [];
    },
    {
      abortSignal,
      onStreamChunk: async (chunk: string) => {
        if (chunk) {
          streamText += chunk;
          await onChunk(chunk);
        }
      },
      codingMode: /\b(implement|build|create|write|code)\b/i.test(task.prompt),
      codingActionProfile: PI_CODING_ACTION_PROFILE,
    },
  );

  const joined = result.responseMessages
    .map((m) => m.content?.text ?? "")
    .join("\n");
  const responseText =
    result.responseContent?.text?.trim() ||
    joined.trim() ||
    streamText ||
    callbackText;

  // Buzz turns often publish via MCP tools with little/no streamed text.
  const success =
    result.outcome.status !== "failed" && result.requestFulfilled !== false;

  return {
    response: responseText,
    success,
  };
}

export async function runElizaAcpServer(
  opts: RunElizaAcpServerOptions = {},
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const sessions = new Map<string, SessionState>();
  let sessionCounter = 0;

  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue;
    }

    const { id, method, params } = msg;
    if (typeof method !== "string") continue;
    const paramRecord = isRecord(params) ? params : undefined;

    switch (method) {
      case "initialize": {
        const protocolVersion = negotiatedProtocolVersion(paramRecord);
        writeLine(output, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            agentCapabilities: {
              promptCapabilities: { image: false },
            },
            agentInfo: {
              name: AGENT_NAME,
              version: process.env.npm_package_version ?? "0.0.0",
            },
          },
        });
        break;
      }
      case "session/new": {
        sessionCounter += 1;
        const sessionId = `ses_${sessionCounter}_${crypto.randomUUID().slice(0, 8)}`;
        const mcpServers = parseMcpServers(paramRecord?.mcpServers);
        mergeSessionMcpIntoProcess(mcpServers);
        const session: SessionState = {
          sessionId,
          mcpServers,
          cwd:
            typeof paramRecord?.cwd === "string" ? paramRecord.cwd : undefined,
        };
        sessions.set(sessionId, session);
        writeLine(output, {
          jsonrpc: "2.0",
          id,
          result: { sessionId },
        });
        break;
      }
      case "session/prompt": {
        const sessionId =
          typeof paramRecord?.sessionId === "string"
            ? paramRecord.sessionId
            : "";
        const session = sessions.get(sessionId);
        if (!session) {
          writeLine(output, {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Unknown sessionId" },
          });
          break;
        }
        void handleSessionPrompt(output, session, paramRecord, id);
        break;
      }
      case "session/cancel": {
        const sessionId =
          typeof paramRecord?.sessionId === "string"
            ? paramRecord.sessionId
            : "";
        sessionPromptAbort.get(sessionId)?.abort();
        if (id !== undefined) {
          writeLine(output, {
            jsonrpc: "2.0",
            id,
            result: {},
          });
        }
        break;
      }
      default:
        if (id !== undefined) {
          writeLine(output, {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
        }
    }
  }
}
