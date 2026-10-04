import type { LoadRunResult } from '@flash/shared';
import { fmt, ms } from '../format';

export function LastRun({ run }: { run: LoadRunResult | null }) {
  if (!run) return <p className="muted small">No load run yet. Press “Run” above.</p>;
  return (
    <div className="lastrun">
      <div className="lastrun-head">
        Last run: <b>{fmt(run.users)}</b> requests, {fmt(run.concurrency)} connections, {fmt(run.durationMs)} ms ({fmt(run.throughputRps)} req/s)
      </div>
      <div className="lat-grid">
        <div><span>avg</span><b>{ms(run.latency.avg)}</b></div>
        <div><span>p50</span><b>{ms(run.latency.p50)}</b></div>
        <div><span>p95</span><b>{ms(run.latency.p95)}</b></div>
        <div><span>p99</span><b>{ms(run.latency.p99)}</b></div>
        <div><span>max</span><b>{ms(run.latency.max)}</b></div>
      </div>
      <div className="outcomes">
        {Object.entries(run.outcomes).map(([k, v]) => (
          <span key={k} className={`chip chip-${k}`}>{k}: {fmt(v)}</span>
        ))}
        {run.errors > 0 && <span className="chip chip-error">errors: {fmt(run.errors)}</span>}
      </div>
    </div>
  );
}
