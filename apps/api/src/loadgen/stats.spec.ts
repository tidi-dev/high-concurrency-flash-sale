import { summarize, percentile } from './stats';

describe('latency stats', () => {
  it('returns zeros for no samples', () => {
    expect(summarize([])).toEqual({ count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });

  it('handles a single sample', () => {
    expect(summarize([7])).toEqual({ count: 1, avg: 7, p50: 7, p95: 7, p99: 7, max: 7 });
  });

  it('computes nearest-rank percentiles on 1..100', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i); // unsorted input
    const s = summarize(samples);
    expect(s.count).toBe(100);
    expect(s.avg).toBe(50.5);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(s.max).toBe(100);
  });

  it('percentile does not mutate its input', () => {
    const input = [3, 1, 2];
    percentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });

  it('rounds to 2 decimals', () => {
    expect(summarize([1, 2, 2]).avg).toBe(1.67);
  });
});
