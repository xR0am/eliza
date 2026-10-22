import { describe, expect, test } from "bun:test";
import { spawnSync } from "../../../scripts/lib/spawn-sync-captured.ts";
import { parseProviderDiscoveryArgs } from "../verify-steward-provider-discovery.ts";
import { verifyStewardUpstreamBinding } from "../verify-steward-upstream-binding.ts";

const staging = "https://eliza-login-staging.square-rain-7251.workers.dev";
const production =
  "https://eliza-login-production.square-rain-7251.workers.dev";

describe("login release routing", () => {
  test("accepts environment-owned Cloudflare origins and preserves unset routing", () => {
    for (const [deployEnvironment, loginApiUrl] of [
      ["staging", staging],
      ["production", production],
    ]) {
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          loginApiUrl,
          stewardApiUrl: "",
        }),
      ).toEqual({ ok: true, preservedExistingBinding: false, error: null });
    }
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "staging",
        stewardApiUrl: "",
      }),
    ).toEqual({ ok: true, preservedExistingBinding: true, error: null });
  });

  test("rejects foreign origins, malformed overrides, and foreign legacy candidates", () => {
    for (const loginApiUrl of [
      production,
      `${staging}.evil.example`,
      `${staging}/`,
      `${staging}?token=private-test-value`,
      staging.replace("https:", "http:"),
      " ",
      ` ${staging}`,
    ]) {
      const result = verifyStewardUpstreamBinding({
        deployEnvironment: "staging",
        loginApiUrl,
        stewardApiUrl: "",
      });
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain("private-test-value");
    }
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "production",
        loginApiUrl: staging,
        stewardApiUrl: "",
      }).ok,
    ).toBe(false);
    expect(
      verifyStewardUpstreamBinding({
        deployEnvironment: "staging",
        loginApiUrl: staging,
        stewardApiUrl: "https://eliza.steward.fi",
      }).ok,
    ).toBe(false);
  });

  test("provider discovery admits the staging replacement but no production upstream", () => {
    const args = (baseUrl: string) => [
      "--base-url",
      baseUrl,
      "--environment",
      "staging",
      "--surface",
      "upstream",
    ];
    expect(parseProviderDiscoveryArgs(args(staging)).baseUrl).toBe(staging);
    expect(() => parseProviderDiscoveryArgs(args(production))).toThrow(
      "canonical staging",
    );
    expect(() =>
      parseProviderDiscoveryArgs(args(`${staging}.evil.example`)),
    ).toThrow("canonical staging");
    expect(
      parseProviderDiscoveryArgs(
        args("https://steward-api-staging.up.railway.app"),
      ).baseUrl,
    ).toBe("https://steward-api-staging.up.railway.app");
  });

  test("the release CLI rejects a cross-environment override without disclosing it", () => {
    const candidate = `${production}?private-test-value`;
    const result = spawnSync(
      process.execPath,
      [
        new URL("../verify-steward-upstream-binding.ts", import.meta.url)
          .pathname,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DEPLOY_ENVIRONMENT: "staging",
          STEWARD_API_URL: "",
          LOGIN_API_URL: candidate,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LOGIN_API_URL");
    expect(result.stderr).not.toContain(candidate);
  });
});
