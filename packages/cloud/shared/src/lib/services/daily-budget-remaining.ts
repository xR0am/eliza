/**
 * A stored daily limit of 0 is a cap of $0. A missing limit is not a cap.
 * `limit ? limit - spent` treated 0 as "no daily limit".
 */
export function dailyBudgetRemaining(
  rawLimit: unknown,
  rawSpent: unknown,
): {
  dailyLimit: number | null;
  dailySpent: number;
  dailyRemaining: number | null;
} {
  let dailyLimit: number | null = null;
  if (rawLimit !== null && rawLimit !== undefined && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (Number.isFinite(parsed) && parsed >= 0) dailyLimit = parsed;
  }
  const spentParsed = Number(rawSpent);
  const dailySpent = Number.isFinite(spentParsed) ? spentParsed : 0;
  return {
    dailyLimit,
    dailySpent,
    dailyRemaining: dailyLimit === null ? null : dailyLimit - dailySpent,
  };
}
