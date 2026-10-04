import type { DemoConfig, StateSnapshot } from '@flash/shared';
import { useState } from 'react';
import { patchConfig, post } from '../api';
import { fmt } from '../format';
import { ConfigNumber } from './ConfigInput';

const PRESETS = [100, 500, 1000, 10000];

export function ControlPanel({ s, notify }: { s: StateSnapshot; notify: (msg: string, tone?: 'ok' | 'danger') => void }) {
  const [users, setUsers] = useState(1000);
  const [connections, setConnections] = useState(100);
  const [initialStock, setInitialStock] = useState(s.flash.product?.initialStock ?? 500);
  const sim = s.simulation;
  const running = !!sim?.running;

  const set = async (patch: Partial<DemoConfig>) => {
    await patchConfig(patch);
  };
  const run = async (mode: 'naive' | 'flash') => {
    const r = await post('/simulations', { mode, users, concurrency: connections });
    if (r.status >= 400) notify((r.data as { message?: string })?.message ?? 'Could not start', 'danger');
  };
  const reset = async () => {
    const r = await post('/reset', { initialStock });
    notify(r.status < 300 ? `Reset: ${fmt(initialStock)} units for both modes` : 'Reset refused (is a run in progress?)', r.status < 300 ? 'ok' : 'danger');
  };

  return (
    <section className="card controls">
      <div className="control-group">
        <h3>1 · Set up the sale</h3>
        <label>
          Initial stock
          <input type="number" min={1} value={initialStock} onChange={(e) => setInitialStock(Number(e.target.value))} />
        </label>
        <button className="btn" onClick={reset} disabled={running}>
          ↺ Reset demo
        </button>
        <p className="hint">Wipes orders, reservations, Redis keys and the queue.</p>
      </div>

      <div className="control-group">
        <h3>2 · Send buyers</h3>
        <div className="label">Concurrent users (requests)</div>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p} className={`chip-btn ${users === p ? 'active' : ''}`} onClick={() => setUsers(p)}>
              {fmt(p)}
            </button>
          ))}
          <input type="number" className="narrow" min={1} max={50000} value={users} onChange={(e) => setUsers(Number(e.target.value))} />
        </div>
        <label>
          In-flight connections
          <input type="number" min={1} max={1000} value={connections} onChange={(e) => setConnections(Number(e.target.value))} />
        </label>
        <div className="row gap">
          <button className="btn btn-danger" onClick={() => run('naive')} disabled={running}>
            ▶ Run naive test (A)
          </button>
          <button className="btn btn-primary" onClick={() => run('flash')} disabled={running}>
            ▶ Run Redis test (B)
          </button>
        </div>
        {sim && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round((sim.completed / sim.users) * 100)}%` }} />
            <span>
              {sim.running ? 'Running' : 'Finished'} {sim.mode === 'naive' ? 'A' : 'B'}: {fmt(sim.completed)} / {fmt(sim.users)}
            </span>
          </div>
        )}
        <p className="hint">2,000,000 real users won't fit on a laptop. A few hundred in-flight requests already show every race.</p>
      </div>

      <div className="control-group">
        <h3>3 · Knobs</h3>
        <label>
          Mode A variant
          <select value={s.config.naiveVariant} onChange={(e) => set({ naiveVariant: e.target.value as DemoConfig['naiveVariant'] })}>
            <option value="check-then-act">check-then-act (unsafe)</option>
            <option value="lost-update">lost-update (unsafe, hides it)</option>
            <option value="atomic">atomic conditional UPDATE (safe)</option>
          </select>
        </label>
        <ConfigNumber name="naiveDelayMs" type="range" min={0} max={100} value={s.config.naiveDelayMs} label={(v) => <>Artificial DB delay (between SELECT and UPDATE): <b>{v} ms</b></>} />
        <label>
          Mode B reserve strategy
          <select value={s.config.reserveStrategy} onChange={(e) => set({ reserveStrategy: e.target.value as DemoConfig['reserveStrategy'] })}>
            <option value="lua">Lua: check-and-reserve (never negative)</option>
            <option value="decr">DECR, INCR back if negative (interview answer)</option>
          </select>
        </label>
        <ConfigNumber name="reservationTtlSec" type="number" min={1} max={3600} value={s.config.reservationTtlSec} label={() => 'Reservation TTL (seconds, for new reservations)'} />
      </div>
    </section>
  );
}
