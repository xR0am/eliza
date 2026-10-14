/** Blocks enrolled Durable Objects before a policy write, then publishes after COMMIT. */
import { ElizaError } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { sqlRows } from "../../db/execute-helpers";
import {
  dbWrite,
  registerAfterCommit,
  registerBeforeCommit,
  writeTransaction,
} from "../../db/helpers";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";

export class InferencePolicyFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferencePolicyFenceError";
  }
}

const transactionFences = new WeakMap<DbTransaction, Set<string>>();

interface MutationOptions {
  organizationIds: string[];
  mutationId?: string;
  /** Bootstrap also fences organizations that have not yet enrolled. */
  enable?: boolean;
  /** Internal rollback after every canonical escrow grant has closed. */
  disable?: boolean;
}

async function policyCall(
  organizationId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>("INFERENCE_ADMISSION_GATES");
  if (!namespace)
    throw new InferencePolicyFenceError("Inference policy Durable Object binding is missing");
  const response = await namespace.getByName(organizationId).fetch(
    new Request(`https://inference-admission.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok)
    throw new InferencePolicyFenceError("Inference policy publication was not acknowledged");
  return response.json();
}

interface MutationPermit {
  blocked: true;
  mutationId: string;
  fenceToken: string;
  validUntil: number;
  rateWindowEndsAt?: number;
}

async function beginPolicyMutation(
  organizationId: string,
  mutationId: string,
  disable = false,
): Promise<MutationPermit> {
  const result = await policyCall(organizationId, "/policy-mutation/begin", {
    organizationId,
    mutationId,
    disable,
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("blocked" in result) ||
    result.blocked !== true ||
    !("mutationId" in result) ||
    result.mutationId !== mutationId ||
    !("fenceToken" in result) ||
    typeof result.fenceToken !== "string" ||
    !("validUntil" in result) ||
    typeof result.validUntil !== "number" ||
    !Number.isFinite(result.validUntil) ||
    result.validUntil <= Date.now()
  )
    throw new InferencePolicyFenceError("Inference policy mutation permit is invalid");
  if (
    disable &&
    (!("rateWindowEndsAt" in result) ||
      typeof result.rateWindowEndsAt !== "number" ||
      !Number.isSafeInteger(result.rateWindowEndsAt))
  )
    throw new InferencePolicyFenceError("Inference rollback rate boundary is invalid");
  return result as MutationPermit;
}

async function rollbackIsReady(organizationId: string, permit: MutationPermit): Promise<boolean> {
  const result = await policyCall(organizationId, "/policy-mutation/disable-ready", {
    organizationId,
    mutationId: permit.mutationId,
    fenceToken: permit.fenceToken,
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("ready" in result) ||
    typeof result.ready !== "boolean"
  )
    throw new InferencePolicyFenceError("Inference rollback acknowledgement is invalid");
  return result.ready;
}

export async function readBudgetPolicyEpoch(
  tx: DbTransaction,
  organizationId: string,
): Promise<string | null> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true") return null;
  const [row] = await sqlRows<{ epoch: string }>(
    tx,
    sql`SELECT epoch::text AS epoch FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid AND enabled`,
  );
  return row?.epoch ?? null;
}

/** Recovery must take this lock before deciding a missing receipt means rollback. */
export async function lockInferencePolicyMutation(
  tx: DbTransaction,
  organizationId: string,
  mutationId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${mutationId}`}, 0))`,
  );
}

export async function withInferencePolicyMutation<T>(
  options: MutationOptions,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return writeTransaction((tx) => withInferencePolicyMutationInTransaction(tx, options, fn));
}

export async function withInferencePolicyMutationInTransaction<T>(
  tx: DbTransaction,
  options: MutationOptions,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true") {
    if (options.enable || options.disable)
      throw new InferencePolicyFenceError("Inference funded budget admission is disabled");
    return fn(tx);
  }
  if (options.enable && options.disable)
    throw new InferencePolicyFenceError("Policy enrollment and rollback cannot share one command");
  const active = transactionFences.get(tx) ?? new Set<string>();
  const organizationIds: string[] = [];
  for (const organizationId of [...new Set(options.organizationIds)].sort()) {
    if (active.has(organizationId)) {
      if (options.disable)
        throw new InferencePolicyFenceError("Rollback requires its own managed policy transaction");
      continue;
    }
    if (options.enable || (await readBudgetPolicyEpoch(tx, organizationId)) !== null)
      organizationIds.push(organizationId);
  }
  if (organizationIds.length === 0) return fn(tx);
  const mutationId = options.mutationId ?? crypto.randomUUID();
  const publications: Array<{ organizationId: string; fenceToken: string }> = [];
  // Registration verifies exact outer transaction ownership before any DO side effect.
  registerAfterCommit(tx, async () => {
    if (publications.length === 0) return;
    const { loadInferenceBudgetPolicy } = await import("./inference-funded-budget-admission");
    for (const publication of publications) {
      const policy = await loadInferenceBudgetPolicy(publication.organizationId);
      await policyCall(publication.organizationId, "/policy-mutation/commit", {
        ...publication,
        mutationId,
        policy,
      });
      await dbWrite.execute(
        sql`UPDATE inference_policy_mutations SET phase = 'complete', updated_at = clock_timestamp() WHERE organization_id = ${publication.organizationId}::uuid AND mutation_id = ${mutationId} AND phase = 'applied'`,
      );
    }
  });
  for (const organizationId of organizationIds) {
    const result = await beginPolicyMutation(organizationId, mutationId, options.disable === true);
    if (options.disable && !(await rollbackIsReady(organizationId, result)))
      throw new InferencePolicyFenceError("Inference rollback rate window has not ended");
    await lockInferencePolicyMutation(tx, organizationId, mutationId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inference-policy:${organizationId}`}, 0))`,
    );
    await tx.execute(
      sql`INSERT INTO inference_policy_authorities (organization_id) SELECT ${organizationId}::uuid WHERE NOT EXISTS (SELECT 1 FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid)`,
    );
    await tx.execute(
      sql`INSERT INTO inference_policy_mutations (organization_id, mutation_id, fence_token, permit_expires_at, applying_txid, phase) VALUES (${organizationId}::uuid, ${mutationId}, ${result.fenceToken}, ${new Date(result.validUntil)}, txid_current(), 'applying')`,
    );
    // The authority row serializes enrollment and epoch increments across concurrent commands.
    await tx.execute(
      sql`SELECT organization_id FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid FOR UPDATE`,
    );
    publications.push({ organizationId, fenceToken: result.fenceToken });
    active.add(organizationId);
    transactionFences.set(tx, active);
  }
  registerBeforeCommit(tx, async () => {
    for (const { organizationId } of publications) {
      await tx.execute(
        sql`UPDATE inference_policy_authorities SET enabled = ${!options.disable}, epoch = epoch + 1, updated_at = clock_timestamp() WHERE organization_id = ${organizationId}::uuid`,
      );
      await tx.execute(
        sql`UPDATE inference_policy_mutations SET phase = 'applied', epoch = (SELECT epoch FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid), updated_at = clock_timestamp() WHERE organization_id = ${organizationId}::uuid AND mutation_id = ${mutationId} AND applying_txid = txid_current() AND phase = 'applying'`,
      );
    }
  });
  return fn(tx);
}

/** An absent receipt is conclusive only after the DO permit expired and this lock completed. */
export async function inspectInferencePolicyMutation(
  organizationId: string,
  mutationId: string,
): Promise<
  { state: "absent" } | { state: "applied" | "complete"; fenceToken: string; epoch: string }
> {
  return writeTransaction(async (tx) => {
    await lockInferencePolicyMutation(tx, organizationId, mutationId);
    const [row] = await sqlRows<{ phase: string; fence_token: string; epoch: string | null }>(
      tx,
      sql`SELECT phase, fence_token, epoch::text AS epoch FROM inference_policy_mutations WHERE organization_id = ${organizationId}::uuid AND mutation_id = ${mutationId}`,
    );
    if (!row) return { state: "absent" };
    if ((row.phase !== "applied" && row.phase !== "complete") || row.epoch === null)
      throw new InferencePolicyFenceError("Inference policy mutation outcome is not committed");
    return { state: row.phase, fenceToken: row.fence_token, epoch: row.epoch };
  });
}

/** Account and moderation changes affect every organization that issued this user's keys. */
export async function withInferenceUserPolicyMutation<T>(
  userId: string,
  additionalOrganizationIds: string[],
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true") return writeTransaction(fn);
  const rows = await sqlRows<{ organization_id: string }>(
    dbWrite,
    sql`SELECT organization_id FROM users WHERE id = ${userId}::uuid AND organization_id IS NOT NULL UNION SELECT organization_id FROM api_keys WHERE user_id = ${userId}::uuid`,
  );
  return withInferencePolicyMutation(
    { organizationIds: [...rows.map((row) => row.organization_id), ...additionalOrganizationIds] },
    fn,
  );
}

/** Authorize subsequent policy writes through the exact outer transaction's COMMIT. */
export async function ensureInferencePolicyMutation(
  tx: DbTransaction,
  organizationId: string,
): Promise<void> {
  await withInferencePolicyMutationInTransaction(
    tx,
    { organizationIds: [organizationId] },
    async () => {},
  );
}

export class InferencePolicyDrainPendingError extends ElizaError {
  constructor(organizationId: string) {
    super("Inference escrow must finish reconciliation before rollback", {
      code: "INFERENCE_POLICY_DRAIN_PENDING",
      severity: "ephemeral",
      context: { organizationId },
    });
  }
}

/** Keep the feature and binding enabled while reclaiming, draining, and withdrawing authority. */
export async function disableInferenceBudgetAdmission(organizationId: string): Promise<void> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true") {
    throw new InferencePolicyFenceError(
      "Keep funded budget admission enabled until rollback is acknowledged",
    );
  }
  const [preflight] = await sqlRows<{ id: string }>(
    dbWrite,
    sql`SELECT id FROM inference_funding_budget_grants WHERE organization_id = ${organizationId}::uuid AND closed_at IS NULL LIMIT 1`,
  );
  if (preflight) throw new InferencePolicyDrainPendingError(organizationId);
  const [authority] = await sqlRows<{ enabled: boolean }>(
    dbWrite,
    sql`SELECT enabled FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid`,
  );
  const mutationId = crypto.randomUUID();
  if (authority?.enabled) {
    const permit = await beginPolicyMutation(organizationId, mutationId, true);
    // No database transaction is open while the DO blocks the rest of this window.
    while (!(await rollbackIsReady(organizationId, permit))) {
      if (Date.now() >= permit.validUntil)
        throw new InferencePolicyFenceError("Inference rollback permit expired");
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(1000, Math.max(1, permit.rateWindowEndsAt! - Date.now()))),
      );
    }
  }
  await withInferencePolicyMutation(
    { organizationIds: [organizationId], mutationId, disable: true },
    async (tx) => {
      // A concurrent mint owns this same organization lock until its grant commits.
      // The subsequent statement must use a fresh snapshot after waiting for it.
      const [organization] = await sqlRows<{ id: string }>(
        tx,
        sql`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`,
      );
      if (!organization)
        throw new InferencePolicyFenceError("Inference policy organization does not exist");
      const [open] = await sqlRows<{ id: string }>(
        tx,
        sql`SELECT id FROM inference_funding_budget_grants WHERE organization_id = ${organizationId}::uuid AND closed_at IS NULL LIMIT 1`,
      );
      if (open) throw new InferencePolicyDrainPendingError(organizationId);
    },
  );
  const keys = await sqlRows<{ key_hash: string }>(
    dbWrite,
    sql`SELECT key_hash FROM api_keys WHERE organization_id = ${organizationId}::uuid`,
  );
  const { invalidateInferenceAuthContextsByKeyHashes } = await import("./inference-auth-cache");
  await invalidateInferenceAuthContextsByKeyHashes(keys.map((key) => key.key_hash));
}
