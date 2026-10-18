/**
 * `sanitizeSpeechText` drops roleplay stage directions (`*sighs*`) but must
 * speak markdown emphasis. Model replies bold and italicize the words that
 * matter most, such as the setting to open or the option to pick.
 */

import { describe, expect, it } from "vitest";
import { sanitizeSpeechText } from "../src/spoken-text";

describe("sanitizeSpeechText star spans", () => {
	it("speaks bold and italic words", () => {
		expect(
			sanitizeSpeechText("Step 1: open **Settings**, then tap **Privacy**."),
		).toBe("Step 1: open Settings, then tap Privacy.");
		expect(sanitizeSpeechText("Your options are: **A** or **B**.")).toBe(
			"Your options are: A or B.",
		);
		expect(sanitizeSpeechText("I *love* it")).toBe("I love it");
	});

	it("still drops stage directions", () => {
		expect(sanitizeSpeechText("*sighs* Fine, I will do it.")).toBe(
			"Fine, I will do it.",
		);
		expect(sanitizeSpeechText("Hello *waves* friend")).toBe("Hello friend");
		expect(sanitizeSpeechText("**laughs** okay")).toBe("okay");
	});
});
