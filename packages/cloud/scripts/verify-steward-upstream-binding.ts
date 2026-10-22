/**
 * Fail-closed deploy contract for the Worker's Steward upstream.
 *
 * STEWARD_API_URL is environment-scoped routing authority: if staging receives
 * the production value, every proxied auth request crosses environments while
 * continuing to return healthy-looking 200 responses. Cloudflare cannot reveal
 * an existing secret value, so an absent GitHub candidate remains a deliberate
 * preserve-only state. Any nonblank candidate, however, must exactly match the
 * canonical upstream for the target environment before it can be queued into
 * the atomic Worker version.
 *
 * The candidate value is never printed. Error output names the binding and the
 * expected public origin only.
 */

import { pathToFileURL } from "node:url";

export const CANONICAL_STEWARD_UPSTREAM_URLS: Readonly<
  Record<"staging" | "production", string>
> = Object.freeze(
  Object.assign(Object.create(null), {
    staging: "https://steward-api-staging.up.railway.app",
    production: "https://eliza.steward.fi",
  }),
);

/** Exact same-environment destinations during the reversible hosting cutover. */
export const CANONICAL_LOGIN_UPSTREAM_URLS = Object.freeze({
  staging: Object.freeze([
    CANONICAL_STEWARD_UPSTREAM_URLS.staging,
    "https://eliza-login-staging.square-rain-7251.workers.dev",
  ]),
  production: Object.freeze([
    CANONICAL_STEWARD_UPSTREAM_URLS.production,
    "https://steward-api-production-115d.up.railway.app",
    "https://eliza-login-production.square-rain-7251.workers.dev",
  ]),
});

export function verifyStewardUpstreamBinding({
  deployEnvironment,
  stewardApiUrl,
  loginApiUrl = "",
}: {
  deployEnvironment: string;
  stewardApiUrl?: unknown;
  loginApiUrl?: unknown;
}) {
  if (deployEnvironment !== "staging" && deployEnvironment !== "production") {
    return {
      ok: false,
      error: `DEPLOY_ENVIRONMENT "${deployEnvironment}" has no canonical Steward upstream`,
    };
  }
  const canonical = CANONICAL_STEWARD_UPSTREAM_URLS[deployEnvironment];

  if (
    loginApiUrl !== "" &&
    (typeof loginApiUrl !== "string" ||
      !CANONICAL_LOGIN_UPSTREAM_URLS[deployEnvironment].includes(loginApiUrl))
  ) {
    return {
      ok: false,
      error: `LOGIN_API_URL does not match an approved ${deployEnvironment} login upstream; refusing a possible cross-environment auth deployment`,
    };
  }

  const candidate =
    typeof stewardApiUrl === "string" ? stewardApiUrl.trim() : "";
  if (candidate === "") {
    return {
      ok: true,
      preservedExistingBinding: loginApiUrl === "",
      error: null,
    };
  }

  if (candidate !== canonical) {
    return {
      ok: false,
      error: `STEWARD_API_URL does not match the canonical ${deployEnvironment} Steward upstream ${canonical}; refusing a possible cross-environment auth deployment`,
    };
  }

  return { ok: true, preservedExistingBinding: false, error: null };
}

function main() {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this standalone deploy-script input outside Turbo caching.
  const deployEnvironment = process.env.DEPLOY_ENVIRONMENT ?? "";
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this protected standalone deploy-script candidate outside Turbo caching.
  const stewardApiUrl = process.env.STEWARD_API_URL ?? "";
  const loginApiUrl = process.env.LOGIN_API_URL ?? "";
  const result = verifyStewardUpstreamBinding({
    deployEnvironment,
    stewardApiUrl,
    loginApiUrl,
  });

  if (!result.ok) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }

  if (result.preservedExistingBinding) {
    console.log(
      `Login routing has no configured ${deployEnvironment} candidate; preserving the existing bindings without claiming their values were verified.`,
    );
    return;
  }

  console.log(
    `Verified the configured ${deployEnvironment} login routing candidates against their approved upstreams; candidate values were not printed.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // error-policy:J1 CLI boundary: translate a failed routing contract into a nonzero deploy result.
  try {
    main();
  } catch (error) {
    console.error(
      `::error::Steward upstream binding verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
