import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privatePitrApi } from "./pitr-private-api";

async function fakeCli(source: string, work: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pitr-api-fixture-"));
  const oldPath = process.env.PATH,
    oldToken = process.env.RAILWAY_TOKEN;
  try {
    const file = join(dir, "railway");
    writeFileSync(file, `#!/usr/bin/python3\n${source}\n`);
    chmodSync(file, 0o700);
    process.env.PATH = dir;
    process.env.RAILWAY_TOKEN = "synthetic-only";
    await work(dir);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldToken === undefined) delete process.env.RAILWAY_TOKEN;
    else process.env.RAILWAY_TOKEN = oldToken;
    rmSync(dir, { recursive: true, force: true });
  }
}
test("private CLI receives variables through stdin, never argv", async () => {
  await fakeCli(
    'import sys,json\nv=json.load(sys.stdin)\nassert "private-fixture" not in str(sys.argv)\nassert v["id"]=="private-fixture"\nprint(json.dumps({"data":{"workflowStatus":{"status":"Complete"}}}))',
    async () => {
      expect(
        await privatePitrApi("workflowStatus", { id: "private-fixture" }),
      ).toEqual({ data: { workflowStatus: { status: "Complete" } } });
    },
  );
});
test("private provider error and oversized output expose only finite error", async () => {
  for (const script of [
    'import sys\nprint("private-fixture-secret",file=sys.stderr)\nsys.exit(1)',
    'print("x"*5000000)',
  ])
    await fakeCli(script, async () => {
      await expect(privatePitrApi("template", {})).rejects.toThrow(
        "private_provider_request_unconfirmed",
      );
    });
});
test("aborted bounded request kills its owned child and rejects", async () => {
  await fakeCli("import time\ntime.sleep(30)", async () => {
    const abort = new AbortController();
    const promise = privatePitrApi("template", {}, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(promise).rejects.toThrow(
      "private_provider_request_unconfirmed",
    );
  });
});

test("stage transport cannot omit stageOnly or substitute an unreviewed template", async () => {
  await expect(
    privatePitrApi("stageTemplate", { input: { stageOnly: false } }),
  ).rejects.toThrow("private_stage_input_refused");
  await expect(
    privatePitrApi("stageTemplate", {
      input: {
        stageOnly: true,
        existingRootServiceId: "root",
        environmentId: "env",
        projectId: "project",
        workspaceId: "workspace",
        templateId: "template",
        serializedConfig: {},
      },
    }),
  ).rejects.toThrow("private_stage_input_refused");
});

test("serialization and inherited operation failures are finite and precede spawn", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await expect(privatePitrApi("template", circular)).rejects.toThrow(
    "private_provider_input_refused",
  );
  await expect(
    privatePitrApi("template", {
      toJSON() {
        throw Error("private-fixture-secret");
      },
    }),
  ).rejects.toThrow("private_provider_input_refused");
  await expect(
    privatePitrApi("template", { large: "x".repeat(5000000) }),
  ).rejects.toThrow("private_provider_input_refused");
  await expect(privatePitrApi("toString" as "template", {})).rejects.toThrow(
    "private_provider_configuration_missing",
  );
});
test("successful CLI exit with a surviving descendant is never reported successful", async () => {
  await fakeCli(
    'import os,time,json\nopen(__file__+".pgid","w").write(str(os.getpid()))\npid=os.fork()\nif pid==0:\n for fd in (0,1,2): os.close(fd)\n time.sleep(30)\nelse:\n print(json.dumps({"data":{}}))',
    async (dir) => {
      await expect(privatePitrApi("template", {})).rejects.toThrow(
        /private_provider_(request|cleanup)_unconfirmed/,
      );
      const pgid = Number(readFileSync(join(dir, "railway.pgid"), "utf8"));
      expect(() => process.kill(-pgid, 0)).toThrow();
    },
  );
}, 10000);
