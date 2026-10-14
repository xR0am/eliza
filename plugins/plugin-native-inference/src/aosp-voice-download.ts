/**
 * Staging of the pinned Android/AOSP voice bundle into an agent bundle root.
 *
 * The rows come from the `mobile-voice` entry of
 * `model-catalog/voice-model-versions.json`: Paradee-8M TTS with its misaki
 * lexicon (`tts/paradee/`), the Qwen3-ASR-0.6B text + mmproj pair (`asr/`) and
 * Silero VAD (`vad/`). Every file runs on libelizainference; nothing here is
 * ONNX.
 *
 * Each group is staged into `<dir>.staging/`, verified (size + sha256), and
 * published with one rename, so a reader sees the whole group or nothing.
 * An existing group is reused only after its files match their pins.
 *
 * Published rows download from their pinned Hugging Face revision through the
 * AOSP network admission check. Unpublished rows (Paradee GGUF and lexicon
 * until the owner publishes them) are never downloaded: they can only be
 * copied from a local source directory, checked against pins supplied with
 * that directory.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type AospNetworkAdmissionOptions,
  createAospNetworkAdmissionCheck,
} from "./aosp-network-admission.js";
import {
  isPublishedMobileVoiceFile,
  type MobileVoiceFile,
  type MobileVoiceFileRole,
  mobileVoiceBundle,
} from "./model-catalog/voice-models.js";
import { downloadHttpModel } from "./shared/http-model-download.js";

export interface AospVoiceGroup {
  /** Directory relative to the bundle root. */
  readonly dir: string;
  readonly roles: ReadonlyArray<MobileVoiceFileRole>;
}

/** Staging order: the voice the user hears first, then VAD, then the 1 GB ASR pair. */
export const AOSP_VOICE_GROUPS: ReadonlyArray<AospVoiceGroup> = [
  { dir: "tts/paradee", roles: ["tts", "g2p-lexicon"] },
  { dir: "vad", roles: ["vad"] },
  { dir: "asr", roles: ["asr-text", "asr-mmproj"] },
];

/** Name of the per-group record written next to the staged files. */
export const AOSP_VOICE_RECORD = "voice-files.json";

export function aospVoiceFiles(): ReadonlyArray<MobileVoiceFile> {
  return mobileVoiceBundle().files;
}

export function aospVoiceGroupFiles(
  group: AospVoiceGroup,
  files: ReadonlyArray<MobileVoiceFile> = aospVoiceFiles(),
): MobileVoiceFile[] {
  const out = files.filter((file) => group.roles.includes(file.role));
  for (const file of out) {
    if (path.posix.dirname(file.path) !== group.dir) {
      throw new Error(
        `[aosp-voice] ${file.id} path ${file.path} is outside group ${group.dir}`,
      );
    }
  }
  if (out.length !== group.roles.length) {
    throw new Error(
      `[aosp-voice] group ${group.dir} expects roles ${group.roles.join(", ")} but the catalog has ${out.map((f) => f.role).join(", ")}`,
    );
  }
  return out;
}

