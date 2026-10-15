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
host. The owner-gated INBOX list/search/summarize path uses this source.
`INBOX_READ` reads the provider text for an exact message id returned by that
source; the broker must verify that id belongs to the current owner and grant.
It does not enable send, drafts, or mailbox changes. Without the setting the
existing connector path is unchanged. Android hosts must supply their own
qualified broker; a browser host test does not qualify Android.
