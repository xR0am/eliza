# @elizaos/plugin-inbox

Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and
follow-up watcher for Eliza agents.

Import the plugin, inbox services, connector fetchers, and shared types from
`@elizaos/plugin-inbox`. `InboxActionItem` is the action fan-out record;
`InboxItem` is the view record. Implementation modules are private.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-inbox build  # build
bun run --cwd plugins/plugin-inbox test   # tests
```

## Private host Gmail reads

A host can set `ELIZA_MANAGED_GMAIL_READ_BROKER` to its private loopback endpoint
`http://127.0.0.1:<port>/__alpha-owner-gmail`. The host must authenticate the
runtime's existing `ELIZA_API_TOKEN`, verify the current owner and Google read
grant, and return `{items: InboxActionItem[]}`. Provider credentials stay in the
host. The standard MESSAGE and INBOX tools use this read-only adapter.
Each read verifies the live owner action. Exact-message text reads use MESSAGE's
existing source identity and integrity contract. They support byte, line, and paragraph ranges with source digests and explicit
continuation metadata; the host does not silently shorten message text. Inbox
queries always revalidate the grant instead of returning an older account's cache.
It does not enable send, drafts, or mailbox changes. Without the setting the
existing connector path is unchanged. Android hosts must supply their own
qualified broker; a browser host test does not qualify Android.

## Private host mailbox changes

A host can separately set `ELIZA_MANAGED_GMAIL_OPERATION_BROKER` on the same
authenticated loopback endpoint. This enables the existing MESSAGE action for
archive, recoverable trash, and read/unread state. The adapter requires the verified
owner memory, including its turn ID. It derives the same operation ID when a turn
is replayed. The host must check the current Google mailbox grant, prepare the exact
message revision, dispatch at most once, and verify the provider receipt and labels.
An unknown receipt must not be dispatched again. Labels, spam and unsubscribe are
not enabled by this setting. Native hosts need their own qualified implementation.
