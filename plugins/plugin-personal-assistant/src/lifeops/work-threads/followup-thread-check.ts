import type { IAgentRuntime } from "@elizaos/core";
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import { createWorkThreadStore } from "./store.js";

/**
 * A work-thread follow-up fires only while its thread still runs. The thread
 * row is the owner's durable intent; the task row is derived from it. The
 * scheduler tick reads this before it fires any thread follow-up, so a task
 * that outlives a stopped or completed thread (its removal failed, raced a
 * concurrent writer, or was created before this check existed) is dismissed
 * instead of notifying the owner.
 *
 * Returns the reason the follow-up must not fire, or null while it may.
 */
export async function workThreadFollowupInactiveReason(
  runtime: IAgentRuntime,
  task: Pick<ScheduledTask, "kind" | "subject">,
): Promise<string | null> {
  if (task.kind !== "followup" || task.subject?.kind !== "thread") return null;
  const thread = await createWorkThreadStore(runtime).get(task.subject.id);
  if (!thread) return "work thread no longer exists";
  if (thread.status === "stopped" || thread.status === "completed") {
    return `work thread is ${thread.status}`;
  }
  return null;
}
