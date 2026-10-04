import type { StateSnapshot } from '@flash/shared';
import { fmt } from '../format';
import type { Rates } from '../useStream';
import { Invariants } from './Invariants';
import { LastRun } from './LastRun';
import { Flow, Node, Stat } from './Pipeline';

const VARIANT_TEXT: Record<string, string> = {
  'check-then-act': 'SELECT stock → if > 0 → (delay) → UPDATE stock = stock − 1 → INSERT order',
  'lost-update': 'SELECT stock → if > 0 → (delay) → UPDATE stock = <value read> − 1 → INSERT order',
  atomic: 'BEGIN; UPDATE … SET stock = stock − 1 WHERE stock > 0; INSERT order; COMMIT',
};

export function NaivePanel({ s, rates }: { s: StateSnapshot; rates: Rates }) {
  const n = s.naive;
  const unsafe = s.config.naiveVariant !== 'atomic';
  return (
    <section className="card mode mode-a">
      <header className="mode-head">
        <div>
          <div className="eyebrow">Mode A</div>
          <h2>Naive PostgreSQL checkout</h2>
        </div>
        <span className={`pill ${unsafe ? 'pill-danger' : 'pill-ok'}`}>{unsafe ? 'INTENTIONALLY UNSAFE' : 'safe (atomic SQL)'}</span>
      </header>
      <p className="explain">
        Every request goes straight to the database. <code>{VARIANT_TEXT[s.config.naiveVariant]}</code>
      </p>

      <div className="pipeline">
        <Node icon="👥" title="Users" subtitle="POST /api/naive/buy" pulseOn={n.metrics.requests}>
          <Stat label="requests" value={fmt(n.metrics.requests)} />
        </Node>
        <Flow rate={rates.naiveRequests} />
        <Node icon="🟥" title="NestJS API" subtitle="one DB round-trip per step" pulseOn={n.metrics.dbQueries}>
          <Stat label="orders created" value={fmt(n.metrics.success)} />
          <Stat label="sold out" value={fmt(n.metrics.soldOut)} />
          <Stat label="errors" value={fmt(n.metrics.errors)} tone={n.metrics.errors ? 'danger' : undefined} />
          <Stat label="DB queries" value={fmt(n.metrics.dbQueries)} />
          {unsafe && (
            <Stat
              label="in the race window now / peak"
              value={`${fmt(n.metrics.raceWindow)} / ${fmt(n.metrics.raceWindowPeak)}`}
              tone={n.metrics.raceWindowPeak > 1 ? 'warn' : undefined}
            />
          )}
        </Node>
        <Flow rate={rates.naiveRequests} />
        <Node icon="🐘" title="PostgreSQL" subtitle="one hot row: product.stock" pulseOn={n.product?.stock} tone={n.oversold > 0 ? 'danger' : 'normal'}>
          <div className="bignums">
            <div>
              <span>DB stock</span>
              <b className={n.product && n.product.stock < 0 ? 't-danger' : ''}>{fmt(n.product?.stock)}</b>
            </div>
            <div>
              <span>orders</span>
              <b>{fmt(n.orders)}</b>
            </div>
            <div>
              <span>oversold</span>
              <b className={n.oversold > 0 ? 't-danger' : 't-ok'}>{fmt(n.oversold)}</b>
            </div>
          </div>
        </Node>
      </div>

      {unsafe && n.metrics.raceWindowPeak > 1 && (
        <p className="callout danger">
          Up to <b>{fmt(n.metrics.raceWindowPeak)}</b> requests were between “read stock” and “write stock” at the same time. They all
          read the same stock value, so they all passed the check.
        </p>
      )}

      <h3>Invariants</h3>
      <Invariants items={n.invariants} />
      <h3>Latency (client side)</h3>
      <LastRun run={n.lastRun} />
    </section>
  );
}
