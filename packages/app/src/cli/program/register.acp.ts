/**
 * Registers the `acp` CLI command: stdio ACP v2 server for Buzz and harnesses.
 */
import type { Command } from "commander";

export function registerAcpCommand(program: Command) {
  program
    .command("acp")
    .description(
      "Run the eliza ACP server (stdio JSON-RPC) for Buzz harness parity",
    )
    .action(async () => {
      const { applyElizaAcpProfileEnv, runElizaAcpServer } = await import(
        "@elizaos/acp"
      );
      applyElizaAcpProfileEnv();
      await runElizaAcpServer();
    });
}
