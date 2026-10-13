import type { IAgentRuntime } from "@elizaos/core";
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import { createWorkThreadStore } from "./store.js";

/**
 * A work-thread follow-up fires only while its thread still runs. The thread
 * row is the owner's durable intent; the task row is derived from it. The
 * scheduler tick reads this before it fires any thread follow-up, so a task
 * that outlives a stopped or completed thread, or that a later follow-up
 * replaced (its removal failed, raced a concurrent writer, or it was created
 * before this check existed), is dismissed instead of notifying the owner.
 *
 * Returns the reason the follow-up must not fire, or null while it may.
 */
export async function workThreadFollowupInactiveReason(
  runtime: IAgentRuntime,
  task: Pick<ScheduledTask, "taskId" | "kind" | "subject">,
): Promise<string | null> {
  if (task.kind !== "followup" || task.subject?.kind !== "thread") return null;
  const thread = await createWorkThreadStore(runtime).get(task.subject.id);
  if (!thread) return "work thread no longer exists";
  if (thread.status === "stopped" || thread.status === "completed") {
    return `work thread is ${thread.status}`;
  }
  // The thread links exactly one current follow-up. A task that is not that
  // link was replaced (or never linked) and must not deliver beside it.
  if (thread.currentScheduledTaskId !== task.taskId) {
    return "work thread follow-up was replaced";
  }
  return null;
}
