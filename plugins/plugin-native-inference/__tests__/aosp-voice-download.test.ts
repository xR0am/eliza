import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AOSP_VOICE_GROUPS,
  AOSP_VOICE_RECORD,
  aospVoiceFiles,
  aospVoiceGroupFiles,
  downloadAospVoiceAsset,
  expectedAospVoicePin,
  readAospVoiceLocalSource,
  stageAospVoiceGroup,
} from "../src/aosp-voice-download.js";
import {
  DEFAULT_NETWORK_POLICY_PREFERENCES,
  type RawNetworkState,
} from "../src/model-catalog/network-policy.js";
import {
  isPublishedMobileVoiceFile,
  type MobileVoiceFile,
} from "../src/model-catalog/voice-models.js";

const roots: string[] = [];
const bytes = Buffer.from("complete model fixture");
const asset = {
  url: "https://huggingface.co/fixture/pinned/model",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const allowed = async (): Promise<RawNetworkState> => ({
  connectionType: "wifi",
  metered: false,
});
function destination() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aosp-voice-download-"));
  roots.push(dir);
  return path.join(dir, "model");
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("AOSP automatic voice download", () => {
  it("retains the complete verified bytes on an allowed network", async () => {
    const target = destination();
    let probes = 0;
    await downloadAospVoiceAsset(asset, target, {
      preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
      probe: async () => {
        probes++;
        return allowed();
      },
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
    });
    expect(readFileSync(target)).toEqual(bytes);
    expect(probes).toBeGreaterThanOrEqual(2);
  });
  for (const state of [
    { connectionType: "wifi", metered: true },
    { connectionType: "unknown", metered: null },
    { connectionType: "none", metered: null },
  ] as const) {
    it(`does not fetch on ${state.connectionType}/${state.metered}`, async () => {
      const target = destination();
      let fetched = false;
      await expect(
        downloadAospVoiceAsset(asset, target, {
          preferences: {
            ...DEFAULT_NETWORK_POLICY_PREFERENCES,
            quietHours: [],
          },
          probe: async () => state,
          fetchImpl: (async () => {
            fetched = true;
            return new Response(bytes);
          }) as typeof fetch,
        }),
      ).rejects.toThrow("allowed network");
      expect(fetched).toBe(false);
      expect(existsSync(target)).toBe(false);
    });
  }
  it("rejects changed network state before completing publication", async () => {
    let probes = 0;
    await expect(
      downloadAospVoiceAsset(asset, destination(), {
        preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
        probe: async () =>
          ++probes === 1
            ? allowed()
            : { connectionType: "wifi", metered: true },
        now: (() => {
          let clock = 0;
          return () => (clock += 1001);
        })(),
        fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      }),
    ).rejects.toThrow("allowed network");
    expect(probes).toBe(2);
  });
  it("rejects host loss during transfer", async () => {
    let probes = 0;
    await expect(
      downloadAospVoiceAsset(asset, destination(), {
        preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
        probe: async () => {
          if (++probes > 1) throw new Error("host unavailable");
          return allowed();
        },
        now: (() => {
          let clock = 0;
          return () => (clock += 1001);
        })(),
        fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      }),
    ).rejects.toThrow("host unavailable");
  });
  for (const received of [
    Buffer.from("incomplete"),
    Buffer.alloc(bytes.length),
    Buffer.alloc(bytes.length + 1),
  ]) {
    it(`rejects corrupt or incorrectly sized bytes (${received.length})`, async () => {
      await expect(
        downloadAospVoiceAsset(asset, destination(), {
          preferences: {
            ...DEFAULT_NETWORK_POLICY_PREFERENCES,
            quietHours: [],
          },
          probe: allowed,
          fetchImpl: (async () => new Response(received)) as typeof fetch,
        }),
      ).rejects.toThrow();
    });
  }
});

describe("pinned mobile voice bundle", () => {
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const allowedNetwork = {
    preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
    probe: allowed,
  };
  function bundleRoot() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aosp-voice-bundle-"));
    roots.push(dir);
    return dir;
  }
  function published(
    id: string,
    role: MobileVoiceFile["role"],
    filePath: string,
    data: Buffer,
  ): MobileVoiceFile {
    return {
      id,
      role,
      path: filePath,
      hfRepo: "fixture/repo",
      hfPath: path.posix.basename(filePath),
      url: `https://huggingface.co/fixture/repo/resolve/${"a".repeat(40)}/${path.posix.basename(filePath)}`,
      revision: "a".repeat(40),
      sha256: sha(data),
      bytes: data.length,
      license: "Apache-2.0",
      status: "published",
      source: { repo: "fixture/upstream", revision: "b".repeat(40) },
    };
  }
  function unpublished(
    id: string,
    role: MobileVoiceFile["role"],
    filePath: string,
  ): MobileVoiceFile {
    return {
      id,
      role,
      path: filePath,
      hfRepo: "elizaos/eliza-1",
      hfPath: `voice/paradee/${path.posix.basename(filePath)}`,
      url: null,
      revision: null,
      sha256: null,
      bytes: null,
      license: "Apache-2.0",
      status: "unpublished",
      localFrom: "fixture pins.json",
      source: { repo: "fixture/upstream", revision: "c".repeat(40) },
    };
  }

  it("pins every catalog row it would download and keeps ONNX out", () => {
    const files = aospVoiceFiles();
    expect(files.map((f) => f.role).sort()).toEqual(
      ["asr-mmproj", "asr-text", "g2p-lexicon", "tts", "vad"].sort(),
    );
    for (const file of files) {
      expect(file.path.toLowerCase()).not.toContain(".onnx");
      expect(file.path).not.toContain("kokoro");
      if (file.status === "published") {
        expect(isPublishedMobileVoiceFile(file)).toBe(true);
      } else {
        // Unpublished rows carry no URL or hash, so nothing can download them.
        expect(file.url).toBeNull();
        expect(file.sha256).toBeNull();
        expect(file.localFrom).toBeTruthy();
      }
    }
    for (const group of AOSP_VOICE_GROUPS) {
      expect(aospVoiceGroupFiles(group).length).toBe(group.roles.length);
    }
    const asr = files.filter((f) => f.role.startsWith("asr-"));
    expect(asr.map((f) => f.sha256).sort()).toEqual(
      [
        "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
        "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
      ].sort(),
    );
    const vad = files.find((f) => f.role === "vad");
    expect(vad?.sha256).toBe(
      "d348cd6d87ea53dcd3e6680698c88be326082e27dae899adef653d090bee4995",
    );
    expect(vad?.revision).toBe("1e4c73713e11f7ff42bc2a686cc5b178c8cac14f");
  });

  it("downloads a published group into place atomically with a record", async () => {
    const text = Buffer.from("asr text model");
    const proj = Buffer.from("asr projector");
    const files = [
      published("t", "asr-text", "asr/text.gguf", text),
      published("p", "asr-mmproj", "asr/mmproj.gguf", proj),
    ];
    const root = bundleRoot();
    const result = await stageAospVoiceGroup(
      root,
      { dir: "asr", roles: ["asr-text", "asr-mmproj"] },
      {
        ...allowedNetwork,
        files,
        fetchImpl: (async (url: string) =>
          new Response(
            String(url).endsWith("mmproj.gguf") ? proj : text,
          )) as unknown as typeof fetch,
      },
    );
    expect(result.status).toBe("staged");
    expect(readFileSync(path.join(root, "asr", "text.gguf"))).toEqual(text);
    expect(readFileSync(path.join(root, "asr", "mmproj.gguf"))).toEqual(proj);
    expect(existsSync(path.join(root, "asr.staging"))).toBe(false);
    const record = JSON.parse(
      readFileSync(path.join(root, "asr", AOSP_VOICE_RECORD), "utf8"),
    );
    expect(record.files.map((f: { origin: string }) => f.origin)).toEqual([
      "download",
      "download",
    ]);
  });

  it("removes staging and publishes nothing when a download is corrupt", async () => {
    const text = Buffer.from("asr text model");
    const files = [
      published("t", "asr-text", "asr/text.gguf", text),
      published("p", "asr-mmproj", "asr/mmproj.gguf", Buffer.from("proj")),
    ];
    const root = bundleRoot();
    await expect(
      stageAospVoiceGroup(
        root,
        { dir: "asr", roles: ["asr-text", "asr-mmproj"] },
        {
          ...allowedNetwork,
          files,
          fetchImpl: (async () =>
            new Response(text)) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow();
    expect(existsSync(path.join(root, "asr"))).toBe(false);
    expect(existsSync(path.join(root, "asr.staging"))).toBe(false);
  });

  it("never downloads an unpublished row and reports it unavailable", async () => {
    let fetched = false;
    const root = bundleRoot();
    const result = await stageAospVoiceGroup(
      root,
      { dir: "tts/paradee", roles: ["tts", "g2p-lexicon"] },
      {
        ...allowedNetwork,
        files: [
          unpublished("paradee", "tts", "tts/paradee/paradee.gguf"),
          unpublished("lexicon", "g2p-lexicon", "tts/paradee/misaki.lex"),
        ],
        fetchImpl: (async () => {
          fetched = true;
          return new Response("x");
        }) as unknown as typeof fetch,
      },
    );
    expect(result.status).toBe("unavailable");
    expect(fetched).toBe(false);
    expect(existsSync(path.join(root, "tts"))).toBe(false);
  });

  it("stages unpublished rows only from a local source that matches its pins", async () => {
    const gguf = Buffer.from("paradee gguf");
    const lex = Buffer.from("misaki lexicon");
    const source = bundleRoot();
    mkdirSync(path.join(source, "tts", "paradee"), { recursive: true });
    writeFileSync(path.join(source, "tts", "paradee", "paradee.gguf"), gguf);
    writeFileSync(path.join(source, "tts", "paradee", "misaki.lex"), lex);
    writeFileSync(
      path.join(source, "voice-pins.json"),
      JSON.stringify({
        paradee: { sha256: sha(gguf), bytes: gguf.length },
        lexicon: { sha256: sha(lex), bytes: lex.length },
      }),
    );
    const files = [
      unpublished("paradee", "tts", "tts/paradee/paradee.gguf"),
      unpublished("lexicon", "g2p-lexicon", "tts/paradee/misaki.lex"),
    ];
    const group = {
      dir: "tts/paradee",
      roles: ["tts", "g2p-lexicon"],
    } as const;
    const root = bundleRoot();
    const result = await stageAospVoiceGroup(root, group, {
      files,
      local: readAospVoiceLocalSource(source),
    });
    expect(result.status).toBe("staged");
    expect(
      readFileSync(path.join(root, "tts", "paradee", "paradee.gguf")),
    ).toEqual(gguf);
    // A second call leaves the published group alone.
    expect((await stageAospVoiceGroup(root, group, { files })).status).toBe(
      "present",
    );

    writeFileSync(
      path.join(source, "tts", "paradee", "misaki.lex"),
      "tampered",
    );
    const other = bundleRoot();
    await expect(
      stageAospVoiceGroup(other, group, {
        files,
        local: readAospVoiceLocalSource(source),
      }),
    ).rejects.toThrow("does not match its pin");
    expect(existsSync(path.join(other, "tts", "paradee"))).toBe(false);
  });

  it("rejects a local pin that disagrees with a published catalog pin", () => {
    const data = Buffer.from("vad");
    const file = published("vad", "vad", "vad/silero.gguf", data);
    expect(() =>
      expectedAospVoicePin(file, {
        dir: "/nowhere",
        pins: { vad: { sha256: "0".repeat(64), bytes: data.length } },
      }),
    ).toThrow("disagrees with the catalog");
  });
});
