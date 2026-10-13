import { expect, test } from "bun:test";
import { calculateSpendCredits } from "./types";

test("credits for a campaign budget are the amount the ledger stores (two decimals)", () => {
  // numeric(12,2) stores 0.63 for 0.627; charge and stored allocation must agree.
  expect(calculateSpendCredits("meta", 0.57)).toBe(0.63);
  expect(calculateSpendCredits("meta", 0.5681818181818182)).toBe(0.63);
  expect(calculateSpendCredits("meta", 12.345)).toBe(13.58);
  expect(calculateSpendCredits("meta", 10)).toBe(11);
});

test("the same budget always maps to the same credits, so an unchanged budget has no delta", () => {
  const stored = Number(String(calculateSpendCredits("google", 0.5681818181818182)));
  expect(calculateSpendCredits("google", 0.5681818181818182) - stored).toBe(0);
});
