# Buzz harness integration (BYOH)

Buzz can drive elizaOS agents through the **Agent Client Protocol (ACP)** over stdio, the same shape used by Hermes (`hermes-acp`) and Buzz Agent (`buzz-agent`).

## Commands

| Entry | Description |
| --- | --- |
| `eliza acp` | Main CLI (`@elizaos/app`) — starts the ACP server on stdin/stdout |
| `eliza-acp` | Bin from `@elizaos/acp` (same server) |
| `eliza-autonomous acp` | Autonomous agent package entry point |

Run from an eliza project directory with model credentials configured, or use test mode below.

## Protocol

- **Version:** ACP protocol v2 on `initialize` (`protocolVersion: 2`).
- **Agent identity:** `agentInfo.name` is `eliza-acp`.
- **Session:** `session/new` accepts `cwd` and `mcpServers` (Buzz passes `buzz-dev-mcp` as a stdio MCP server).
- **Turn:** `session/prompt` with `prompt: [{ "type": "text", "text": "..." }]`; the server emits `session/update` with `sessionUpdate: "agent_message_chunk"` and completes with `stopReason: "end_turn"`.
- **Cancel:** `session/cancel` aborts an in-flight prompt.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ELIZA_ACP_LIGHT=1` | Deterministic light server (no runtime boot). Used in CI/protocol tests. |
| `ELIZA_ACP_SKIP_CONNECTORS=1` | Harness profile: skip messaging connectors (set by default via `applyElizaAcpProfileEnv`). |
| `ELIZA_ACP_SESSION_MCP` | JSON array of MCP servers from the latest `session/new` (for tooling / future MCP client wiring). |
| `ELIZA_SKIP_PLUGINS` | Optional comma list; ACP profile pre-skips heavy channel plugins when unset. |

Other boot-related vars (`LOG_LEVEL`, `ELIZA_DISABLE_TELEMETRY`, `ELIZA_DISABLE_VAULT_PROFILE_RESOLVER`) are set to lean defaults when the ACP profile is applied.

## Buzz desktop harness JSON (example)

```json
{
  "id": "eliza",
  "label": "elizaOS",
  "command": "eliza-acp",
  "binary_path": "/path/to/eliza-acp",
  "install_hint": "Install elizaOS and run `eliza acp` or the `eliza-acp` binary.",
  "mcp_command": "buzz-dev-mcp",
  "availability": "available"
}
```

Buzz sends `mcpServers` on `session/new` so the harness MCP (`buzz-dev-mcp`) is available for tool use. Full MCP stdio client spawning from eliza is not required for harness handshake; servers are recorded in `ELIZA_ACP_SESSION_MCP` for downstream runtime integration.

## Development

```bash
# From repo root
bun install
ELIZA_ACP_LIGHT=1 bun --conditions=eliza-source packages/acp/src/bin.ts

# Protocol tests
cd packages/acp && bun test
```
