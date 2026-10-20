/** Private, bounded pinned-CLI transport. No CLI entrypoint or automatic operation. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { OBSERVED_TEMPLATE } from "./pitr-reviewed-stage";
export const PITR_QUERIES = {
  backupList:
    "query BackupList($id: String!) { volumeInstanceBackupList(volumeInstanceId: $id) { id name createdAt expiresAt } }",
  backupCreate:
    "mutation BackupCreate($id: String!, $name: String!) { volumeInstanceBackupCreate(volumeInstanceId: $id, name: $name) { workflowId } }",
  workflowStatus:
    "query WorkflowStatus($id: String!) { workflowStatus(workflowId: $id) { status } }",
  stageTemplate:
    "mutation StageTemplate($input: TemplateDeployV2Input!) { templateDeployV2(input: $input) { projectId workflowId } }",
  environment:
    "query Environment($id: String!) { environment(id: $id) { id config(decryptVariables: false) } }",
  staged:
    "query Staged($id: String!) { environmentStagedChanges(environmentId: $id) { id status patch } }",
  template:
    'query Template { template(code: "postgres-pitr") { id serializedConfig } }',
} as const;
/** Caller must verify CLI5.38.0 and protected canonical source before constructing this transport. */
export function privatePitrApi(
  operation: keyof typeof PITR_QUERIES,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!Object.hasOwn(PITR_QUERIES, operation))
    return Promise.reject(Error("private_provider_configuration_missing"));
  let body: string;
  try {
    body = JSON.stringify(variables);
    if (typeof body !== "string" || Buffer.byteLength(body) > 4 * 1024 * 1024)
      throw Error("invalid_body");
    variables = JSON.parse(body);
    if (!variables || typeof variables !== "object" || Array.isArray(variables))
      throw Error("invalid_body");
  } catch {
    return Promise.reject(Error("private_provider_input_refused"));
  }
  const query = PITR_QUERIES[operation];
  if (operation === "stageTemplate") {
    const value = variables.input;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return Promise.reject(Error("private_stage_input_refused"));
    const input = value as Record<string, unknown>;
    let template: unknown;
    try {
      template =
        typeof input.serializedConfig === "string"
          ? JSON.parse(input.serializedConfig)
          : input.serializedConfig;
    } catch {
      return Promise.reject(Error("private_stage_input_refused"));
    }
    if (
      input.stageOnly !== true ||
      [
        "existingRootServiceId",
        "environmentId",
        "projectId",
        "workspaceId",
        "templateId",
      ].some(
        (key) => typeof input[key] !== "string" || input[key].length === 0,
      ) ||
      template === undefined ||
      createHash("sha256").update(JSON.stringify(template)).digest("hex") !==
        OBSERVED_TEMPLATE
    )
      return Promise.reject(Error("private_stage_input_refused"));
  }
  if (!query || !process.env.RAILWAY_TOKEN || signal?.aborted)
    return Promise.reject(Error("private_provider_configuration_missing"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "railway",
      ["api", query, "--variables", "@-", "--compact"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: {
          PATH: process.env.PATH,
          RAILWAY_TOKEN: process.env.RAILWAY_TOKEN,
          CI: "true",
          NO_COLOR: "1",
        },
      },
    );
    let done = false;
    let stopped = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (
      value?: unknown,
      error = false,
      cleanupUnconfirmed = false,
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (error)
        reject(
          Error(
            cleanupUnconfirmed
              ? "private_provider_cleanup_unconfirmed"
              : "private_provider_request_unconfirmed",
          ),
        );
      else resolve(value);
    };
    const stop = () => {
      if (done || stopped) return;
      stopped = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* process already exited */
        }
      }
      if (!child.pid) finish(undefined, true);
    };
    const timer = setTimeout(stop, 120000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        stop();
        return;
      }
      chunks.push(chunk);
    });
    // Never retain or forward provider stderr: it can include private request values.
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) stop();
    });
    child.on("error", () => finish(undefined, true));
    child.stdin.on("error", () => stop());
    child.on("close", async (code) => {
      const groupPresent = () => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      };
      const descendants = groupPresent();
      if (descendants) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Verify absence below. */
        }
        const deadline = Date.now() + 5000;
        while (groupPresent() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (groupPresent()) {
          finish(undefined, true, true);
          return;
        }
      }
      if (descendants) {
        finish(undefined, true);
        return;
      }
      if (code !== 0 || stopped) {
        finish(undefined, true);
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value.errors) finish(undefined, true);
        else finish(value);
      } catch {
        finish(undefined, true);
      }
    });
    child.stdin.end(body);
  });
}
