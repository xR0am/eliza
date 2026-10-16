/** Consume the normal production dry-run immediately preceding this command.
 * This receipt records source identity; a hash alone is not build provenance.
 * Five real SQLite DO cases exercise SharedRuntimeConversation, not every DO binding.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const api = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(api, "../../..");
const output = resolve(api, ".wrangler-dry-run");
const modulePath = resolve(output, "index.js");
const testPath = "test/native-worker/network-photo-closure.native.test.ts";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

// Wrangler's maintained main is src/index.ts, whose default output is index.js.
// Do not guess another entry, accept an injected module, or fall back to stale QA outputs.
const names = await readdir(output);
const entries = names.filter((name) => /^index\.(?:js|mjs|cjs)$/.test(name));
if (entries.length !== 1 || entries[0] !== "index.js")
  throw new Error("Missing or ambiguous normal Wrangler index.js entry");
const moduleStat = await lstat(modulePath);
if (moduleStat.isSymbolicLink() || !moduleStat.isFile() || moduleStat.size === 0)
  throw new Error("Normal Wrangler entry is not a nonempty file");
const moduleBytes = await readFile(modulePath);
const status = git("status", "--porcelain=v1", "--untracked-files=all");
const files = [
  "packages/cloud/api/wrangler.toml",
  "packages/cloud/api/package.json",
  "packages/cloud/api/src/index.ts",
  "plugins/plugin-network/src/backend/contract.ts",
  `packages/cloud/api/${testPath}`,
  "packages/cloud/api/test/native-worker/run-photo-closure.mjs",
];
const inputHashes = Object.fromEntries(await Promise.all(files.map(async (file) =>
  [file, hash(await readFile(resolve(repo, file)))],
)));
const receipt = {
  state: "NATIVE_TESTS_RUNNING",
  producer: "wrangler deploy --env production --dry-run --outdir .wrangler-dry-run",
  source: {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: status.length !== 0,
    status,
    trackedDiffSHA256: hash(execFileSync("git", ["-C", repo, "diff", "--binary", "HEAD"])),
    inputHashes,
    limitation: "Identity observed after the owning dry-run; dirty inputs are not a clean committed-source build attestation.",
  },
  artifact: { path: modulePath, bytes: moduleBytes.length, sha256: hash(moduleBytes), modifiedAt: moduleStat.mtime.toISOString() },
  scope: { cases: 5, durableObject: "SharedRuntimeConversation", allClassJoinsQualified: false },
};
const receiptPath = resolve(output, "native-photo-qualification.json");
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
const result = spawnSync("bun", ["test", "--config=/dev/null", "--isolate", testPath, "--timeout", "60000"], {
  cwd: api,
  stdio: "inherit",
  env: { ...process.env, ELIZA_QA_WORKER_MODULE: modulePath, ELIZA_QA_WORKER_SHA256: receipt.artifact.sha256 },
});
receipt.state = !result.error && result.status === 0 ? "NATIVE_TESTS_PASSED" : "NATIVE_TESTS_FAILED";
receipt.exitCode = result.status;
receipt.signal = result.signal;
if (result.error) receipt.error = result.error.message;
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
if (result.error) throw result.error;
process.exit(result.status === 0 ? 0 : 1);
