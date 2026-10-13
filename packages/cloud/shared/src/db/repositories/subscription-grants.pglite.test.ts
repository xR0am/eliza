/**
 * Redeems subscription grant codes against the real subscription migrations
 * on PGlite, then reads the same organization policy and allowance
 * eligibility that inference admission uses, during and after the grant and
 * alongside a paid subscription.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

const PAID_ORG = "61000000-0000-4000-8000-000000000001";
const PAID_SUB = "62000000-0000-4000-8000-000000000001";
const USER = "63000000-0000-4000-8000-000000000001";
const PEPPER = "test-pepper-0123456789abcdef0123456789";
let orgCounter = 0;

let database: typeof import("../client");
let grants: typeof import("./subscription-grants");
let policyModule: typeof import("../../lib/services/organization-quota-policy");
let eligibility: typeof import("./subscription-allowance-eligibility");

async function exec(query: string): Promise<void> {
  await database.getPgliteClientForTests().exec(query);
}
async function rows<T>(query: string): Promise<T[]> {
  return (await database.getPgliteClientForTests().query<T>(query)).rows;
}

async function newOrg(): Promise<string> {
  orgCounter += 1;
  const id = `64000000-0000-4000-8000-${String(orgCounter).padStart(12, "0")}`;
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${id}', '0', 1, 0, '{}', true, false, 'active')`);
  return id;
}

async function newCode(
  code: string,
  options: {
    max?: number;
    family?: string;
    expiresAt?: string;
    disabled?: boolean;
    days?: number;
  } = {},
): Promise<void> {
  const normalized = grants.normalizeSubscriptionGrantCode(code);
  if (!normalized) throw new Error(`bad test code ${code}`);
  const hash = await grants.hashSubscriptionGrantCode(normalized, PEPPER);
  await exec(`INSERT INTO subscription_grant_codes(code_hash, family, max_redemptions, duration_days, expires_at, disabled_at)
    VALUES ('${hash}', '${options.family ?? "alpha_phone"}', ${options.max ?? 1}, ${options.days ?? 183},
      ${options.expiresAt ? `'${options.expiresAt}'` : "NULL"}, ${options.disabled ? "now()" : "NULL"})`);
}

async function redeem(
  organizationId: string,
  code: string,
  idempotencyKey = `key-${code.replace(/\W/g, "")}-${organizationId}`,
) {
  const normalized = grants.normalizeSubscriptionGrantCode(code);
  return grants.subscriptionGrantsRepository.redeem({
    organizationId,
    userId: USER,
    codeHash: await grants.hashSubscriptionGrantCode(normalized ?? code, PEPPER),
    idempotencyKey,
  });
}

async function policyAt(organizationId: string, at?: Date) {
  return database.dbWrite.transaction((tx) =>
    policyModule.readOrganizationQuotaPolicyInTransaction(tx, organizationId, at),
  );
}

async function allowanceAt(organizationId: string, at: Date) {
  return database.dbWrite.transaction((tx) =>
    eligibility.readEligibleSubscriptionAllowance(tx, organizationId, at, false),
  );
}

beforeAll(async () => {
  database = await import("../client");
  await createBillingSnapshotFixture(exec, "");
  // Production state from 0404: subscription-grant (and trial) buckets carry no invoice.
  await exec(
    `ALTER TABLE subscription_allowance_periods ALTER COLUMN stripe_invoice_id DROP NOT NULL`,
  );
  await exec(`INSERT INTO users(id) VALUES ('${USER}')`);
  // Publish the fixture's paid Plus projection exactly as its lifecycle revision derives it.
  await exec(`UPDATE organization_entitlements SET completions_rpm = 120, embeddings_rpm = 200,
    standard_rpm = 60, strict_rpm = 10, entitlement_effective = true,
    effective_from = '2026-08-01Z', effective_until = '2026-09-01Z', catalog_version = 'v1',
    source_digest = '${"b".repeat(64)}' WHERE organization_id = '${PAID_ORG}'`);
  grants = await import("./subscription-grants");
  policyModule = await import("../../lib/services/organization-quota-policy");
  eligibility = await import("./subscription-allowance-eligibility");
});

afterAll(async () => {
  if (database) await database.closeDatabaseConnectionsForTests();
});

describe("subscription grant redemption", () => {
  test("a redeemed code serves the organization as an active Plus subscriber", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0001");
    const before = await policyAt(org);
    expect(before.authority.source).toBe("legacy");
    expect(before.subscriptionFunded).toBe(false);

    const { grant, replayed } = await redeem(org, "aaaa bbbb cccc 0001");
    expect(replayed).toBe(false);
    expect(grant.plan_key).toBe("plus_monthly");
    expect(grant.ends_at.getTime() - grant.starts_at.getTime()).toBe(183 * 86_400_000);

    const [projection] = await rows<{
      plan_key: string;
      state: string;
      source_grant_id: string;
      completions_rpm: number;
    }>(
      `SELECT plan_key, state, source_grant_id, completions_rpm FROM organization_entitlements WHERE organization_id = '${org}' AND billing_scope_id IS NULL`,
    );
    expect(projection).toMatchObject({
      plan_key: "plus_monthly",
      state: "active",
      source_grant_id: grant.id,
      completions_rpm: 120,
    });

    const buckets = await rows<{ granted_amount: string; period_start: Date; period_end: Date }>(
      `SELECT granted_amount, period_start, period_end FROM subscription_allowance_periods WHERE promo_grant_id = '${grant.id}' ORDER BY period_start`,
    );
    expect(buckets.length).toBe(7);
    expect(buckets.slice(0, 6).every((bucket) => bucket.granted_amount === "25.000000")).toBe(true);
    expect(Number(buckets[6]!.granted_amount)).toBeGreaterThan(0);
    expect(Number(buckets[6]!.granted_amount)).toBeLessThan(25);
    expect(new Date(buckets[6]!.period_end).getTime()).toBe(grant.ends_at.getTime());

    const during = await policyAt(org);
    expect(during.authority).toMatchObject({
      source: "promo_grant",
      sourceGrantId: grant.id,
      effectiveUntil: grant.ends_at.toISOString(),
    });
    expect(during.authority.generation).not.toBe(before.authority.generation);
    expect(during.subscriptionFunded).toBe(true);
    expect(policyModule.requireOrganizationRateTier(during)).toMatchObject({
      tierName: "plus_monthly",
      completionsRpm: 120,
    });
    expect(during.limits.apiKeys).toEqual({
      status: "available",
      limit: 10n,
      source: "subscription-catalog",
    });
    const midGrant = new Date(grant.starts_at.getTime() + 40 * 86_400_000);
    const period = await allowanceAt(org, midGrant);
    expect(period?.promo_grant_id).toBe(grant.id);
    expect(period?.available_amount).toBe("25.000000");
  });

  test("admission reverts to the pay-as-you-go policy when the grant ends", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0002");
    const { grant } = await redeem(org, "AAAA-BBBB-CCCC-0002");
    const after = new Date(grant.ends_at.getTime() + 1_000);
    const policy = await policyAt(org, after);
    expect(policy.authority.source).toBe("legacy");
    expect(policy.subscriptionFunded).toBe(false);
    expect(await allowanceAt(org, after)).toBeUndefined();
  });

  test("a replay returns the original grant; a second code of the family is refused", async () => {
    const org = await newOrg();
    await newCode("AAAA-BBBB-CCCC-0003", { max: 5 });
    await newCode("AAAA-BBBB-CCCC-0004", { max: 5 });
    await newCode("AAAA-BBBB-CCCC-0005", { max: 5, family: "other_campaign" });
    const first = await redeem(org, "AAAA-BBBB-CCCC-0003", "phone-attempt-1");
    const replay = await redeem(org, "AAAA-BBBB-CCCC-0003", "phone-attempt-2");
    expect(replay).toEqual({ grant: first.grant, replayed: true });
    const [{ redeemed_count }] = await rows<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM subscription_grant_codes c JOIN subscription_grants g ON g.code_id = c.id WHERE g.id = '${first.grant.id}'`,
    );
    expect(redeemed_count).toBe(1);
    await expect(redeem(org, "AAAA-BBBB-CCCC-0004")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_ALREADY_GRANTED,
    });
    await expect(redeem(org, "AAAA-BBBB-CCCC-0005", "phone-attempt-1")).rejects.toMatchObject({
      code: grants.SUBSCRIPTION_GRANT_IDEMPOTENCY_CONFLICT,
    });
  });

  test("concurrent redemptions never exceed the limit or grant an organization twice", async () => {
    await newCode("AAAA-BBBB-CCCC-0006", { max: 2 });
    const orgs = await Promise.all([newOrg(), newOrg(), newOrg(), newOrg()]);
    const outcomes = await Promise.allSettled([
      ...orgs.map((org) => redeem(org, "AAAA-BBBB-CCCC-0006")),
      redeem(orgs[0]!, "AAAA-BBBB-CCCC-0006", "same-org-retry"),
    ]);
    const granted = outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && !outcome.value.replayed,
    );
    expect(granted).toHaveLength(2);
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(outcome.reason).toMatchObject({ code: grants.SUBSCRIPTION_GRANT_CODE_INVALID });
    const [{ redeemed_count, grants_count }] = await rows<{
      redeemed_count: number;
      grants_count: number;
    }>(
      `SELECT c.redeemed_count, (SELECT count(*)::int FROM subscription_grants g WHERE g.code_id = c.id) AS grants_count
       FROM subscription_grant_codes c WHERE c.max_redemptions = 2 AND c.family = 'alpha_phone' ORDER BY c.created_at DESC LIMIT 1`,
    );
    expect(redeemed_count).toBe(2);
    expect(grants_count).toBe(2);
    const perOrg = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM subscription_grants WHERE organization_id = '${orgs[0]}'`,
    );
    expect(perOrg[0]!.count).toBeLessThanOrEqual(1);
  });

  test("unknown, expired, disabled and exhausted codes share one refusal", async () => {
    await newCode("AAAA-BBBB-CCCC-0007", { expiresAt: "2020-01-01T00:00:00Z" });
    await newCode("AAAA-BBBB-CCCC-0008", { disabled: true });
    await newCode("AAAA-BBBB-CCCC-0009", { max: 1 });
    await redeem(await newOrg(), "AAAA-BBBB-CCCC-0009");
    for (const code of [
      "ZZZZ-ZZZZ-ZZZZ-ZZZZ",
      "AAAA-BBBB-CCCC-0007",
      "AAAA-BBBB-CCCC-0008",
      "AAAA-BBBB-CCCC-0009",
    ]) {
      const org = await newOrg();
      await expect(redeem(org, code)).rejects.toMatchObject({
        code: grants.SUBSCRIPTION_GRANT_CODE_INVALID,
      });
      const [{ count }] = await rows<{ count: number }>(
        `SELECT count(*)::int AS count FROM subscription_allowance_periods WHERE organization_id = '${org}'`,
      );
      expect(count).toBe(0);
    }
  });

  test("an effective paid subscription keeps precedence; the grant serves after it lapses", async () => {
    await newCode("AAAA-BBBB-CCCC-0010");
    const { grant } = await redeem(PAID_ORG, "AAAA-BBBB-CCCC-0010");
    // The paid projection is not replaced by the grant.
    const [projection] = await rows<{
      source_subscription_id: string;
      source_grant_id: string | null;
    }>(
      `SELECT source_subscription_id, source_grant_id FROM organization_entitlements WHERE organization_id = '${PAID_ORG}' AND billing_scope_id IS NULL`,
    );
    expect(projection).toEqual({ source_subscription_id: PAID_SUB, source_grant_id: null });

    // While the paid period is current, the paid subscription and its bucket serve.
    const paidTime = new Date("2026-08-15T00:00:00Z");
    const paid = await policyAt(PAID_ORG, paidTime);
    expect(paid.authority.source).toBe("subscription");
    expect((await allowanceAt(PAID_ORG, paidTime))?.subscription_id).toBe(PAID_SUB);

    // The fixture's paid period ended in September; now the grant serves.
    const now = new Date(grant.starts_at.getTime() + 60_000);
    const lapsed = await policyAt(PAID_ORG, now);
    expect(lapsed.authority).toMatchObject({ source: "promo_grant", sourceGrantId: grant.id });
    expect(lapsed.subscriptionFunded).toBe(true);
    expect((await allowanceAt(PAID_ORG, now))?.promo_grant_id).toBe(grant.id);
  });
});

describe("grant allowance schedule", () => {
  test("splits a window into calendar months and prorates the remainder", () => {
    const schedule = grants.grantAllowanceSchedule(
      new Date("2026-01-31T00:00:00Z"),
      new Date("2026-04-15T00:00:00Z"),
      "25.000000",
    );
    expect(schedule.map((bucket) => bucket.periodStart.toISOString())).toEqual([
      "2026-01-31T00:00:00.000Z",
      "2026-02-28T00:00:00.000Z",
      "2026-03-31T00:00:00.000Z",
    ]);
    expect(schedule.map((bucket) => bucket.amount)).toEqual([
      "25.000000",
      "25.000000",
      expect.stringMatching(/^1[12]\.\d{6}$/),
    ]);
  });
});
