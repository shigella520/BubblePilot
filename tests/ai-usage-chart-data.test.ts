import { describe, expect, it } from "vitest";
import {
  activeUsageProviders,
  hasMetricData,
  usageChartData,
  type UsageMetrics,
  type UsagePoint,
} from "../apps/web/src/components/ai-usage-chart-data.js";

const emptyMetrics: UsageMetrics = {
  requestCount: 0,
  succeededRequestCount: 0,
  failedRequestCount: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedPromptTokens: null,
  cacheEligiblePromptTokens: 0,
  cacheHitRate: null,
  cacheDataCoverage: null,
};

const points: UsagePoint[] = [
  {
    bucketStart: "2026-08-11T00:00:00.000Z",
    providers: [
      {
        providerId: "active",
        ...emptyMetrics,
        requestCount: 1,
        totalTokens: 80,
      },
      { providerId: "idle", ...emptyMetrics },
    ],
  },
  {
    bucketStart: "2026-08-11T00:15:00.000Z",
    providers: [
      {
        providerId: "active",
        ...emptyMetrics,
        requestCount: 1,
        totalTokens: 100,
        cachedPromptTokens: 30,
        cacheEligiblePromptTokens: 60,
        cacheHitRate: 0.5,
        cacheDataCoverage: 1,
      },
      { providerId: "idle", ...emptyMetrics },
    ],
  },
];

const providers = [
  { id: "active", name: "Active", color: "#123456" },
  { id: "idle", name: "Idle", color: "#654321" },
];

describe("AI usage chart data", () => {
  it("keeps only providers with meaningful data for each metric", () => {
    expect(activeUsageProviders(providers, points, "totalTokens")).toEqual([
      providers[0],
    ]);
    expect(activeUsageProviders(providers, points, "cacheHitRate")).toEqual([
      providers[0],
    ]);
  });

  it("does not turn missing cache data into a zero-percent hit rate", () => {
    expect(hasMetricData(points[0]!.providers[0]!, "cacheHitRate")).toBe(false);
    expect(usageChartData([providers[0]!], points, "cacheHitRate")).toEqual([
      [1786406400, 1786407300],
      [null, 0.5],
    ]);
  });
});
