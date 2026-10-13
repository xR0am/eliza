import { afterEach, expect, spyOn, test } from "bun:test";
import { xTwitterAdsProvider } from "./x-twitter";

process.env.X_ADS_CONSUMER_KEY = "consumer-key";
process.env.X_ADS_CONSUMER_SECRET = "consumer-secret";
const credentials = { accessToken: "access-token", refreshToken: "token-secret" };
const DAY_MS = 24 * 60 * 60 * 1000;

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Every stats request answers one window with 2.50 spent and 100 impressions. */
function captureStatsRequests(): URL[] {
  const urls: URL[] = [];
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(new URL(String(input)));
      return Response.json({
        data: [
          {
            id: "li-1",
            id_data: [
              {
                metrics: {
                  impressions: [100],
                  clicks: [4],
                  billed_charge_local_micro: [2_500_000],
                },
              },
            ],
          },
        ],
      });
    }),
  );
  return urls;
}

function window(url: URL): { start: Date; end: Date } {
  return {
    start: new Date(url.searchParams.get("start_time") ?? ""),
    end: new Date(url.searchParams.get("end_time") ?? ""),
  };
}

function isWholeHour(date: Date): boolean {
  return (
    date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0
  );
}

test("a short range is sent as one window on whole hours, end exclusive", async () => {
  const urls = captureStatsRequests();

  const result = await xTwitterAdsProvider.getCampaignMetrics(credentials, "acct-1/c-1/li-1", {
    start: new Date("2026-10-01T10:17:33.000Z"),
    end: new Date("2026-10-03T08:05:00.000Z"),
  });

  expect(result.success).toBe(true);
  expect(urls).toHaveLength(1);
  expect(urls[0]?.searchParams.get("start_time")).toBe("2026-10-01T10:00:00Z");
  expect(urls[0]?.searchParams.get("end_time")).toBe("2026-10-03T09:00:00Z");
  expect(urls[0]?.searchParams.get("granularity")).toBe("TOTAL");
});

test("a lifetime range is split into contiguous windows of at most seven days and summed", async () => {
  const urls = captureStatsRequests();
  const start = new Date("2026-06-01T00:00:00.000Z");
  const end = new Date("2026-10-13T00:00:00.000Z"); // 134 days -> 20 windows

  const result = await xTwitterAdsProvider.getCampaignMetrics(credentials, "acct-1/c-1/li-1", {
    start,
    end,
  });

  expect(urls).toHaveLength(20);
  const windows = urls.map(window);
  expect(windows[0]?.start).toEqual(start);
  expect(windows.at(-1)?.end).toEqual(end);
  for (const [index, { start: from, end: to }] of windows.entries()) {
    expect(isWholeHour(from)).toBe(true);
    expect(isWholeHour(to)).toBe(true);
    expect(to.getTime() - from.getTime()).toBeLessThanOrEqual(7 * DAY_MS);
    expect(to.getTime()).toBeGreaterThan(from.getTime());
    if (index > 0) expect(from).toEqual(windows[index - 1]?.end);
  }
  expect(result).toEqual({
    success: true,
    metrics: {
      spend: 50,
      impressions: 2000,
      clicks: 80,
      conversions: 0,
      ctr: 4,
      cpc: 50 / 80,
      cpm: (50 / 2000) * 1000,
    },
  });
});

test("without a range the adapter reads the last seven days on whole hours", async () => {
  const urls = captureStatsRequests();
  const before = Date.now();

  await xTwitterAdsProvider.getCampaignMetrics(credentials, "acct-1/c-1/li-1");

  expect(urls).toHaveLength(1);
  const { start, end } = window(urls[0] as URL);
  expect(isWholeHour(start)).toBe(true);
  expect(isWholeHour(end)).toBe(true);
  expect(end.getTime() - start.getTime()).toBe(7 * DAY_MS);
  expect(end.getTime()).toBeGreaterThanOrEqual(before - (before % (60 * 60 * 1000)));
});
