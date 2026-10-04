import type { DemoEvent } from '@flash/shared';
import { useState } from 'react';

const TONE: Partial<Record<DemoEvent['type'], string>> = {
  RESERVATION_ALLOWED: 'ok',
  ORDER_CREATED: 'ok',
  PAYMENT_COMPLETED: 'ok',
  WAITLIST_OFFERED: 'ok',
  WAITLIST_JOINED: 'info',
  NAIVE_ORDER_CREATED: 'ok',
  SOLD_OUT: 'muted',
  NAIVE_SOLD_OUT: 'muted',
  ALREADY_RESERVED: 'muted',
  ORDER_QUEUED: 'info',
  RESERVATION_CONFIRMED: 'info',
  RESERVATION_EXPIRED: 'warn',
  STOCK_RELEASED: 'warn',
  ORPHAN_RELEASED: 'warn',
  DUPLICATE_MESSAGE_IGNORED: 'warn',
  RESERVATION_REJECTED: 'danger',
  ENQUEUE_FAILED: 'danger',
  STOCK_RELEASE_SKIPPED: 'danger',
  REDIS_DATA_LOST: 'danger',
  PAYMENT_REJECTED: 'danger',
};

const NOISE: DemoEvent['type'][] = ['SOLD_OUT', 'NAIVE_SOLD_OUT', 'ALREADY_RESERVED', 'NAIVE_STOCK_READ', 'WORKER_PICKED'];

export function EventStream({ events }: { events: DemoEvent[] }) {
  const [hideNoise, setHideNoise] = useState(true);
  const shown = hideNoise ? events.filter((e) => !NOISE.includes(e.type)) : events;
  return (
    <section className="card">
      <div className="row between">
        <h2>Event stream</h2>
        <label className="small">
          <input type="checkbox" checked={hideNoise} onChange={(e) => setHideNoise(e.target.checked)} /> hide high-volume noise
        </label>
      </div>
      <p className="explain small">
        The same structured events the API and worker log to stdout as JSON (latest 200 are kept in Redis). During a big run you only see a
        sample: there are far more events than fit here.
      </p>
      <div className="events">
        {shown.length === 0 && <div className="muted small">No events yet.</div>}
        {shown.map((e) => (
          <div key={e.seq} className={`event ev-${TONE[e.type] ?? 'info'}`}>
            <span className="ev-time">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
            <span className="ev-type">{e.type}</span>
            <span className="ev-mode">{e.mode}</span>
            <span className="ev-detail">
              {e.reservationId && <code title={e.reservationId}>{e.reservationId.slice(0, 8)}</code>} {e.userId && <span className="muted">{e.userId}</span>}{' '}
              {e.detail}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
