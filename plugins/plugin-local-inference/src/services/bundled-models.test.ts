/**
 * Covers reading the bundled-model manifest next to the model files.
 *
 * A missing manifest is normal on Capacitor / desktop / non-AOSP installs and
 * must stay a silent zero. A manifest that is present but unreadable or
 * corrupt is a broken staging step, and reporting it as "no bundled models"
 * hides every model the APK actually shipped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBundledModels } from "./bundled-models";

const originalEnv = { ...process.env };

beforeEach(() => {
	process.env.ELIZA_STATE_DIR = fs.mkdtempSync(
		path.join(os.tmpdir(), "eliza-bundled-models-"),
	);
});

afterEach(() => {
	process.env = { ...originalEnv };
});

function manifestPath(): string {
	return path.join(
		process.env.ELIZA_STATE_DIR as string,
		"local-inference",
		"models",
		"manifest.json",
	);
}

function writeManifest(raw: string): void {
	fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
	fs.writeFileSync(manifestPath(), raw);
}

describe("bundled model manifest", () => {
	it("treats a missing manifest as no bundled models", async () => {
		await expect(registerBundledModels()).resolves.toBe(0);
	});

	it("surfaces a truncated manifest instead of reporting zero bundled models", async () => {
		writeManifest('{"version":1,"models":[{"id":"eliza-1-2b"');
		await expect(registerBundledModels()).rejects.toThrow(
			/bundled model manifest/i,
		);
	});

	it("surfaces a manifest that is present but not a v1 model list", async () => {
		writeManifest(JSON.stringify({ version: 2, models: [] }));
		await expect(registerBundledModels()).rejects.toThrow(
			/bundled model manifest/i,
		);
	});
});
