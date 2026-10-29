/**
 * Applies environment defaults for the Buzz / harness ACP profile: lean boot,
 * no messaging connectors, and optional telemetry/vault shortcuts.
 *
 * Documented variables (see docs/integrations/buzz.md):
 * - `ELIZA_ACP_SKIP_CONNECTORS` — when `"1"`, signals harness mode (connectors off).
 * - `ELIZA_ACP_LIGHT` — test/light server; no runtime boot.
 * - `ELIZA_ACP_SESSION_MCP` — JSON array of MCP servers from the last `session/new`.
 */
export function applyElizaAcpProfileEnv(): void {
  if (process.env.ELIZA_ACP_SKIP_CONNECTORS === undefined) {
    process.env.ELIZA_ACP_SKIP_CONNECTORS = "1";
  }
  if (process.env.ELIZA_DISABLE_TELEMETRY === undefined) {
    process.env.ELIZA_DISABLE_TELEMETRY = "1";
  }
  if (process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER === undefined) {
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
  }
  if (process.env.LOG_LEVEL === undefined) {
    process.env.LOG_LEVEL = "error";
  }
  if (
    process.env.ELIZA_SKIP_PLUGINS === undefined &&
    process.env.ELIZA_ACP_SKIP_CONNECTORS === "1"
  ) {
    process.env.ELIZA_SKIP_PLUGINS =
      "discord,telegram,imessage,slack,whatsapp,line";
  }
}
