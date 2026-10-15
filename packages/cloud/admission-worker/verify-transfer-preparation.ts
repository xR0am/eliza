/** Read-only source checks for the pending staging transfer; never invokes Cloudflare. */
import { readFile } from "node:fs/promises";

interface WorkerConfig {
  name?: string;
  main?: string;
  account_id?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: unknown[];
  migrations?: unknown[];
  durable_objects?: { bindings?: unknown[] };
  exports?: Record<string, Record<string, unknown>>;
  vars?: Record<string, unknown>;
  hyperdrive?: { binding: string; id: string }[];
  kv_namespaces?: { binding: string; id: string }[];
  env?: Record<string, WorkerConfig>;
}

function requireContract(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

const source = Bun.TOML.parse(
  await readFile(new URL("../api/wrangler.toml", import.meta.url), "utf8"),
) as WorkerConfig;
const target = Bun.TOML.parse(
  await readFile(new URL("./wrangler.toml", import.meta.url), "utf8"),
) as WorkerConfig;
const stage = source.env?.staging;
requireContract(stage?.name, "Source staging Worker must be declared");
requireContract(
  target.account_id === source.account_id,
  "Transfer account must match source",
);
requireContract(
  target.compatibility_date ===
    (stage.compatibility_date ?? source.compatibility_date),
  "Compatibility date drift",
);
requireContract(
  JSON.stringify(target.compatibility_flags) ===
    JSON.stringify(stage.compatibility_flags ?? source.compatibility_flags),
  "Compatibility flag drift",
);
requireContract(
  !target.migrations,
  "Declarative exports cannot mix with legacy migrations",
);
requireContract(
  target.workers_dev === false && target.preview_urls === false,
  "No public preview",
);
requireContract(
  !target.routes?.length,
  "Admission Worker must have no public routes",
);
requireContract(
  !target.durable_objects?.bindings?.length,
  "Pending transfer cannot self-bind",
);
const declaration = target.exports?.InferenceAdmissionGate;
requireContract(
  declaration?.type === "durable-object",
  "Missing admission export",
);
requireContract(
  declaration.state === "expecting-transfer",
  "Only pending transfer is prepared",
);
requireContract(
  declaration.transfer_from === stage.name,
  "Transfer source must be staging API",
);
requireContract(
  declaration.storage === "sqlite",
  "Storage backend must stay SQLite",
);
requireContract(
  source.exports?.InferenceAdmissionGate?.storage === "sqlite",
  "Source storage drift",
);
for (const [key, value] of Object.entries(target.vars ?? {})) {
  requireContract(
    stage.vars?.[key] === value,
    `Target variable differs from staging: ${key}`,
  );
}
requireContract(
  target.vars?.INFERENCE_FUNDED_BUDGET_ADMISSION ===
    stage.vars?.INFERENCE_FUNDED_BUDGET_ADMISSION,
  "Funded admission effective configuration must not change",
);
for (const binding of target.hyperdrive ?? []) {
  requireContract(
    stage.hyperdrive?.some(
      (item) => item.binding === binding.binding && item.id === binding.id,
    ),
    "Hyperdrive must reuse staging resource",
  );
}
for (const binding of target.kv_namespaces ?? []) {
  requireContract(
    stage.kv_namespaces?.some(
      (item) => item.binding === binding.binding && item.id === binding.id,
    ),
    "KV must reuse staging resource",
  );
}
const entry = await readFile(
  new URL("./src/index.ts", import.meta.url),
  "utf8",
);
requireContract(
  entry.includes(
    'export { InferenceAdmissionGate } from "../../api/src/inference-admission-gate";',
  ),
  "Entry must reuse canonical admission class",
);
console.log(
  "Admission staging transfer source contract passed; live namespace and secret parity unverified.",
);
