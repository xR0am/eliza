import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

function clientReturning(body: unknown, status = 200): ElizaCloudClient {
  return new ElizaCloudClient({
    baseUrl: "http://cloud.test",
    apiKey: "api-key",
    fetchImpl: (async () =>
      Response.json(body, { status })) as unknown as typeof fetch,
  });
}

/** Exact body of `POST /api/v1/eliza/agents/:agentId/suspend`. */
const suspendBody = {
  success: true,
  created: true,
  alreadyInProgress: false,
  message: "Suspend job created. Poll the job endpoint for status.",
  data: {
    agentId: "agent-1",
    action: "suspend",
    jobId: "job-1",
    status: "pending",
    previousStatus: "running",
  },
};

/** Exact body of `POST /api/v1/eliza/agents` when the organization already had the agent. */
const reusedAgentBody = {
  success: true,
  created: false,
  data: {
    id: "agent-1",
    agentId: "agent-1",
    agentName: "Ops",
    status: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    executionTier: "shared",
  },
};

test("a lifecycle response carries the job id under data, as the routes send it", async () => {
  const response = await clientReturning(suspendBody, 202).suspendAgent(
    "agent-1",
  );

  const jobId: string | undefined = response.data.jobId;
  expect(jobId).toBe("job-1");
  expect(response.data.action).toBe("suspend");
  expect(response.created).toBe(true);
  expect(response.alreadyInProgress).toBe(false);
});

test("createAgent reports whether the agent was created or reused", async () => {
  const response = await clientReturning(reusedAgentBody).createAgent({
    agentName: "Ops",
  });

  const created: boolean = response.created;
  expect(created).toBe(false);
  expect(response.data?.id).toBe("agent-1");
  expect(response.data?.executionTier).toBe("shared");
});
