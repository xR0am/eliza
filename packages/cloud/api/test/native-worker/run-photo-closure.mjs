/** Consume the single normal production dry-run immediately preceding this command.
 * Source hashes identify inputs; they alone are not build provenance.
 * Startup profiling is local: it does not validate production services or tenants.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const api = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(api, "../../..");
const output = resolve(api, ".wrangler-dry-run");
const modulePath = resolve(output, "index.js");
const bundlePath = resolve(output, "worker.bundle");
const profilePath = resolve(output, "startup.cpuprofile");
const nativeTest = "test/native-worker/network-photo-closure.native.test.ts";
const gatewayTests = [
  "approved-relay-photos.test.ts",
  "approved-photo-delivery.integration.test.ts",
  "internal-delivery-replay.test.ts",
  "blooio-adapter.test.ts",
].map((name) => `packages/cloud/services/gateway-webhook/__tests__/${name}`);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
async function artifact(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size === 0)
    throw new Error("Expected a nonempty regular normal-producer artifact");
  const bytes = await readFile(path);
  return {
    bytes,
    proof: {
      sha256: hash(bytes),
      bytes: bytes.length,
      modifiedAt: info.mtime.toISOString(),
    },
  };
}

const reviewedFiles = [
  ...new Set([
    "packages/cloud/api/internal/network/deliver/route.ts",
    "packages/cloud/api/package.json",
    "packages/cloud/api/src/shared-runtime-conversation.ts",
    "packages/cloud/api/test/native-worker/network-photo-closure.native.test.ts",
    "packages/cloud/api/test/native-worker/run-photo-closure.mjs",
    "packages/cloud/shared/src/db/schemas/shared-runtime-history.ts",
    "packages/cloud/shared/src/lib/services/shared-runtime/approved-photo-admission.test.ts",
    "packages/cloud/shared/src/lib/services/shared-runtime/conversation-coordinator.ts",
    "packages/cloud/shared/src/lib/services/shared-runtime/network-shared-admission.ts",
    "packages/cloud/shared/src/lib/services/shared-runtime/run-shared-agent-turn.ts",
    "packages/cloud/services/gateway-webhook/src/internal-delivery.ts",
    "packages/cloud/services/gateway-webhook/src/approved-relay-photos.ts",
    ...gatewayTests,
    "packages/cloud/api/wrangler.toml",
    "packages/cloud/api/src/index.ts",
    "plugins/plugin-network/src/backend/contract.ts",
    "plugins/plugin-network/src/backend/svc-auth.ts",
  ]),
];
let sourceProvenance;
async function provenance() {
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  const paths = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  const untracked = paths("ls-files", "--others", "--exclude-standard", "-z");
  const sourceConfigCount = untracked.filter(
    (path) =>
      /^(?:packages|plugins|\.github)\//.test(path) &&
      /\.(?:[cm]?[jt]sx?|jsonc?|toml|ya?ml|sql)$/.test(path),
  ).length;
  const expectedInputHashes = Object.fromEntries(
    reviewedFiles.map((file) => [
      file,
      hash(execFileSync("git", ["-C", repo, "show", `HEAD:${file}`])),
    ]),
  );
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: status.length !== 0,
    status,
    trackedDirtyPaths: paths("diff", "--name-only", "-z", "HEAD"),
    trackedDiffSHA256: hash(
      execFileSync("git", ["-C", repo, "diff", "--binary", "HEAD"]),
    ),
    untrackedCounts: {
      total: untracked.length,
      sourceOrConfig: sourceConfigCount,
      other: untracked.length - sourceConfigCount,
    },
    expectedInputHashes,
    limitation:
      "Observed after the owning dry-run; reviewed file bytes are checked against HEAD. Other dirty/generated inputs are reported and this is not a clean whole-source build attestation.",
  };
}
async function verifyReviewedInputs() {
  sourceProvenance.inputHashes = Object.fromEntries(
    await Promise.all(
      reviewedFiles.map(async (file) => {
        const path = resolve(repo, file),
          info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Reviewed input is not a regular source file");
        return [file, hash(await readFile(path))];
      }),
    ),
  );
  sourceProvenance.mismatchedInputPaths = reviewedFiles.filter(
    (file) =>
      sourceProvenance.inputHashes[file] !==
      sourceProvenance.expectedInputHashes[file],
  );
  sourceProvenance.reviewedInputsMatchHEAD =
    sourceProvenance.mismatchedInputPaths.length === 0 &&
    git("rev-parse", "HEAD") === sourceProvenance.commit;
  if (!sourceProvenance.reviewedInputsMatchHEAD)
    throw new Error("Reviewed source input differs from HEAD");
}

try {
  sourceProvenance = await provenance();
  await verifyReviewedInputs();
  // Normal src/index.ts produces index.js. No injected path or stale QA fallback.
  const entries = (await readdir(output)).filter((name) =>
    /^index\.(?:js|mjs|cjs)$/.test(name),
  );
  if (entries.length !== 1 || entries[0] !== "index.js")
    throw new Error("Missing or ambiguous normal Wrangler index.js entry");
  const module = await artifact(modulePath);
  const bundle = await artifact(bundlePath);
  // check startup --worker consumes Wrangler's multipart upload bundle, not JS.
  // Verify that its actual main-module bytes are the same bytes tested below.
  const firstLine = bundle.bytes.indexOf(10);
  if (firstLine < 3 || firstLine > 200)
    throw new Error("Invalid multipart Worker boundary");
  const boundary = bundle.bytes.subarray(2, firstLine).toString().trim();
  const parts = await new Response(bundle.bytes, {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  const metadata = parts.get("metadata");
  if (typeof metadata !== "string")
    throw new Error("Missing Worker upload metadata");
  const mainName = JSON.parse(metadata).main_module;
  if (typeof mainName !== "string")
    throw new Error("Missing Worker main-module identity");
  const mainPart = parts.get(mainName);
  if (
    !(mainPart instanceof Blob) ||
    hash(new Uint8Array(await mainPart.arrayBuffer())) !== module.proof.sha256
  )
    throw new Error(
      "Multipart main module differs from the normal index.js artifact",
    );
  const receipt = {
    state: "QUALIFICATION_RUNNING",
    source: sourceProvenance,
    module: module.proof,
    multipart: bundle.proof,
    mainModule: mainName,
    scope: {
      builds: 1,
      sharedStorageCases: 5,
      linkedNormalClassExports: 9,
      declaredNormalDONamespaceBindings: 8,
      gateway:
        "Real source paths with controlled HTTP/Redis transport; no real provider delivery.",
      startup:
        "Local module import/profile only; production namespace, database and service bindings are not qualified here.",
      limits:
        "No all-class operations, production namespace ownership, PG/provider access, item-policy approval or real-user photo acceptance.",
    },
    results: {},
  };
  const receiptPath = resolve(output, "native-photo-qualification.json");
  const save = () =>
    writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  function run(stage, args, cwd, env = process.env) {
    const result = spawnSync("bun", args, { cwd, stdio: "inherit", env });
    receipt.results[stage] = { exitCode: result.status, signal: result.signal };
    if (result.error) receipt.results[stage].error = result.error.message;
    if (result.error || result.status !== 0)
      throw new Error(`${stage} qualification failed`);
  }
  try {
    await save();
    await verifyReviewedInputs();
    run(
      "native",
      [
        "test",
        "--config=/dev/null",
        "--isolate",
        nativeTest,
        "--timeout",
        "60000",
      ],
      api,
      {
        ...process.env,
        ELIZA_QA_WORKER_MODULE: modulePath,
        ELIZA_QA_WORKER_SHA256: module.proof.sha256,
      },
    );
    await verifyReviewedInputs();
    run(
      "gateway",
      [
        "test",
        "--config=/dev/null",
        "--isolate",
        ...gatewayTests,
        "--timeout",
        "60000",
      ],
      repo,
    );
    await verifyReviewedInputs();
    run(
      "startup",
      [
        "x",
        "--no-install",
        "wrangler",
        "check",
        "startup",
        "--worker",
        bundlePath,
        "--outfile",
        profilePath,
        "--config",
        "wrangler.toml",
        "--env",
        "production",
      ],
      api,
      {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_API_KEY: "",
        CLOUDFLARE_EMAIL: "",
        WRANGLER_SEND_METRICS: "false",
      },
    );
    receipt.startupProfile = (await artifact(profilePath)).proof;
    if (
      (await artifact(modulePath)).proof.sha256 !== module.proof.sha256 ||
      (await artifact(bundlePath)).proof.sha256 !== bundle.proof.sha256
    )
      throw new Error(
        "Qualified Worker artifacts changed during qualification",
      );
    receipt.state = "QUALIFICATION_PASSED";
  } catch (error) {
    receipt.state = "QUALIFICATION_FAILED";
    receipt.error = error.message;
    process.exitCode = 1;
  } finally {
    await save();
    // Public identity proof survives normal CI log retention. Never print bindings,
    // environment values, tokens, message bodies or the multipart metadata.
    console.log(
      JSON.stringify({
        kind: "network-photo-qualification",
        state: receipt.state,
        sourceCommit: receipt.source.commit,
        sourceTree: receipt.source.tree,
        dirty: receipt.source.dirty,
        trackedDirtyPaths: receipt.source.trackedDirtyPaths,
        trackedDiffSHA256: receipt.source.trackedDiffSHA256,
        untrackedCounts: receipt.source.untrackedCounts,
        reviewedInputsMatchHEAD: receipt.source.reviewedInputsMatchHEAD,
        inputHashes: receipt.source.inputHashes,
        mismatchedInputPaths: receipt.source.mismatchedInputPaths,
        sourceLimitation: receipt.source.limitation,
        moduleSHA256: receipt.module.sha256,
        multipartSHA256: receipt.multipart.sha256,
        startupProfileSHA256: receipt.startupProfile?.sha256 ?? null,
        results: receipt.results,
        scope: receipt.scope,
      }),
    );
  }
} catch (error) {
  let sourceCommit = null,
    sourceTree = null;
  try {
    sourceCommit = git("rev-parse", "HEAD");
    sourceTree = git("rev-parse", "HEAD^{tree}");
  } catch {}
  console.log(
    JSON.stringify({
      kind: "network-photo-qualification",
      state: "QUALIFICATION_PREFLIGHT_FAILED",
      sourceCommit,
      sourceTree,
      trackedDirtyPaths: sourceProvenance?.trackedDirtyPaths ?? [],
      trackedDiffSHA256: sourceProvenance?.trackedDiffSHA256 ?? null,
      untrackedCounts: sourceProvenance?.untrackedCounts ?? null,
      reviewedInputsMatchHEAD:
        sourceProvenance?.reviewedInputsMatchHEAD ?? false,
      inputHashes: sourceProvenance?.inputHashes ?? {},
      mismatchedInputPaths: sourceProvenance?.mismatchedInputPaths ?? [],
      moduleSHA256: null,
      multipartSHA256: null,
      results: {},
      errorType: error.name,
    }),
  );
  process.exitCode = 1;
}
