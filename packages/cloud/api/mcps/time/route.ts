/**
 * GET /api/mcps/time
 * Metadata endpoint for Time & Date MCP server.
 */

import {
  BUILTIN_MCP_PRICING,
  MCP_FREE_COST_LABEL,
} from "@elizaos/cloud-shared/billing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json({
    name: "Time & Date MCP",
    version: "2.0.0",
    description:
      "Real-time date/time utilities with timezone conversion, formatting, and calculations using native JavaScript Intl APIs.",
    transport: ["http", "sse"],
    endpoint: "/api/mcps/time/mcp",
    tools: [
      {
        name: "get_current_time",
        description: "Get current date and time in any timezone",
        price: MCP_FREE_COST_LABEL,
        example: { timezone: "America/New_York", format: "all" },
      },
    ],
    payment: {
      protocol: "free",
      ...BUILTIN_MCP_PRICING.time,
    },
    features: [
      "Accurate timezone handling via IANA database",
      "Timezone aliases (PST, EST, JST, etc.)",
      "Unix timestamp conversions",
    ],
    status: "live",
  }),
);

export default app;
