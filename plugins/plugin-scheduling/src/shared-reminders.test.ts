/** Exercise Shared reminder argument admission against the real in-memory runner. */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { expect, it } from "vitest";
import { ScheduledTaskRunnerService } from "./scheduled-task/runner-service.ts";
import type { ScheduledTask } from "./scheduled-task/types.ts";
import { createSharedRemindersEdgeAction } from "./shared-reminders.ts";

it("refuses invalid recurrence before writes and retains the stored timezone on update", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const runtime = {
    agentId,
    getService: () => null,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
  const service = await ScheduledTaskRunnerService.start(runtime);
  const now = () => new Date("2026-10-11T12:00:00Z");
  const runner = service.getRunner({ agentId, now });
  const action = createSharedRemindersEdgeAction({
    runner,
    agentId,
    now,
    delivery: {
      platform: "telegram",
      project: "test",
      connectorAccountId: "owner",
      chatId: "123456",
    },
  });
  const run = (parameters: HandlerOptions["parameters"]) =>
    action.handler(
      runtime,
      {
        id: crypto.randomUUID(),
        entityId: agentId,
        agentId,
        roomId: agentId,
        content: { text: "Set my reminder", source: "test" },
      } as Memory,
      undefined,
      { parameters },
    );
  try {
    for (const timing of [
      { everyMinutes: 1.5 },
      { cronExpression: "not a cron", timezone: "Asia/Tokyo" },
      { cronExpression: "0 9 30 2 *", timezone: "Asia/Tokyo" },
    ]) {
      const result = await run({
        operation: "create",
        reminderText: "Take a walk",
        ...timing,
      });
      expect(result?.success, JSON.stringify(result)).toBe(false);
      expect(await runner.list()).toHaveLength(0);
    }
    const created = await run({
      operation: "create",
      reminderText: "Take a walk",
      cronExpression: "0 9 * * *",
      timezone: "Asia/Tokyo",
    });
    expect(created?.success, JSON.stringify(created)).toBe(true);
    const task = created?.data?.task as ScheduledTask;
    const updated = await run({
      operation: "update",
      taskId: task.taskId,
      cronExpression: "0 10 * * *",
    });
    expect(updated?.success, JSON.stringify(updated)).toBe(true);
    const replacement = updated?.data?.task as ScheduledTask;
    const stored = (await runner.list()).find(
      (entry) => entry.taskId === replacement.taskId,
    );
    expect(stored?.trigger).toMatchObject({
      kind: "cron",
      expression: "0 10 * * *",
      tz: "Asia/Tokyo",
    });
  } finally {
    await service.stop();
  }
});
