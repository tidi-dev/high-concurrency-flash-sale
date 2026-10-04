import type { LatencyStats } from '@flash/shared';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Nearest-rank percentile: the smallest sample such that at least p% of samples are <= it. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(samples: number[]): LatencyStats {
  if (samples.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    avg: round2(sum / samples.length),
    p50: round2(percentile(samples, 50)),
    p95: round2(percentile(samples, 95)),
    p99: round2(percentile(samples, 99)),
    max: round2(Math.max(...samples)),
  };
}
