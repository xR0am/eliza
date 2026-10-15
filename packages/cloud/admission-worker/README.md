# Inference admission isolate candidate

This staging-only Worker exports the existing API admission class. It does not copy
or rewrite the state machine. The entry has no HTTP admission endpoint. Do not add
public routes, initialize another namespace, enable funded admission, or change
organization actor names while testing this boundary.

Current retained staging namespace: `602cdb65e31741058989d8a370753039`.
Its class is `InferenceAdmissionGate`, owned by `eliza-cloud-api-staging`.
Rate counters, operation receipts, revocation generations, leases, funded grants,
and alarm recovery state must remain in this namespace. New actor names would
reset quotas and split financial authority; they are outside this change.

## Pending qualification

This clean branch starts from `2356dd0`, which includes the qualified five-second
caller and actor validity change. The entry reuses that same canonical actor;
it does not inherit the separate Core import cleanup or build-foundation changes.
The source-contract command below checks transfer preparation only; it is not
runtime qualification or permission to deploy.

## Source and build boundary

The sole class export reuses `../api/src/inference-admission-gate.ts` through the
relative entry import. Its eager Cloud imports are binding context, affiliate
snapshot validation, and logging. Funded controller and PostgreSQL recovery stay
dynamic. This removes the API router and unrelated Durable Object classes from
the Worker entry graph. It does not establish any cold-start improvement.

The target also retains the canonical staging API define map and all 13 existing
Worker adapters. Alias paths are rebased to this config directory; no new Core,
plugin, or implementation aliases are introduced. The source contract compares
resolved paths and the exact define map.

Use the normal built workspace dependencies and pinned Wrangler. After the sole
build owner releases the producer, from the repository root run:

```bash
bun packages/cloud/admission-worker/verify-staging-contract.ts
bun x --no-install wrangler deploy --config packages/cloud/admission-worker/wrangler.toml --dry-run --outdir test-results/admission-worker-candidate
```

Measure the actual emitted eager graph, artifact size, and native cold/warm
behavior before approving any platform lifecycle operation. A second module in
the existing statically exported API graph does not give an independent isolate.
Lazy wrappers around every other DO would change constructors, RPC exposure,
WebSocket and alarm lifecycles. That is not a minimal equivalent alternative.

## Environment parity

The prepared target points at the same staging Hyperdrive and Cache KV and copies
existing staging inference flags. Funded admission remains unset/disabled.
Never copy production resources. The complete source dependency inventory is
kept with the evidence: it includes 550 Cloud modules across dynamic branches,
not 550 operations that run during an alarm. The entry's four eager Cloud modules
exclude the external Core protocol dependency; artifact inspection must include it.

Recovery still owns app-credit settlement, subscriber funding, affiliate payout
receipts, policy fencing, and cache publication. Verify the target's normal
operator secret projection against those owners before transfer. Required names
include the existing funding seal when funded mode is enabled, and whichever
existing encryption/email/storage credentials the exercised recovery branches
require. Do not copy every conservative environment-name hit: that list includes
unused deployment, test, and unsafe development settings. No secret values belong
in this directory. Alarm tests must prove idempotent recovery using the actual
same database, cache, authority and effective flags as the source.

`DATABASE_URL` is required even with Hyperdrive. The database client resolves the
primary URL before it selects the Hyperdrive transport. Project the existing
staging secret through the normal operator path before transfer; do not use a
placeholder URL. Retain the source email transport secrets for low-credit notices
and its public app URL for billing links. The target secret projection is not yet
qualified. Keep Stripe and the funded-budget seal absent, as they are in staging.

## Staging transfer and reversal

The source already uses declarative `exports`; do not add legacy
`migrations`/`transferred_classes`. Cloudflare's current transfer flow is:

1. Verify source namespace ID and storage. Keep its class export unchanged.
2. Deploy this target's pending `expecting-transfer` configuration, without a
   self-binding. Verify it created no replacement namespace.
3. On the source, keep the class in code, change only its declaration to
   `state = "transferred"`, `transferred_to = "eliza-cloud-admission-staging"`
   and remove `storage`. Repoint its binding with that `script_name`. Deploy.
4. After rollout, add the target's self-binding and make its export live/sqlite.
   Verify the SAME namespace ID, actor IDs and stored receipts before acceptance.

This lifecycle operation affects every organization in the staging namespace; it
cannot be a percentage or single-organization namespace canary. Keep the source
class and transfer tombstone through the observation period.
Inventory Cloudflare's `referencing_scripts`; update every actual external
consumer before removing that tombstone. Source configuration has default,
staging and production bindings, but this candidate changes staging only. Shared
rate, billing, policy, snapshot and credential writers all use that binding name.

Before transfer commit, cancel by removing the pending target entry. After commit,
ordinary version rollback cannot cross this lifecycle change. Reverse the same
transfer: original API becomes expecting-transfer from the admission Worker;
admission Worker commits a transferred tombstone back to API; restore bindings;
verify the namespace ID and financial receipts again. Keep the code and storage
schema compatible in both directions. Never use deleted/new classes as rollback.

Official transfer and rollback constraints:
https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/

No live namespace, migration, transfer, credential, or deployment operation has
been performed by preparing this candidate. Production requires its own reviewed
resource inventory and separate acceptance.

## Private accounting recovery service

The admission isolate forwards only expired-lease accounting to the original
API's named `InferenceRecoveryService` capability. It sends the canonical context,
amount and two awaited fence callbacks; RPC callbacks preserve the actor-owned
balance revision fence before the service returns. This endpoint has no public
HTTP route and performs no arbitrary method dispatch. The API retains its own
DB/cache/mail credentials and configuration; the target needs only the private
service binding. The existing canonical recovery function and validator remain
the owners. Missing service or callback failure rejects recovery and retains the
lease for the existing retry path.

New source requires normal API and thin build/type checks plus real cross-Worker
RPC tests and canonical abandoned-lease accounting tests before transfer. The
small RPC transport fixture is not a PostgreSQL financial-acceptance substitute.
Do not copy the older direct-DB target secret requirements into this candidate.
