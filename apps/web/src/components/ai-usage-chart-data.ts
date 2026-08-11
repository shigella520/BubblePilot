export interface UsageMetrics {
  requestCount: number;
  succeededRequestCount: number;
  failedRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number | null;
  cacheEligiblePromptTokens: number;
  cacheHitRate: number | null;
  cacheDataCoverage: number | null;
}

export interface UsagePoint {
  bucketStart: string;
  providers: Array<{ providerId: string } & UsageMetrics>;
}

export interface UsageProvider {
  id: string;
  name: string;
  color: string;
}

export type UsageMetric = "totalTokens" | "requestCount" | "cacheHitRate";

export function metricValue(
  metrics: UsageMetrics,
  metric: UsageMetric,
): number | null {
  return metrics[metric];
}

export function hasMetricData(
  metrics: UsageMetrics,
  metric: UsageMetric,
): boolean {
  return metric === "cacheHitRate"
    ? metrics.cacheHitRate !== null
    : metrics.requestCount > 0;
}

export function activeUsageProviders(
  providers: UsageProvider[],
  points: UsagePoint[],
  metric: UsageMetric,
): UsageProvider[] {
  return providers.filter((provider) =>
    points.some((point) => {
      const metrics = point.providers.find(
        (item) => item.providerId === provider.id,
      );
      return metrics !== undefined && hasMetricData(metrics, metric);
    }),
  );
}

export function usageChartData(
  providers: UsageProvider[],
  points: UsagePoint[],
  metric: UsageMetric,
): Array<number[] | Array<number | null>> {
  const timestamps = points.map(
    (point) => Date.parse(point.bucketStart) / 1_000,
  );
  const values = providers.map((provider) =>
    points.map((point) => {
      const metrics = point.providers.find(
        (item) => item.providerId === provider.id,
      );
      return metrics === undefined ? null : metricValue(metrics, metric);
    }),
  );
  return [timestamps, ...values];
}
