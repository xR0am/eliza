# Cloudflare gateway hosting

Hosts the existing webhook and Discord gateway images. Their authentication,
consent, receipt, queue, and leader-lease implementations remain authoritative.
State still uses the configured external store; this wrapper does not retire Redis.

Use `cloudflare/wrangler.toml` with `webhook-staging`, `webhook-production`,
`discord-staging`, or `discord-production`. Deployments start inactive.
Set `GATEWAY_RUNTIME_CONFIG` as one JSON secret containing the running process's
string-valued settings. Preserve all keys and delivery flags. State endpoints
must be reachable from Cloudflare. Supply the exact runtime source as `BUILD_ID`.

Before activation, verify the image and configuration, then stop and drain the
old gateway. Deploy with `GATEWAY_ENABLED=true`. Verify health, authenticated
routing, provider callbacks, and retained receipts before retiring the old host.
After the canonical API release changes routing, run
`DEPLOY_ENVIRONMENT=staging node packages/cloud/scripts/verify-served-webhook-gateway.ts`
from the repository root (use `production` for production). This checks the served
API reaches the healthy Cloudflare image using an invalid verification handshake;
it sends no provider message. Direct gateway health alone is not cutover proof.
Every later active deployment must also set this flag.

For rollback, deploy with `GATEWAY_ENABLED=false`. The next request or cron sends
SIGTERM. Observe the container's stopped state before starting another writer;
a 503 response alone does not prove that shutdown finished.

The protected release verifier can POST a fresh nonce and selected setting names
to `/internal/configuration-proof`, authenticated with the existing bootstrap
secret. It returns source/environment/activation metadata and a nonce-bound digest,
never configuration values. Treat the digest as sensitive and do not log it.
The proof works while inactive; health and container state must be checked
separately before any traffic or ownership change.
