/** One owner-checked, read-only adapter for the standard MESSAGE/INBOX tools. */
import { createHash } from "node:crypto";
import {
  buildContentReference,
  buildReadSlice,
  buildReadView,
  ElizaError,
  hasRoleAccess,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import {
  BaseMessageAdapter,
  type ListOptions,
  type MessageRef,
  type ReadMessageRequest,
  type ReadMessageResult,
  type SearchMessagesFilters,
} from "@elizaos/plugin-assistant";
import {
  managedGmailMessageReader,
  managedGmailReadFetcher,
} from "./managed-gmail-read.ts";

const unavailable = (message: string) =>
  new ElizaError(message, { code: "MANAGED_GMAIL_READ_UNAVAILABLE" });
async function owner(runtime: IAgentRuntime, requester?: Memory) {
  if (!requester)
    throw unavailable("Gmail reads require a current owner request.");
  if (
    (requester.agentId && requester.agentId !== runtime.agentId) ||
    !(await hasRoleAccess(runtime, requester, "OWNER"))
  )
    throw unavailable("Gmail is restricted to its owner.");
  return requester;
}
export class ManagedGmailReadAdapter extends BaseMessageAdapter {
  readonly source = "gmail" as const;
  readonly cachePolicy = "none" as const;
  private readonly fetcher = managedGmailReadFetcher();
  private readonly reader = managedGmailMessageReader();
  isAvailable() {
    return Boolean(this.fetcher && this.reader);
  }
  capabilities() {
    return {
      list: true,
      search: true,
      manage: {},
      send: {},
      worlds: "single" as const,
      channels: "none" as const,
    };
  }
  private async messages(
    runtime: IAgentRuntime,
    opts: ListOptions,
    query?: string,
  ) {
    await owner(runtime, opts.requester);
    if (!this.fetcher)
      throw unavailable("The owner Gmail host is unavailable.");
    if (
      opts.worldIds?.some((id) => id !== "default") ||
      opts.channelIds?.length
    )
      throw unavailable(
        "Use a Gmail query for this source; account and channel ids cannot override its owner.",
      );
    const parts = [query || "in:inbox"];
    if (opts.unreadOnly) parts.push("is:unread");
    if (opts.sinceMs !== undefined && !Number.isFinite(opts.sinceMs))
      throw unavailable("Invalid Gmail date.");
    const rows = await this.fetcher({
      runtime,
      limit: opts.limit,
      query: parts.join(" "),
      requester: opts.requester,
      ...(opts.sinceMs === undefined
        ? {}
        : { since: new Date(opts.sinceMs).toISOString() }),
    });
    await owner(runtime, opts.requester);
    return rows.map(
      (row): MessageRef => ({
        id: row.id,
        source: "gmail",
        externalId: row.id,
        from: { identifier: row.senderName, displayName: row.senderName },
        to: [],
        subject: row.threadTopic,
        snippet: row.snippet,
        receivedAtMs: Date.parse(row.receivedAt),
        hasAttachments: false,
        isRead: row.unread === false,
        worldId: "default",
      }),
    );
  }
  protected listMessagesImpl(runtime: IAgentRuntime, opts: ListOptions) {
    return this.messages(runtime, opts);
  }
  protected searchMessagesImpl(
    runtime: IAgentRuntime,
    filters: SearchMessagesFilters,
  ) {
    if (filters.tags?.length || filters.untilMs !== undefined || filters.sender)
      throw unavailable(
        "Use a Gmail query for sender, label, or date-range filters.",
      );
    return this.messages(runtime, filters, filters.content);
  }
  protected async readMessageImpl(
    runtime: IAgentRuntime,
    request: ReadMessageRequest,
  ): Promise<ReadMessageResult> {
    const caller = await owner(runtime, request.requester);
    if (
      request.requesterEntityId !== caller.entityId ||
      request.requesterRoomId !== caller.roomId
    )
      throw unavailable("Gmail read requester changed.");
    if ((request.unit ?? "byte") !== "byte" || (request.offset ?? 0) !== 0)
      throw unavailable(
        "This host supports complete byte reads. Read the exact message from offset zero.",
      );
    const id = request.messageId ?? request.reference;
    if (!id)
      throw unavailable("Select a Gmail message from the current inbox.");
    if (!this.reader) throw unavailable("The owner Gmail host is unavailable.");
    const result = await this.reader(id);
    await owner(runtime, request.requester);
    const text = result.bodyText,
      bytes = Buffer.byteLength(text),
      revision = createHash("sha256").update(text).digest("hex");
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        bytes > request.limit)
    )
      throw unavailable(
        `This message needs a complete read budget of ${bytes} bytes. No partial text was returned.`,
      );
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== revision
    )
      throw unavailable(
        "Gmail message text changed. Read it again before continuing.",
      );
    return {
      text,
      readView: buildReadView({
        reference: buildContentReference({
          kind: "email",
          ref: id,
          revision,
          resumability: "restart-safe",
        }),
        slice: buildReadSlice({
          range: { unit: "byte", start: 0, end: bytes, total: bytes },
          completeness: "complete",
          revision,
          sliceSha256: revision,
          sourceSha256: revision,
        }),
      }),
      sourceWork: {
        headReads: 0,
        segmentRows: 0,
        providerRevisionReads: 0,
        providerBodyFetches: 1,
      },
    };
  }
}
