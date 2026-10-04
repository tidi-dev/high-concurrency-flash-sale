import type { StateSnapshot } from '@flash/shared';
import { useState } from 'react';
import { patchConfig, post } from '../api';
import { ConfigNumber } from './ConfigInput';

type Notify = (msg: string, tone?: 'ok' | 'danger') => void;

function Experiment(props: { title: string; look: string; children: React.ReactNode; active?: boolean }) {
  return (
    <div className={`experiment ${props.active ? 'active' : ''}`}>
      <h4>{props.title}</h4>
      <div className="exp-controls">{props.children}</div>
      <p className="look">
        <b>Watch:</b> {props.look}
      </p>
    </div>
  );
}

export function FailureLab({ s, notify }: { s: StateSnapshot; notify: Notify }) {
  const c = s.config;
  const [overwrite, setOverwrite] = useState(false);
  const act = async (path: string, body: unknown, describe: (data: unknown) => string) => {
    const r = await post(path, body);
    notify(describe(r.data), r.status < 300 ? 'ok' : 'danger');
  };

  return (
    <section className="card">
      <h2>Failure lab</h2>
      <p className="explain">
        Redis makes <i>admission</i> atomic. It doesn't make a distributed system correct. Break things on purpose here, then check which
        invariant turns red and what repairs it.
      </p>
      <div className="experiments">
        <Experiment title="⏸ Pause / slow the worker" look="Requests still get 202 instantly; queue depth grows; PostgreSQL lags behind Redis. Pay returns NOT_PERSISTED until the worker catches up." active={s.flash.queue.paused || c.workerDelayMs > 0}>
          {s.flash.queue.paused ? (
            <button className="btn" onClick={() => act('/admin/worker/resume', {}, () => 'Worker resumed')}>▶ Resume worker</button>
          ) : (
            <button className="btn" onClick={() => act('/admin/worker/pause', {}, () => 'Worker paused')}>⏸ Pause worker</button>
          )}
          <ConfigNumber name="workerDelayMs" type="range" min={0} max={2000} step={50} value={c.workerDelayMs} label={(v) => <>Slow worker: <b>{v} ms/job</b></>} />
        </Experiment>

        <Experiment title="📨 Duplicate delivery" look="“duplicates ignored” rises, orders don't. Switch idempotency to BROKEN and the conservation invariant breaks: stock disappears." active={c.duplicateDelivery || c.workerIdempotency === 'broken'}>
          <label className="check">
            <input type="checkbox" checked={c.duplicateDelivery} onChange={(e) => patchConfig({ duplicateDelivery: e.target.checked })} /> API publishes every message twice
          </label>
          <button className="btn" onClick={() => act('/admin/duplicate-delivery', { count: 10 }, (d) => `Re-delivered ${(d as { enqueued: number }).enqueued} messages`)}>
            ↻ Re-deliver last 10 messages
          </button>
          <label>
            Worker idempotency
            <select value={c.workerIdempotency} onChange={(e) => patchConfig({ workerIdempotency: e.target.value as 'transactional' | 'broken' })}>
              <option value="transactional">transactional (correct)</option>
              <option value="broken">broken (side effect outside guard)</option>
            </select>
          </label>
        </Experiment>

        <Experiment title="💥 API crash after Redis reservation" look="Some buyers get 500. Redis is lower than PostgreSQL; “every admitted reservation has a queue message” turns red: leaked units. Reconcile gives them back." active={c.crashAfterReservePercent > 0}>
          <ConfigNumber name="crashAfterReservePercent" type="range" min={0} max={100} step={5} value={c.crashAfterReservePercent} label={(v) => <>Crash rate: <b>{v}%</b> of admitted requests</>} />
        </Experiment>

        <Experiment title="🧹 Reconcile" look="Orphaned reservations (older than 5s, no queue job, never confirmed) are released back to Redis. Optionally rebuild the Redis stock from PostgreSQL (only when idle).">
          <label className="check">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> also overwrite Redis stock from DB
          </label>
          <button
            className="btn"
            onClick={() =>
              act('/admin/reconcile', { overwriteStock: overwrite }, (d) => {
                const r = d as { orphansReleased: number; skippedInQueue: number; redriven: number; driftBefore: number; driftAfter: number; note: string; message?: string };
                if (r.message) return r.message;
                return `Released ${r.orphansReleased} orphan(s), re-drove ${r.redriven}, skipped ${r.skippedInQueue} still queued; drift ${r.driftBefore} → ${r.driftAfter}. ${r.note}`;
              })
            }
          >
            🧹 Run reconcile
          </button>
        </Experiment>

        <Experiment title="🔥 Redis loses its data" look="Stock, reservation records AND the BullMQ queue vanish. Re-seed from the initial value: Redis re-admits sold units and the worker REJECTS them. Re-seed from DB: correct, but queued buyers are lost.">
          <div className="row gap wrap">
            <button className="btn btn-danger" onClick={() => act('/admin/redis-crash', { reseed: 'initial' }, (d) => `Redis wiped (${JSON.stringify(d)}); re-seeded from INITIAL stock`)}>
              Wipe + re-seed from initial
            </button>
            <button className="btn" onClick={() => act('/admin/redis-crash', { reseed: 'db' }, (d) => `Redis wiped (${JSON.stringify(d)}); re-seeded from PostgreSQL`)}>
              Wipe + re-seed from DB
            </button>
            <button className="btn" onClick={() => act('/admin/redis-crash', { reseed: 'none' }, () => 'Redis wiped; stock key missing')}>
              Wipe, no re-seed
            </button>
          </div>
        </Experiment>

        <Experiment title="⏱ Reservation lifecycle" look="Expired reservations return their unit to PostgreSQL and then to Redis, exactly once. Paid ones never do.">
          <div className="row gap wrap">
            <button className="btn" onClick={() => act('/flash-sale/pay-random', { percent: 50 }, (d) => `Paid ${(d as { paid: number }).paid} of ${(d as { attempted: number }).attempted} chosen reservations`)}>
              💳 Pay 50% of active
            </button>
            <button className="btn" onClick={() => act('/flash-sale/expire-due', {}, (d) => `Sweep: ${JSON.stringify(d)}`)}>⏱ Run expiry sweep now</button>
          </div>
        </Experiment>
      </div>
    </section>
  );
}
