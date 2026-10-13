import { afterEach, expect, spyOn, test } from "bun:test";
import { redditAdsProvider } from "./reddit";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** The documented `POST /ad_accounts/{id}/reports` response: `data` is a Report, metrics in microcurrency. */
const documentedReport = {
  data: {
    metrics: [
      {
        campaign_id: "c1",
        spend: 12_340_000,
        impressions: 5000,
        clicks: 120,
        key_conversion_total_count: 7,
      },
      {
        campaign_id: "c1",
        spend: 1_000_000,
        impressions: 1000,
        clicks: 30,
        key_conversion_total_count: 1,
      },
    ],
    metrics_updated_at: "2026-10-13T11:00:00Z",
  },
  pagination: { page_size: 100 },
};

test("reads the documented report envelope and converts microcurrency spend", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  spies.push(
    spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(documentedReport);
    }),
  );

  const result = await redditAdsProvider.getCampaignMetrics(
    { accessToken: "fixture-token" },
    "acct-1/c1",
  );

  expect(result).toEqual({
    success: true,
    metrics: {
      spend: 13.34,
      impressions: 6000,
      clicks: 150,
      conversions: 8,
      ctr: 2.5,
      cpc: 13.34 / 150,
      cpm: (13.34 / 6000) * 1000,
    },
  });
  // Every requested field is one Reddit accepts; `CONVERSIONS` is not one.
  const request = bodies[0] as { data: { fields: string[] } };
  expect(request.data.fields).toEqual([
    "SPEND",
    "IMPRESSIONS",
    "CLICKS",
    "KEY_CONVERSION_TOTAL_COUNT",
  ]);
});
