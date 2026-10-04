import { useCallback, useState } from 'react';
import { StoryMode } from './components/StoryMode';
import { ControlPanel } from './components/ControlPanel';
import { EventStream } from './components/EventStream';
import { FailureLab } from './components/FailureLab';
import { FlashPanel } from './components/FlashPanel';
import { MetricsGrid } from './components/MetricsGrid';
import { NaivePanel } from './components/NaivePanel';
import { TryIt } from './components/TryIt';
import { useStream } from './useStream';

interface Toast {
  id: number;
  msg: string;
  tone: 'ok' | 'danger';
}

type Tab = 'story' | 'lab';

function initialTab(): Tab {
  try {
    return localStorage.getItem('tab') === 'lab' ? 'lab' : 'story';
  } catch {
    return 'story';
  }
}

export function App() {
  const { snapshot: s, events, connected, rates } = useStream();
  const [tab, setTabState] = useState<Tab>(initialTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem('tab', t);
    } catch {
      // storage unavailable: the tab just won't be remembered
    }
  };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((msg: string, tone: 'ok' | 'danger' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }].slice(-4));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>⚡ Flash Sale Lab</h1>
          <p className="tagline">
            500 sneakers, a crowd of buyers, one database. Watch the naive checkout oversell, then watch Redis + a queue + idempotent
            workers hold the line, and see exactly where they don't.
          </p>
        </div>
        <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? '● live' : '○ disconnected'}</span>
      </header>

      <nav className="tabs">
        <button className={tab === 'story' ? 'active' : ''} onClick={() => setTab('story')}>
          🎬 Story mode <small>for everyone</small>
        </button>
        <button className={tab === 'lab' ? 'active' : ''} onClick={() => setTab('lab')}>
          🔬 Lab <small>full-scale, technical</small>
        </button>
      </nav>

      {!s ? (
        <div className="card">Connecting to the API… (is it running on :3000?)</div>
      ) : tab === 'story' ? (
        <StoryMode events={events} notify={notify} />
      ) : !s.flash.product ? (
        <div className="card">
          <ControlPanel s={s} notify={notify} />
          <p>No sale yet. Press <b>Reset demo</b> to create the products.</p>
        </div>
      ) : (
        <>
          <ControlPanel s={s} notify={notify} />
          <div className="modes">
            <NaivePanel s={s} rates={rates} />
            <FlashPanel s={s} rates={rates} />
          </div>
          <MetricsGrid s={s} />
          <FailureLab s={s} notify={notify} />
          <div className="split">
            <TryIt notify={notify} />
            <EventStream events={events} />
          </div>
          <footer className="foot">
            Educational demo. Read <code>docs/01-problem.md</code> → <code>docs/09-interview-answer.md</code> for the why behind every box.
          </footer>
        </>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
