// A tiny load generator, shared by the dashboard ("Run Test" buttons) and the CLI (npm run load:*).
// It fires `users` POST requests with at most `concurrency` in flight, one unique userId each,
// and measures the latency of every request from the client's point of view.
import type { LoadRunResult, Mode } from '@flash/shared';
import { performance } from 'node:perf_hooks';
import { Pool } from 'undici';
import { summarize } from './stats';

export interface LoadOptions {
  baseUrl: string;
  mode: Mode;
  users: number;
  concurrency: number;
  runId?: string;
  onProgress?: (completed: number) => void;
}

export const BUY_PATH: Record<Mode, string> = { naive: '/api/naive/buy', flash: '/api/flash-sale/buy' };

export async function runLoad(o: LoadOptions): Promise<LoadRunResult> {
  const runId = o.runId ?? `${o.mode}-${Date.now().toString(36)}`;
  const concurrency = Math.max(1, Math.min(o.concurrency, o.users));
  const pool = new Pool(o.baseUrl, { connections: concurrency, keepAliveTimeout: 10_000, headersTimeout: 120_000, bodyTimeout: 120_000 });
  const latencies: number[] = [];
  const outcomes: Record<string, number> = {};
  let errors = 0;
  let next = 0;
  let completed = 0;

  const startedAt = Date.now();
  const t0 = performance.now();
  const lane = async () => {
    while (next < o.users) {
      const i = next++;
      const body = JSON.stringify({ userId: `${runId}-u${i}` });
      const start = performance.now();
      let outcome: string;
      try {
        const res = await pool.request({ path: BUY_PATH[o.mode], method: 'POST', headers: { 'content-type': 'application/json' }, body });
        const json = (await res.body.json().catch(() => ({}))) as { status?: string };
        outcome = typeof json.status === 'string' ? json.status : `HTTP_${res.statusCode}`;
        if (res.statusCode >= 500) errors++;
      } catch (err) {
        outcome = 'NETWORK_ERROR';
        errors++;
      }
      latencies.push(performance.now() - start);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      completed++;
      if (completed % 50 === 0) o.onProgress?.(completed);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  const durationMs = performance.now() - t0;
  o.onProgress?.(completed);
  await pool.close();

  return {
    runId,
    mode: o.mode,
    users: o.users,
    concurrency,
    startedAt,
    finishedAt: Date.now(),
    durationMs: Math.round(durationMs),
    throughputRps: Math.round((o.users / durationMs) * 1000),
    outcomes,
    errors,
    latency: summarize(latencies),
  };
}
