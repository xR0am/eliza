import type { IAgentRuntime } from "@elizaos/core";
import type {
  GateDecision,
  ScheduledTask,
  TaskGateContribution,
} from "@elizaos/plugin-scheduling";
import { createWorkThreadStore } from "./store.js";

export const WORK_THREAD_ACTIVE_GATE = "work_thread_active";

/**
 * A work-thread follow-up fires only while its thread still runs. The thread
 * row is the owner's durable intent; the task row is derived from it. A task
 * that outlives a stopped or completed thread (its removal failed, or raced a
 * concurrent writer) must not notify the owner.
 */
export function registerWorkThreadActiveGate(
  runtime: IAgentRuntime,
  registry: { register(c: TaskGateContribution): void },
): void {
  registry.register({
    kind: WORK_THREAD_ACTIVE_GATE,
    async evaluate(task: ScheduledTask): Promise<GateDecision> {
      if (task.subject?.kind !== "thread") return { kind: "allow" };
      const thread = await createWorkThreadStore(runtime).get(task.subject.id);
      if (!thread) {
        return { kind: "deny", reason: "work thread no longer exists" };
      }
      if (thread.status === "stopped" || thread.status === "completed") {
        return { kind: "deny", reason: `work thread is ${thread.status}` };
      }
      return { kind: "allow" };
    },
  });
}
