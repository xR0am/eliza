import { afterEach, expect, mock, spyOn, test } from "bun:test";

/**
 * The service's spend accounting reads a campaign's lifetime metrics; a
 * windowed analytics read must neither widen nor overwrite that figure.
 * Repositories are replaced by in-memory stubs; the service and the provider
 * contract are real.
 */
const campaign = {
  id: "campaign-1",
  organization_id: "org-1",
  ad_account_id: "account-1",
  external_campaign_id: "acct/ext-1",
  start_date: new Date("2026-06-01T00:00:00.000Z"),
  created_at: new Date("2026-05-28T12:00:00.000Z"),
  total_spend: "0.00",
  total_impressions: 0,
  total_clicks: 0,
  total_conversions: 0,
};
const updates: unknown[] = [];
mock.module("../../../db/repositories", () => ({
  adAccountsRepository: {
    findById: async () => ({ id: "account-1", platform: "meta", status: "active" }),
  },
  adCampaignsRepository: {
    findById: async () => campaign,
    updateMetrics: async (...args: unknown[]) => {
      updates.push(args);
    },
  },
  adConversionsRepository: {
    getCampaignRollup: async () => ({ conversions: 0, value: 0 }),
  },
  adAudienceSegmentsRepository: {},
  adCreativesRepository: {},
  adReportSharesRepository: {},
  adTransactionsRepository: {},
}));

const { advertisingService } = await import("./index");

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  updates.length = 0;
});

function stubProvider() {
  const ranges: Array<{ start: Date; end: Date } | undefined> = [];
  spies.push(
    spyOn(
      advertisingService as unknown as { getCredentials: () => Promise<unknown> },
      "getCredentials",
    ).mockResolvedValue({ accessToken: "fixture-token" }),
  );
  spies.push(
    spyOn(advertisingService, "getProvider").mockReturnValue({
      async getCampaignMetrics(
        _credentials: unknown,
        _id: string,
        dateRange?: { start: Date; end: Date },
      ) {
        ranges.push(dateRange);
        return {
          success: true,
          metrics: { spend: 42.5, impressions: 1000, clicks: 50, conversions: 3 },
        };
      },
    } as never),
  );
  return ranges;
}

test("a lifetime read asks the platform for the whole campaign and stores the totals", async () => {
  const ranges = stubProvider();
  const before = Date.now();

  const metrics = await advertisingService.getCampaignMetrics("campaign-1", "org-1");

  expect(metrics.spend).toBe(42.5);
  expect(ranges).toHaveLength(1);
  expect(ranges[0]?.start).toEqual(campaign.start_date);
  expect(ranges[0]?.end.getTime()).toBeGreaterThanOrEqual(before);
  expect(updates).toEqual([
    [
      "campaign-1",
      { totalSpend: "42.5", totalImpressions: 1000, totalClicks: 50, totalConversions: 3 },
    ],
  ]);
});

test("a windowed read passes the window through and leaves the stored totals alone", async () => {
  const ranges = stubProvider();
  const window = {
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-10-02T00:00:00.000Z"),
  };

  const metrics = await advertisingService.getCampaignMetrics("campaign-1", "org-1", window);

  expect(metrics.spend).toBe(42.5);
  expect(ranges).toEqual([window]);
  expect(updates).toEqual([]);
});
