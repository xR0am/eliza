/** Launcher slot selection must retain absent and invalid values at the SDK boundary. */
import { applyNativeApplicationInferenceHeaders } from "@elizaos/cloud-sdk";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "../src/cloud-config/dev-cloud-env-authority";
import { getNativeApplicationSlot, getSetting } from "../src/utils/config";
import { withNativeFundingAuthority } from "../src/utils/native-funding";

const keys = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_APPLICATION_SLOT",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

function runtimeWithSlot(value: string | undefined): IAgentRuntime {
  return {
    getSetting: (key: string) => (key === "ELIZAOS_CLOUD_APPLICATION_SLOT" ? value : undefined),
  } as IAgentRuntime;
}

function inferenceHeaders(runtime: IAgentRuntime, path: string): Headers {
  const headers = new Headers({ "Idempotency-Key": "native:authority-regression" });
  applyNativeApplicationInferenceHeaders({
    slotKey: getNativeApplicationSlot(runtime),
    method: "POST",
    path,
    headers,
  });
  return headers;
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of keys) delete process.env[key];
  // A test must never reach a provider or Cloud, including through a future refactor.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network call");
    })
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("native application slot launcher authority", () => {
  it.each(["", "stale-product"])(
    "keeps an absent sealed slot absent despite runtime value %j and late env mutation",
    async (runtimeValue) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
      captureDevCloudEnvAuthoritySnapshot(process.env);
      process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "late-product";
      const runtime = runtimeWithSlot(runtimeValue);
      // The prior getter forwarded the runtime overlay's empty string to the real SDK.
      if (runtimeValue === "") {
        expect(() =>
          applyNativeApplicationInferenceHeaders({
            slotKey: getSetting(runtime, "ELIZAOS_CLOUD_APPLICATION_SLOT"),
            method: "POST",
            path: "/chat/completions",
            headers: new Headers(),
          })
        ).toThrow("Select a configured application product");
      }
      expect(getNativeApplicationSlot(runtime)).toBeUndefined();
      for (const path of ["/chat/completions", "/embeddings"]) {
        expect(inferenceHeaders(runtime, path).has("X-Eliza-Application-Slot")).toBe(false);
      }
      const failure = new Error("Original operation failure");
      await expect(
        withNativeFundingAuthority(runtime, async () => {
          throw failure;
        })
      ).rejects.toBe(failure);
    }
  );

  it("retains a selected launcher product and its funding failure fence", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "selected-product";
    captureDevCloudEnvAuthoritySnapshot(process.env);
    process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "late-product";
    const runtime = runtimeWithSlot("stale-product");
    for (const path of ["/chat/completions", "/embeddings"]) {
      expect(inferenceHeaders(runtime, path).get("X-Eliza-Application-Slot")).toBe(
        "selected-product"
      );
    }
    await expect(
      withNativeFundingAuthority(runtime, async () => {
        throw new Error("failure");
      })
    ).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
  });

  it.each(["", " ", " invalid-product", "bad/product"])(
    "preserves explicitly invalid launcher selection %j for SDK rejection",
    async (slot) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
      process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = slot;
      const runtime = runtimeWithSlot("stale-product");
      expect(getNativeApplicationSlot(runtime)).toBe(slot);
      for (const path of ["/chat/completions", "/embeddings"]) {
        expect(() => inferenceHeaders(runtime, path)).toThrow(
          "Select a configured application product"
        );
      }
      await expect(
        withNativeFundingAuthority(runtime, async () => {
          throw new Error("failure");
        })
      ).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
    }
  );

  it("retains unmanaged runtime selection and its funding fence outside dev authority", async () => {
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "environment-product";
    const runtime = runtimeWithSlot("runtime-product");
    expect(getNativeApplicationSlot(runtime)).toBe("runtime-product");
    expect(inferenceHeaders(runtime, "/chat/completions").get("X-Eliza-Application-Slot")).toBe(
      "runtime-product"
    );
    await expect(
      withNativeFundingAuthority(runtime, async () => {
        throw new Error("failure");
      })
    ).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
  });
});
