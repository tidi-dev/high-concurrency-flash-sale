import type { StateSnapshot } from '@flash/shared';
import { fmt } from '../format';
import type { Rates } from '../useStream';
import { Invariants } from './Invariants';
import { LastRun } from './LastRun';
import { Flow, Node, Stat } from './Pipeline';

export function FlashPanel({ s, rates }: { s: StateSnapshot; rates: Rates }) {
  const f = s.flash;
  const m = f.metrics;
  const depth = f.queue.waiting + f.queue.active + f.queue.delayed;
  const redisNegative = f.redis.minObservedStock !== null && f.redis.minObservedStock < 0;
  return (
    <section className="card mode mode-b">
      <header className="mode-head">
        <div>
          <div className="eyebrow">Mode B</div>
          <h2>Redis reservation + queue</h2>
        </div>
        <span className="pill pill-ok">strategy: {s.config.reserveStrategy === 'lua' ? 'Lua check-and-reserve' : 'DECR / INCR-back'}</span>
      </header>
      <p className="explain">
        Redis decides <i>who may buy</i> in about a millisecond. Only admitted requests become queue messages, and a worker writes them to
        PostgreSQL at its own pace. Reservations expire after <b>{s.config.reservationTtlSec}s</b> unless paid.
      </p>

      <div className="pipeline">
        <Node icon="👥" title="Users" subtitle="POST /api/flash-sale/buy" pulseOn={m.requests}>
          <Stat label="requests" value={fmt(m.requests)} />
        </Node>
        <Flow rate={rates.flashRequests} />
        <Node icon="🟩" title="NestJS API" subtitle="no database access" pulseOn={m.allowed + m.soldOut}>
          <Stat label="allowed (202)" value={fmt(m.allowed)} tone="ok" />
          <Stat label="sold out (409)" value={fmt(m.soldOut)} />
          {m.alreadyReserved > 0 && <Stat label="already reserved (409)" value={fmt(m.alreadyReserved)} />}
          {m.enqueueFailed > 0 && <Stat label="crashed after reserve (500)" value={fmt(m.enqueueFailed)} tone="danger" />}
          <Stat label="errors" value={fmt(m.errors)} tone={m.errors ? 'danger' : undefined} />
        </Node>
        <Flow rate={rates.flashRequests} label="atomic reserve" />
        <Node
          icon="🧮"
          title="Redis"
          subtitle={s.config.reserveStrategy === 'lua' ? 'EVALSHA reserve.lua' : 'DECR (INCR back if < 0)'}
          pulseOn={f.redis.stock}
          tone={f.redis.stock === null ? 'danger' : 'normal'}
        >
          <div className="bignums">
            <div>
              <span>stock</span>
              <b className={f.redis.stock !== null && f.redis.stock < 0 ? 't-danger' : ''}>{f.redis.stock === null ? 'missing' : fmt(f.redis.stock)}</b>
            </div>
            <div>
              <span>pending</span>
              <b>{fmt(f.redis.pending)}</b>
            </div>
          </div>
          {s.config.reserveStrategy === 'decr' && <Stat label="DECR went negative → INCR back" value={fmt(m.compensations)} />}
          {redisNegative && <Stat label="lowest value DECR returned" value={fmt(f.redis.minObservedStock)} tone="warn" />}
        </Node>
        <Flow rate={rates.queued} label="enqueue" />
        <Node
          icon="📬"
          title="Queue (BullMQ)"
          subtitle="absorbs the burst"
          pulseOn={depth}
          tone={f.queue.paused ? 'warn' : 'normal'}
          badge={f.queue.paused ? <span className="pill pill-warn">PAUSED</span> : null}
        >
          <div className="bignums">
            <div>
              <span>depth</span>
              <b>{fmt(depth)}</b>
            </div>
          </div>
          <Stat label="waiting / active" value={`${fmt(f.queue.waiting)} / ${fmt(f.queue.active)}`} />
          <Stat label="failed" value={fmt(f.queue.failed)} tone={f.queue.failed ? 'danger' : undefined} />
        </Node>
        <Flow rate={rates.persisted} label="consume" />
        <Node
          icon="⚙️"
          title="Worker"
          subtitle={`${s.config.workerIdempotency === 'broken' ? 'BROKEN idempotency' : 'idempotent'}${s.config.workerDelayMs ? `, +${s.config.workerDelayMs}ms/job` : ''}`}
          pulseOn={m.persisted + m.duplicatesIgnored + m.rejected}
          tone={s.config.workerIdempotency === 'broken' ? 'danger' : 'normal'}
        >
          <Stat label="orders created" value={fmt(m.persisted)} tone="ok" />
          <Stat label="duplicates ignored" value={fmt(m.duplicatesIgnored)} />
          <Stat label="rejected by DB guard" value={fmt(m.rejected)} tone={m.rejected ? 'warn' : undefined} />
          {m.staleDropped > 0 && <Stat label="stale (old sale) fenced out" value={fmt(m.staleDropped)} tone="warn" />}
          {m.redriven > 0 && <Stat label="re-driven by reconciler" value={fmt(m.redriven)} tone="warn" />}
        </Node>
        <Flow rate={rates.persisted} />
        <Node icon="🐘" title="PostgreSQL" subtitle="source of truth" pulseOn={f.product?.dbStock}>
          <div className="bignums">
            <div>
              <span>DB stock</span>
              <b className={f.product && f.product.dbStock < 0 ? 't-danger' : ''}>{fmt(f.product?.dbStock)}</b>
            </div>
            <div>
              <span>reserved</span>
              <b>{fmt(f.db.reserved)}</b>
            </div>
            <div>
              <span>paid</span>
              <b className="t-ok">{fmt(f.db.paid)}</b>
            </div>
            <div>
              <span>expired</span>
              <b>{fmt(f.db.expired)}</b>
            </div>
          </div>
          {f.db.rejected > 0 && <Stat label="rejected" value={fmt(f.db.rejected)} tone="warn" />}
        </Node>
      </div>

      <h3>Invariants</h3>
      <Invariants items={f.invariants} />
      <h3>Latency (client side)</h3>
      <LastRun run={f.lastRun} />
    </section>
  );
}
