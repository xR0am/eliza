/**
 * A bridge whose toToken differs from the sent token also swaps into that
 * token. The confirmation key binds toToken, so the prompt the user says yes
 * to must name it. Real walletFinancialPreview and walletFinancialPendingKey.
 */
import { describe, expect, it } from "vitest";
import {
  walletFinancialPendingKey,
  walletFinancialPreview,
} from "./wallet-financial-confirmation";

const base = {
  subaction: "bridge",
  chain: "base",
  toChain: "arbitrum",
  amount: "1000",
  fromToken: "USDC",
  slippageBps: 300,
} as const;

describe("bridge confirmation", () => {
  it("names a different receive token", () => {
    const prompt = walletFinancialPreview({
      ...base,
      toToken: "0x1111111111111111111111111111111111111111",
    } as never);
    expect(prompt).toContain("as 0x1111111111111111111111111111111111111111");
  });

  it("shows different prompts for confirmations bound to different receive tokens", () => {
    const tokens = [
      undefined,
      "USDC",
      "0x1111111111111111111111111111111111111111",
    ];
    const keys = new Set(
      tokens.map((toToken) =>
        walletFinancialPendingKey({ ...base, toToken } as never),
      ),
    );
    const prompts = new Set(
      tokens
        .filter(
          (toToken) => toToken?.toLowerCase() !== base.fromToken.toLowerCase(),
        )
        .map((toToken) =>
          walletFinancialPreview({ ...base, toToken } as never),
        ),
    );
    // The same-token bridge reads the same with or without toToken; every
    // other bound receive token gets its own prompt.
    expect(keys.size).toBe(3);
    expect(prompts.size).toBe(2);
  });
});
