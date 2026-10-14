import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PHONON_ASR_ASSETS, selectHostAsrAssets } from "./host-asr-assets";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function bundle(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "host-asr-assets-"));
	roots.push(root);
	mkdirSync(join(root, "asr"), { recursive: true });
	for (const file of files) writeFileSync(join(root, file), "x");
	return root;
}

const phonon = "asr/phonon-2-fv5.gguf";
const retiredPair = ["asr/eliza-1-asr.gguf", "asr/eliza-1-asr-mmproj.gguf"];

describe("host ASR asset selection", () => {
	it("selects the pinned Phonon-2 GGUF", () => {
		const assets = selectHostAsrAssets(bundle([phonon]), {});
		expect(assets).toBe(PHONON_ASR_ASSETS);
		expect(assets[0]?.sha256).toBe(
			"dc552eb786486167dde3ac80bbe49a6088c8ef39c03c257d5a090fc57b2c47b3",
		);
		expect(assets[0]?.bytes).toBe(330_632_256);
		expect(
			selectHostAsrAssets(bundle([phonon]), { ELIZA_ASR_BACKEND: "auto" }),
		).toBe(PHONON_ASR_ASSETS);
		expect(
			selectHostAsrAssets(bundle([phonon]), {
				ELIZA_ASR_BACKEND: " Parakeet ",
			}),
		).toBe(PHONON_ASR_ASSETS);
	});

	it("refuses a bundle that has no Phonon-2 GGUF", () => {
		// The retired text + mmproj pair is not a fallback.
		expect(() => selectHostAsrAssets(bundle(retiredPair), {})).toThrow(
			"Ambiguous speech ASR model",
		);
		expect(() => selectHostAsrAssets(bundle([]), {})).toThrow(
			"Ambiguous speech ASR model",
		);
	});

	it("refuses an ELIZA_ASR_BACKEND other than parakeet", () => {
		for (const value of ["qwen3", "mtmd", "whisper"]) {
			expect(() =>
				selectHostAsrAssets(bundle([phonon]), { ELIZA_ASR_BACKEND: value }),
			).toThrow("Invalid speech ASR backend");
		}
	});

	it("refuses an asr/ directory with GGUFs it did not verify", () => {
		expect(() =>
			selectHostAsrAssets(bundle([phonon, ...retiredPair]), {}),
		).toThrow("Ambiguous speech ASR model");
		const root = bundle([phonon]);
		mkdirSync(join(root, "asr", "nested"));
		writeFileSync(join(root, "asr", "nested", "other.gguf"), "x");
		expect(() => selectHostAsrAssets(root, {})).toThrow(
			"Ambiguous speech ASR model",
		);
	});
});
