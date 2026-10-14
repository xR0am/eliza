import { expect, test } from "vitest";
import { normalizeCharacterMessageExamples } from "../src/utils/character-message-examples";

test("example JSON excludes trailing prose brackets and keeps quoted brackets", () => {
	const records = [{ role: "user", content: 'Hello [world] "quoted"' }];
	const expected = normalizeCharacterMessageExamples(records);
	for (const value of [records, { messageExamples: records }]) {
		expect(
			normalizeCharacterMessageExamples(
				`Examples: ${JSON.stringify(value)} Note: [keep] {these}`,
			),
		).toEqual(expected);
	}
});
