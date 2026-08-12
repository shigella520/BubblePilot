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

export interface UsageTooltipPosition {
  left: number;
  top: number;
}

export function usageTooltipPosition(input: {
  anchorX: number;
  anchorY: number;
  tooltipWidth: number;
  tooltipHeight: number;
  boundaryWidth: number;
  boundaryHeight: number;
  gap?: number;
  padding?: number;
}): UsageTooltipPosition {
  const gap = input.gap ?? 10;
  const padding = input.padding ?? 8;
  const maximumLeft = Math.max(
    padding,
    input.boundaryWidth - input.tooltipWidth - padding,
  );
  const maximumTop = Math.max(
    padding,
    input.boundaryHeight - input.tooltipHeight - padding,
  );
  const right = input.anchorX + gap;
  const left = input.anchorX - input.tooltipWidth - gap;
  const above = input.anchorY - input.tooltipHeight - gap;
  const below = input.anchorY + gap;
  return {
    left: Math.min(
      maximumLeft,
      Math.max(
        padding,
        right + input.tooltipWidth <= input.boundaryWidth - padding
          ? right
          : left,
      ),
    ),
    top: Math.min(
      maximumTop,
      Math.max(padding, above >= padding ? above : below),
    ),
  };
}

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
