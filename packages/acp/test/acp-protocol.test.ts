import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runElizaAcpServer } from "../src/server/acp-server.ts";

function writeJson(lineStream: PassThrough, obj: Record<string, unknown>): void {
  lineStream.write(`${JSON.stringify(obj)}\n`);
}

async function readJsonLines(
  stream: PassThrough,
  count: number,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${count} JSON lines`));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          lines.push(JSON.parse(line) as Record<string, unknown>);
          if (lines.length >= count) {
            clearTimeout(timer);
            stream.off("data", onData);
            resolve(lines);
            return;
          }
        }
        idx = buffer.indexOf("\n");
      }
    };
    stream.on("data", onData);
  });
}

describe("eliza ACP protocol (light mode)", () => {
  it("initialize, session/new, and session/prompt", async () => {
    process.env.ELIZA_ACP_LIGHT = "1";
    const input = new PassThrough();
    const output = new PassThrough();

    const serverDone = runElizaAcpServer({ input, output });

    writeJson(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 2, clientCapabilities: {} },
    });

    const initLines = await readJsonLines(output, 1);
    expect(initLines[0]?.result).toMatchObject({
      protocolVersion: 2,
      agentInfo: { name: "eliza-acp" },
    });

    writeJson(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        cwd: "/tmp",
        mcpServers: [
          { name: "buzz-dev-mcp", command: "buzz-dev-mcp", args: [] },
        ],
      },
    });

    const newLines = await readJsonLines(output, 1);
    const sessionId = (newLines[0]?.result as { sessionId?: string })
      ?.sessionId;
    expect(sessionId).toMatch(/^ses_/);
    expect(process.env.ELIZA_ACP_SESSION_MCP).toContain("buzz-dev-mcp");

    writeJson(input, {
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "hello harness" }],
      },
    });

    const promptLines = await readJsonLines(output, 2);
    const update = promptLines.find((l) => l.method === "session/update");
    expect(update?.params).toMatchObject({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: expect.stringMatching(/^ELIZA-ACP-LIGHT:/) },
      },
    });
    const result = promptLines.find((l) => l.id === 3);
    expect(result?.result).toEqual({ stopReason: "end_turn" });

    input.end();
    await serverDone;
  });
});
