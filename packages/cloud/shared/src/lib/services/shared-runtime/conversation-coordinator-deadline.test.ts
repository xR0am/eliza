import { expect, spyOn, test } from "bun:test";
import { coordinateSharedBridge } from "./conversation-coordinator";

test("non-streaming inference survives the control deadline but control reads retain it", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const deadlines: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    deadlines.push(Number(delay));
    return realSetTimeout(callback, delay === 75_000 ? 100 : delay === 10_000 ? 5 : delay, ...args);
  }) as typeof setTimeout);
  const namespace = {
    getByName: () => ({
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        await Bun.sleep(20);
        init?.signal?.throwIfAborted();
        return Response.json({
          jsonrpc: "2.0",
          id: "late",
          result: { text: "late completed inference" },
        });
      },
    }),
  };
  const agent = { id: "agent-deadline", organization_id: "org-deadline" };
  const executionCtx = { waitUntil: (_promise: Promise<unknown>) => {} };
  try {
    const reply = await coordinateSharedBridge(
      agent,
      {
        jsonrpc: "2.0",
        id: "late",
        method: "message.send",
        params: { text: "hello" },
      },
      { namespace, executionCtx },
    );
    expect(reply.result?.text).toBe("late completed inference");
    expect(deadlines).toEqual([75_000]);
    await expect(
      coordinateSharedBridge(
        agent,
        { jsonrpc: "2.0", id: "control", method: "status.get" },
        { namespace, executionCtx },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(deadlines).toEqual([75_000, 10_000]);
  } finally {
    timer.mockRestore();
  }
});

test("non-streaming inference keeps caller cancellation and a finite turn deadline", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const deadlines: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    deadlines.push(Number(delay));
    return realSetTimeout(callback, delay === 75_000 ? 10 : delay, ...args);
  }) as typeof setTimeout);
  const signals: AbortSignal[] = [];
  const namespace = {
    getByName: () => ({
      fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected bounded caller-composed signal");
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    }),
  };
  const agent = { id: "agent-deadline", organization_id: "org-deadline" };
  const rpc = {
    jsonrpc: "2.0" as const,
    id: "bounded",
    method: "message.send",
    params: { text: "hello" },
  };
  const executionCtx = { waitUntil: (_promise: Promise<unknown>) => {} };
  try {
    const caller = new AbortController();
    const cancelled = coordinateSharedBridge(agent, rpc, {
      namespace,
      executionCtx,
      abortSignal: caller.signal,
    });
    caller.abort(new Error("owned caller cancellation"));
    await expect(cancelled).rejects.toThrow("owned caller cancellation");
    expect(signals[0].aborted).toBe(true);
    await expect(
      coordinateSharedBridge(agent, rpc, { namespace, executionCtx }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(signals[1].aborted).toBe(true);
    expect(deadlines).toEqual([75_000, 75_000]);
  } finally {
    timer.mockRestore();
  }
});
