# Redis REST adapter

Upstash-compatible HTTP transport for the environment's authoritative Redis.
Configure `SRH_MODE=env`, `SRH_TOKEN`, `SRH_CONNECTION_STRING` using the
Redis public URL, and `PORT=80`. Point Worker `KV_REST_API_URL` and
`KV_REST_API_TOKEN` at this service. Preserve authentication; this is not a
second database.

Build from this directory:

```bash
docker build -t eliza-redis-rest .
```

Cloudflare hosts the same pinned image using `cloudflare/wrangler.toml` with
separate `staging` and `production` environments. Install `SRH_TOKEN` and
`SRH_CONNECTION_STRING` as Worker secrets before sending authenticated traffic.
The Worker authenticates before starting the container. Container disk holds no
authoritative data; this moves HTTP transport, not the Redis database.

Run `bun run test`, `bun run typecheck`, and `bun run lint:check` here.
After deployment, verify authenticated Redis PING, pipeline encoding, and the
Cloud authentication nonce route before switching `KV_REST_API_URL` and
retiring the previous bridge. Preserve its token during the transition.
