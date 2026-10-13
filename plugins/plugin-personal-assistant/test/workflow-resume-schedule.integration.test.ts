/**
 * A paused scheduled workflow that is resumed days later runs at its next
 * slot after the resume, not once for every slot missed while paused.
 */
import { TaskService } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-13T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

it("a resumed workflow runs at its next slot after the resume, not for every slot missed while paused", async () => {
  const f = await createLifeOpsTestRuntime();
  await TaskService.stop(f.runtime);
  // The run claim needs the idempotency index that production creates at
  // bootstrap; await it here so the first run does not race it.
  await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(f.runtime);
  vi.spyOn(f.runtime, "useModel").mockRejectedValue(
    new Error("No inference expected"),
  );
  try {
    const service = new LifeOpsService(f.runtime);
    const created = await service.createWorkflow({
      title: "Daily task minting workflow",
      triggerType: "schedule",
      schedule: { kind: "interval", everyMinutes: 24 * 60, timezone: "UTC" },
      actionPlan: {
        steps: [
          {
            kind: "create_task",
            request: {
              title: "Minted by workflow",
              kind: "task",
              cadence: { kind: "unscheduled" },
              timezone: "UTC",
            },
          },
        ],
      },
    });
    const workflowId = created.definition.id;
    const mintedTasks = async () =>
      (await service.listDefinitions()).filter(
        (record) => record.definition.title === "Minted by workflow",
      );

    await service.updateWorkflow(workflowId, { status: "paused" });
    for (let day = 1; day <= 10; day += 1) {
      vi.setSystemTime(T0 + day * DAY_MS);
      expect(
        await service.runDueWorkflows({
          now: new Date().toISOString(),
          limit: 12,
        }),
      ).toHaveLength(0);
    }

    const resumedAt = T0 + 10 * DAY_MS + 30 * 60_000;
    vi.setSystemTime(resumedAt);
    await service.updateWorkflow(workflowId, { status: "active" });

    // The slots missed while paused do not run.
    expect(
      await service.runDueWorkflows({
        now: new Date().toISOString(),
        limit: 12,
      }),
    ).toHaveLength(0);
    expect(await mintedTasks()).toHaveLength(0);

    // The next slot after the resume runs once.
    vi.setSystemTime(resumedAt + DAY_MS + 60_000);
    const runs = await service.runDueWorkflows({
      now: new Date().toISOString(),
      limit: 12,
    });
    expect(runs.map((run) => run.startedAt)).toEqual([
      new Date(resumedAt + DAY_MS).toISOString(),
    ]);
    expect(await mintedTasks()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
}, 180_000);

it("a one-shot workflow that already ran does not run again after a pause and resume", async () => {
  const f = await createLifeOpsTestRuntime();
  await TaskService.stop(f.runtime);
  // The run claim needs the idempotency index that production creates at
  // bootstrap; await it here so the first run does not race it.
  await LifeOpsRepository.ensureWorkflowRunIdempotencyKey(f.runtime);
  vi.spyOn(f.runtime, "useModel").mockRejectedValue(
    new Error("No inference expected"),
  );
  try {
    const service = new LifeOpsService(f.runtime);
    const runAt = new Date(T0 + 60 * 60_000).toISOString();
    const created = await service.createWorkflow({
      title: "One-shot task minting workflow",
      triggerType: "schedule",
      schedule: { kind: "once", runAt, timezone: "UTC" },
      actionPlan: {
        steps: [
          {
            kind: "create_task",
            request: {
              title: "Minted once",
              kind: "task",
              cadence: { kind: "unscheduled" },
              timezone: "UTC",
            },
          },
        ],
      },
    });
    const workflowId = created.definition.id;
    const mintedTasks = async () =>
      (await service.listDefinitions()).filter(
        (record) => record.definition.title === "Minted once",
      );

    vi.setSystemTime(T0 + 61 * 60_000);
    const runs = await service.runDueWorkflows({
      now: new Date().toISOString(),
      limit: 12,
    });
    expect(runs.map((run) => run.startedAt)).toEqual([runAt]);
    expect(await mintedTasks()).toHaveLength(1);

    await service.updateWorkflow(workflowId, { status: "paused" });
    vi.setSystemTime(T0 + 10 * DAY_MS);
    await service.updateWorkflow(workflowId, { status: "active" });
    expect(
      await service.runDueWorkflows({
        now: new Date().toISOString(),
        limit: 12,
      }),
    ).toHaveLength(0);
    expect(await mintedTasks()).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
}, 180_000);
