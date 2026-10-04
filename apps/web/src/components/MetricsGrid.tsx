import type { StateSnapshot } from '@flash/shared';
import { fmt, ms } from '../format';

/** The "live metrics" board for Mode B. Facts (from PostgreSQL / Redis) are marked as such. */
export function MetricsGrid({ s }: { s: StateSnapshot }) {
  const f = s.flash;
  const run = f.lastRun;
  const items: [string, string, string?][] = [
    ['Total requests', fmt(f.metrics.requests), 'counter'],
    ['Allowed', fmt(f.metrics.allowed), 'counter'],
    ['Sold out', fmt(f.metrics.soldOut), 'counter'],
    ['Orders created', fmt(f.db.ordersTotal), 'PostgreSQL'],
    ['Reservations', fmt(f.db.reserved), 'PostgreSQL · active'],
    ['Paid', fmt(f.db.paid), 'PostgreSQL'],
    ['Expired', fmt(f.db.expired), 'PostgreSQL'],
    ['Queue depth', fmt(f.queue.waiting + f.queue.active + f.queue.delayed), 'BullMQ'],
    ['Redis stock', f.redis.stock === null ? 'missing' : fmt(f.redis.stock), 'Redis'],
    ['DB stock', fmt(f.product?.dbStock), 'PostgreSQL'],
    ['Errors', fmt(f.metrics.errors + f.metrics.enqueueFailed), 'counter'],
    ['Average latency', ms(run?.latency.avg), 'last run'],
    ['P95 latency', ms(run?.latency.p95), 'last run'],
    ['P99 latency', ms(run?.latency.p99), 'last run'],
  ];
  return (
    <section className="card">
      <h2>Live metrics (Mode B)</h2>
      <p className="explain small">
        <b>Counters</b> are observations the code records as it goes. They can drift after crashes. <b>PostgreSQL</b> and <b>Redis</b>{' '}
        values are read directly from the stores: those are the facts.
      </p>
      <div className="metrics">
        {items.map(([label, value, src]) => (
          <div key={label} className="metric">
            <div className="metric-label">{label}</div>
            <div className="metric-value">{value}</div>
            <div className="metric-src">{src}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
