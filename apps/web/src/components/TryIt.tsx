import type { BuyResponse, ReservationView } from '@flash/shared';
import { useEffect, useState } from 'react';
import { api, post } from '../api';

function Countdown({ until }: { until: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!until) return null;
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return <span className={`countdown ${left === 0 ? 'zero' : left < 10 ? 'low' : ''}`}>{left}s</span>;
}

function StatusChip({ status }: { status: string }) {
  return <span className={`status status-${status}`}>{status}</span>;
}

export function TryIt({ notify }: { notify: (msg: string, tone?: 'ok' | 'danger') => void }) {
  const [userId, setUserId] = useState(`me-${Math.random().toString(36).slice(2, 6)}`);
  const [last, setLast] = useState<{ code: number; body: BuyResponse } | null>(null);
  const [inspect, setInspect] = useState<ReservationView | null>(null);
  const [recent, setRecent] = useState<ReservationView[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const r = await api<ReservationView[]>('/flash-sale/reservations?limit=12');
      if (alive && r.status === 200) setRecent(r.data);
    };
    void load();
    const t = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const buy = async () => {
    const r = await post<BuyResponse>('/flash-sale/buy', { userId });
    setLast({ code: r.status, body: r.data });
    if (r.data.reservationId) void doInspect(r.data.reservationId);
  };
  const doInspect = async (id: string) => {
    const r = await api<ReservationView>(`/flash-sale/reservations/${id}`);
    setInspect(r.status === 200 ? r.data : null);
  };
  const pay = async (id: string) => {
    const r = await post<{ code: string; message: string }>(`/flash-sale/reservations/${id}/pay`);
    notify(`${r.status} ${r.data.code}: ${r.data.message}`, r.status === 200 ? 'ok' : 'danger');
    void doInspect(id);
  };
  const expire = async (id: string) => {
    const r = await post<{ expired: boolean; reason?: string; redis?: string }>(`/flash-sale/reservations/${id}/expire`);
    notify(r.data.expired ? `Expired; Redis release: ${r.data.redis}` : `Not expired: ${r.data.reason}`, r.data.expired ? 'ok' : 'danger');
    void doInspect(id);
  };

  return (
    <section className="card">
      <h2>Try it yourself (Mode B)</h2>
      <p className="explain">Be one buyer. Reserve, then pay before the countdown ends, or let it expire and watch the stock come back.</p>
      <div className="row gap wrap">
        <label className="inline">
          userId <input value={userId} onChange={(e) => setUserId(e.target.value)} />
        </label>
        <button className="btn btn-primary" onClick={buy}>
          🛒 Buy
        </button>
      </div>

      {last && (
        <div className={`response ${last.code < 300 ? 'ok' : 'bad'}`}>
          <div>
            <code>HTTP {last.code}</code> <b>{last.body.status}</b>: {last.body.message}{' '}
            {last.body.expiresAt &&
              (inspect && inspect.id === last.body.reservationId && inspect.status !== 'RESERVED' ? (
                <StatusChip status={inspect.status} />
              ) : (
                <Countdown until={last.body.expiresAt} />
              ))}
          </div>
          {last.body.reservationId && (
            <div className="row gap">
              <button className="btn" onClick={() => pay(last.body.reservationId!)}>💳 Pay</button>
              <button className="btn" onClick={() => expire(last.body.reservationId!)}>⏱ Expire now</button>
              <button className="btn" onClick={() => doInspect(last.body.reservationId!)}>🔍 Inspect</button>
            </div>
          )}
        </div>
      )}

      {inspect && (
        <div className="inspect">
          <div>
            <h4>Reservation {inspect.id.slice(0, 8)}… <StatusChip status={inspect.status} /></h4>
            <p className="small">
              {inspect.persisted ? 'Persisted in PostgreSQL' : 'Only in Redis so far (worker has not written it yet)'}
              {inspect.order && <> · order <StatusChip status={inspect.order.status} /></>}
            </p>
          </div>
          <div className="two">
            <div>
              <div className="label">Redis hash</div>
              <pre>{inspect.redis ? JSON.stringify(inspect.redis, null, 2) : '(expired from Redis or never there)'}</pre>
            </div>
            <div>
              <div className="label">PostgreSQL row</div>
              <pre>{inspect.persisted ? JSON.stringify({ status: inspect.status, expiresAt: inspect.expiresAt && new Date(inspect.expiresAt).toISOString(), paidAt: inspect.paidAt && new Date(inspect.paidAt).toISOString(), order: inspect.order }, null, 2) : '(no row yet)'}</pre>
            </div>
          </div>
        </div>
      )}

      <h3>Most recent reservations (PostgreSQL)</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>user</th>
              <th>status</th>
              <th>order</th>
              <th>expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  none yet
                </td>
              </tr>
            )}
            {recent.map((r) => (
              <tr key={r.id}>
                <td><code>{r.id.slice(0, 6)}</code></td>
                <td className="ellipsis">{r.userId}</td>
                <td><StatusChip status={r.status} /></td>
                <td>{r.order && <StatusChip status={r.order.status} />}</td>
                <td>{r.status === 'RESERVED' && <Countdown until={r.expiresAt} />}</td>
                <td className="actions">
                  {r.status === 'RESERVED' && (
                    <>
                      <button className="btn btn-xs" onClick={() => pay(r.id)}>pay</button>
                      <button className="btn btn-xs" onClick={() => expire(r.id)}>expire</button>
                    </>
                  )}
                  <button className="btn btn-xs" onClick={() => doInspect(r.id)}>🔍</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
