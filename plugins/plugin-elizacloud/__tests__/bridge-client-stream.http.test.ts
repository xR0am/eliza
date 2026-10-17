import http from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ElizaCloudClient } from "../src/cloud/bridge-client.js";

describe("ElizaCloudClient streaming over HTTP", () => {
  const servers = new Set<http.Server>();
  const sockets = new Set<Socket>();

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(
      [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
    servers.clear();
  });

  it("cancels a stalled response body when the caller aborts", async () => {
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write('event: ready\ndata: {"phase":"ready"}\n\n');
      // Keep the response open to model a bridge that stalls after headers.
    });
    servers.add(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }

    const controller = new AbortController();
    const client = new ElizaCloudClient(`http://127.0.0.1:${address.port}`, "test-key");
    const stream = client.sendMessageStream("agent-123", "hello", "room-123", "DM", {
      signal: controller.signal,
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "ready", data: { phase: "ready" } },
      done: false,
    });

    const waitingRead = stream.next();
    controller.abort();

    await expect(waitingRead).rejects.toMatchObject({ name: "AbortError" });
    expect(requestCount).toBe(1);
  });
});