/** sha256 + byte length a local file must match. */
export interface AospVoicePin {
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * A directory laid out like the bundle (`tts/paradee/…`, `asr/…`, `vad/…`).
 * `pins` gives the expected sha256/bytes for unpublished rows, keyed by row
 * id (for example the values from the fork's `tools/paradee/pins.json`).
 * Published rows are always checked against the catalog pins; a local pin
 * that disagrees with the catalog is rejected.
 */
export interface AospVoiceLocalSource {
  readonly dir: string;
  readonly pins?: Readonly<Record<string, AospVoicePin>>;
}

/** Read `<dir>/voice-pins.json` ({ "<row id>": { sha256, bytes } }) when present. */
export function readAospVoiceLocalSource(dir: string): AospVoiceLocalSource {
  const pinsPath = path.join(dir, "voice-pins.json");
  if (!existsSync(pinsPath)) return { dir };
  const parsed = JSON.parse(readFileSync(pinsPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[aosp-voice] ${pinsPath} must be an object of pins`);
  }
  const pins: Record<string, AospVoicePin> = {};
  for (const [id, value] of Object.entries(parsed)) {
    const pin = value as Partial<AospVoicePin>;
    if (
      typeof pin?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(pin.sha256) ||
      typeof pin.bytes !== "number" ||
      !Number.isSafeInteger(pin.bytes) ||
      pin.bytes <= 0
    ) {
      throw new Error(`[aosp-voice] ${pinsPath}: invalid pin for ${id}`);
    }
    pins[id] = { sha256: pin.sha256, bytes: pin.bytes };
  }
  return { dir, pins };
}

/** The pin a file must match: the catalog for published rows, else the local pins. */
export function expectedAospVoicePin(
  file: MobileVoiceFile,
  local?: AospVoiceLocalSource,
): AospVoicePin | null {
  const localPin = local?.pins?.[file.id];
  if (isPublishedMobileVoiceFile(file)) {
    if (
      localPin &&
      (localPin.sha256 !== file.sha256 || localPin.bytes !== file.bytes)
    ) {
      throw new Error(
        `[aosp-voice] local pin for ${file.id} disagrees with the catalog`,
      );
    }
    return { sha256: file.sha256, bytes: file.bytes };
  }
  return localPin ?? null;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Verified files enter the caller-owned staging directory before its atomic bundle publication. */
export async function downloadAospVoiceAsset(
  asset: { url: string; sha256: string; sizeBytes: number },
  destination: string,
  options: AospNetworkAdmissionOptions & { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await downloadHttpModel({
    url: asset.url,
    stagingPath: `${destination}.part`,
    finalPath: destination,
    label: "Automatic voice artifact",
    expectedSizeBytes: asset.sizeBytes,
    expectedSha256: asset.sha256,
    checkAdmission: createAospNetworkAdmissionCheck(asset.sizeBytes, options),
    fetchImpl: options.fetchImpl,
  });
}

export type AospVoiceGroupResult =
  | { readonly status: "present"; readonly dir: string }
  | { readonly status: "staged"; readonly dir: string }
  | {
      readonly status: "unavailable";
      readonly dir: string;
      readonly reason: string;
    };

export interface StageAospVoiceGroupOptions
  extends AospNetworkAdmissionOptions {
  readonly local?: AospVoiceLocalSource;
  readonly fetchImpl?: typeof fetch;
  readonly files?: ReadonlyArray<MobileVoiceFile>;
  /** Removes a generated `*.staging` dir; the bootstrap passes its guarded remover. */
  readonly removeStaging?: (stagingDir: string) => void;
}

/**
 * Stage one group into `<bundleRoot>/<group.dir>`. Returns "present" when the
 * directory already exists and its files match their pins, "unavailable" when an unpublished row has no
 * local source (nothing is written), else downloads/copies every file into
 * `<dir>.staging`, verifies it, writes the record and renames the staging
 * directory into place.
 */
/** Existing files hashed in this process: path -> pin + stat signature. */
const verifiedExistingFiles = new Map<string, string>();

export async function stageAospVoiceGroup(
  bundleRoot: string,
  group: AospVoiceGroup,
  options: StageAospVoiceGroupOptions = {},
): Promise<AospVoiceGroupResult> {
  const finalDir = path.join(bundleRoot, group.dir);
  const files = aospVoiceGroupFiles(group, options.files);
  if (existsSync(finalDir)) {
    if (!lstatSync(finalDir).isDirectory()) {
      throw new Error(
        `[aosp-voice] existing group ${finalDir} is not a directory`,
      );
    }
    let recordedFiles: unknown[] | undefined;
    for (const file of files) {
      let pin = expectedAospVoicePin(file, options.local);
      if (!pin) {
        // Keep the originally authorized local pins when their source directory
        // is no longer attached. Published catalog pins always take precedence.
        if (!recordedFiles) {
          const record = JSON.parse(
            readFileSync(path.join(finalDir, AOSP_VOICE_RECORD), "utf8"),
          ) as {
            schema?: unknown;
            dir?: unknown;
            files?: unknown;
          } | null;
          if (
            record?.schema !== "eliza-mobile-voice-group-v1" ||
            record.dir !== group.dir ||
            !Array.isArray(record.files)
          ) {
            throw new Error(
              `[aosp-voice] existing group ${finalDir} has no valid pin record`,
            );
          }
          recordedFiles = record.files;
        }
        const matches = recordedFiles.filter(
          (row): row is Record<string, unknown> =>
            row !== null &&
            typeof row === "object" &&
            "id" in row &&
            row.id === file.id,
        );
        const row = matches[0];
        if (
          matches.length !== 1 ||
          !row ||
          row.role !== file.role ||
          row.path !== file.path ||
          typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.sha256) ||
          typeof row.bytes !== "number" ||
          !Number.isSafeInteger(row.bytes) ||
          row.bytes <= 0
        ) {
          throw new Error(
            `[aosp-voice] existing ${file.id} has no valid recorded pin`,
          );
        }
        pin = { sha256: row.sha256, bytes: row.bytes };
      }
      const target = path.join(finalDir, path.posix.basename(file.path));
      const stat = lstatSync(target, { bigint: true });
      // The bootstrap re-runs this for every group whenever any group is
      // missing (and on each TTS request until tts/paradee/ lands), so a
      // file already hashed in this process is not re-hashed (the ASR pair is
      // ~1 GB) unless its inode, size, mtime or ctime changed.
      const signature = `${pin.sha256}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (verifiedExistingFiles.get(target) === signature) continue;
      verifiedExistingFiles.delete(target);
      if (
        !stat.isFile() ||
        stat.size !== BigInt(pin.bytes) ||
        (await sha256File(target)) !== pin.sha256
      ) {
        throw new Error(
          `[aosp-voice] existing ${file.id} does not match its pin`,
        );
      }
      verifiedExistingFiles.set(target, signature);
    }
    return { status: "present", dir: finalDir };
  }
  const plan: Array<{
    file: MobileVoiceFile;
    pin: AospVoicePin;
    localPath: string | null;
  }> = [];
  for (const file of files) {
    const pin = expectedAospVoicePin(file, options.local);
    const candidate = options.local
      ? path.join(options.local.dir, file.path)
      : null;
    const localPath =
      candidate && existsSync(candidate) && lstatSync(candidate).isFile()
        ? candidate
        : null;
    if (!pin) {
      return {
        status: "unavailable",
        dir: finalDir,
        reason: `${file.id} is unpublished and no pinned local copy was supplied (${file.localFrom ?? "owner publish pending"})`,
      };
    }
    if (!localPath && !isPublishedMobileVoiceFile(file)) {
      return {
        status: "unavailable",
        dir: finalDir,
        reason: `${file.id} is unpublished and missing from the local source`,
      };
    }
    plan.push({ file, pin, localPath });
  }
  const stagingDir = `${finalDir}.staging`;
  const removeStaging =
    options.removeStaging ??
    ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  removeStaging(stagingDir);
  mkdirSync(stagingDir, { recursive: true });
  try {
    const record: Array<Record<string, unknown>> = [];
    for (const { file, pin, localPath } of plan) {
      const target = path.join(stagingDir, path.posix.basename(file.path));
      if (localPath) {
        copyFileSync(localPath, target);
        const bytes = lstatSync(target).size;
        const sha256 = await sha256File(target);
        if (bytes !== pin.bytes || sha256 !== pin.sha256) {
          throw new Error(
            `[aosp-voice] local ${file.id} does not match its pin (bytes ${bytes}/${pin.bytes}, sha256 ${sha256})`,
          );
        }
      } else if (isPublishedMobileVoiceFile(file)) {
        await downloadAospVoiceAsset(
          { url: file.url, sha256: file.sha256, sizeBytes: file.bytes },
          target,
          options,
        );
      }
      record.push({
        id: file.id,
        role: file.role,
        path: file.path,
        sha256: pin.sha256,
        bytes: pin.bytes,
        license: file.license,
        origin: localPath ? "local" : "download",
        status: file.status,
        revision: file.revision,
      });
    }
    writeFileSync(
      path.join(stagingDir, AOSP_VOICE_RECORD),
      `${JSON.stringify({ schema: "eliza-mobile-voice-group-v1", dir: group.dir, files: record }, null, 2)}\n`,
    );
    mkdirSync(path.dirname(finalDir), { recursive: true });
    renameSync(stagingDir, finalDir);
    return { status: "staged", dir: finalDir };
  } catch (err) {
    removeStaging(stagingDir);
    throw err;
  }
}

/** Absolute paths of the Paradee files inside a staged `tts/paradee/` group. */
export function aospParadeePaths(bundleRoot: string): {
  dir: string;
  gguf: string;
  lexicon: string;
} {
  const group = AOSP_VOICE_GROUPS[0] as AospVoiceGroup;
  const files = aospVoiceGroupFiles(group);
  const dir = path.join(bundleRoot, group.dir);
  const byRole = (role: MobileVoiceFileRole) => {
    const file = files.find((f) => f.role === role);
    if (!file) throw new Error(`[aosp-voice] no ${role} row`);
    return path.join(dir, path.posix.basename(file.path));
  };
  return { dir, gguf: byRole("tts"), lexicon: byRole("g2p-lexicon") };
}
