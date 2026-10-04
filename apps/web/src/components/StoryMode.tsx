import type { DemoEvent, Mode, StoryRun, StorySpeed } from '@flash/shared';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { post } from '../api';

const AVATARS = ['🧑', '👩', '👨', '🧓', '👧', '🧔', '👩‍🦱', '👨‍🦰', '👱‍♀️', '🧑‍🦱', '👵', '👦', '👩‍🦳', '🧑‍🦲', '👨‍🦳', '👱'];

type Stage =
  | 'door'
  | 'looked'
  | 'ordered'
  | 'soldout'
  | 'ticket'
  | 'queued'
  | 'processing'
  | 'saved'
  | 'rejected'
  | 'waiting' // on the waitlist
  | 'offered' // a returned sneaker is held for them
  | 'paid'
  | 'walked'; // didn't pay in time
type Playback = 'auto' | 'step';

interface Shopper {
  id: string;
  n: number;
  avatar: string;
  stage: Stage;
  /** Shop A: the stock value this shopper saw on the shelf. */
  seen?: number;
  /** Which sneaker (1..stock) this shopper's order is for. A waitlisted shopper inherits the walk-away's. */
  orderNo?: number;
  /** Place on the waitlist (1 = next to get a returned sneaker). */
  waitPos?: number;
  /** Walk-away: the waitlisted shopper their sneaker was handed to. */
  handedTo?: string;
}

/**
 * One step of the story: the whole scene as it was right after one shopper did one thing.
 * Every frame carries its own numbers, so going back in time shows the counts as they were.
 */
interface Frame {
  shoppers: Record<string, Shopper>;
  /** Shop A: the shelf count. Shop B: tickets left at the desk. */
  count: number;
  /** Shop A: orders written. Shop B: active orders in the order book. */
  orders: number;
  /** Shop B: sneakers numbered so far (never reused). */
  issued: number;
  /** Shop B: paid orders. */
  paid: number;
  caption: string;
  /** The shopper this step is about (highlighted). */
  focus?: string;
}

const STAGE_FROM_EVENT: Partial<Record<DemoEvent['type'], Stage>> = {
  NAIVE_STOCK_READ: 'looked',
  NAIVE_ORDER_CREATED: 'ordered',
  NAIVE_SOLD_OUT: 'soldout',
  RESERVATION_ALLOWED: 'ticket',
  SOLD_OUT: 'soldout',
  ORDER_QUEUED: 'queued',
  WORKER_PICKED: 'processing',
  ORDER_CREATED: 'saved',
  RESERVATION_REJECTED: 'rejected',
  WAITLIST_JOINED: 'waiting',
  WAITLIST_OFFERED: 'offered',
  PAYMENT_COMPLETED: 'paid',
  RESERVATION_EXPIRED: 'walked',
};

// Which moves are allowed from each stage. Anything else is ignored, so a shopper never moves backwards
// (e.g. the worker can report "picked" before the API reports "queued").
const NEXT: Record<Stage, Stage[]> = {
  door: ['looked', 'ordered', 'soldout', 'ticket'],
  looked: ['ordered'],
  ordered: [],
  ticket: ['queued', 'processing', 'saved', 'rejected'],
  queued: ['processing', 'saved', 'rejected'],
  processing: ['saved', 'rejected'],
  saved: ['paid', 'walked'],
  soldout: ['waiting'],
  waiting: ['offered'],
  offered: ['queued', 'processing', 'saved', 'rejected'],
  paid: [],
  walked: [],
  rejected: [],
};

const STEP_MS: Record<StorySpeed, number> = { slow: 1100, 'very-slow': 1900 };

const num = (re: RegExp, text?: string): number | undefined => {
  const m = re.exec(text ?? '');
  return m ? Number(m[1]) : undefined;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Applies one real event to the previous frame. Returns null if it doesn't change the picture. */
function nextFrame(prev: Frame, e: DemoEvent): Frame | null {
  const cur = prev.shoppers[e.userId ?? ''];
  const stage = STAGE_FROM_EVENT[e.type];
  if (!cur || !stage || !NEXT[cur.stage].includes(stage)) return null;
  const p: Shopper = { ...cur, stage };
  const name = `${cur.avatar} Shopper ${cur.n}`;
  const shoppers = { ...prev.shoppers };
  let { count, orders, issued, paid } = prev;
  let caption: string;

  switch (e.type) {
    case 'NAIVE_STOCK_READ':
      p.seen = num(/saw (-?\d+)/, e.detail);
      caption = `${name} checks the shelf and sees ${plural(p.seen ?? 0, 'sneaker')}. "Yes, in stock!" But the order isn't written yet: there's a pause first.`;
      break;
    case 'NAIVE_ORDER_CREATED': {
      orders += 1;
      p.orderNo = orders;
      count = num(/stock now (-?\d+)/, e.detail) ?? count - 1;
      caption =
        count >= 0
          ? `${name}'s order is written, and the shelf count drops to ${count}.`
          : `${name}'s order is written, and the shelf count drops to ${count}. This customer paid for a sneaker that doesn't exist!`;
      break;
    }
    case 'NAIVE_SOLD_OUT':
      caption = `${name} sees an empty shelf and leaves.`;
      break;
    case 'RESERVATION_ALLOWED':
      count = num(/(-?\d+) left/, e.detail) ?? Math.max(0, count - 1);
      caption = `${name} gets a ticket from the desk, instantly. ${plural(count, 'ticket')} left.`;
      break;
    case 'SOLD_OUT':
      count = 0;
      caption = `${name} asks for a ticket, but none are left. The answer "sold out" comes instantly.`;
      break;
    case 'ORDER_QUEUED':
      caption = `${name} joins the waiting line. The paperwork happens in the back; nobody has to wait at the desk.`;
      break;
    case 'WORKER_PICKED':
      caption = `The clerk picks up ${name}'s ticket and starts writing the order.`;
      break;
    case 'ORDER_CREATED':
      orders += 1;
      if (p.orderNo === undefined) p.orderNo = ++issued; // a waitlisted shopper keeps the sneaker number they inherited
      caption = `${name}'s order is now in the official order book (sneaker #${p.orderNo}). Waiting for payment…`;
      break;
    case 'WAITLIST_JOINED':
      p.waitPos = num(/#(\d+)/, e.detail);
      caption = `${name} was told "sold out", so they join the waitlist: #${p.waitPos} in line. If a sneaker comes back, it will be held for them.`;
      break;
    case 'PAYMENT_COMPLETED':
      paid += 1;
      caption = `${name} pays. Sneaker #${p.orderNo} is theirs. ✅`;
      break;
    case 'RESERVATION_EXPIRED':
      orders -= 1;
      caption = `${name} walks away without paying, and their time runs out. Sneaker #${p.orderNo} is free again… who gets it?`;
      break;
    case 'WAITLIST_OFFERED': {
      // The sneaker comes from the most recent walk-away whose sneaker hasn't been handed on yet.
      const giver = Object.values(shoppers).find((x) => x.stage === 'walked' && !x.handedTo);
      if (giver) {
        shoppers[giver.id] = { ...giver, handedTo: p.id };
        p.orderNo = giver.orderNo;
      }
      p.waitPos = undefined;
      for (const x of Object.values(shoppers)) if (x.stage === 'waiting' && x.waitPos) shoppers[x.id] = { ...x, waitPos: x.waitPos - 1 };
      caption = `Not whoever clicks fastest: the sneaker goes straight to ${name}, #1 on the waitlist. They get a notification: "a sneaker came back, it's held for you!"`;
      break;
    }
    default:
      caption = `${name}'s ticket was refused by the order book.`;
  }
  shoppers[p.id] = p;
  return { shoppers, count, orders, issued, paid, caption, focus: p.id };
}

function firstFrame(run: StoryRun): Frame {
  const shoppers = Object.fromEntries(
    run.shoppers.map((id, i) => [id, { id, n: i + 1, avatar: AVATARS[i % AVATARS.length], stage: 'door' as Stage }]),
  );
  return {
    shoppers,
    count: run.stock,
    orders: 0,
    issued: 0,
    paid: 0,
    caption: `The doors open: ${run.shoppers.length} shoppers want ${run.stock} sneakers. Press Next ▶ (or Play) to follow them.`,
  };
}

export function StoryMode({ events, notify }: { events: DemoEvent[]; notify: (m: string, t?: 'ok' | 'danger') => void }) {
  const [speed, setSpeed] = useState<StorySpeed>('slow');
  const [playback, setPlayback] = useState<Playback>('auto');
  const [run, setRun] = useState<StoryRun | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Event sequence numbers restart when a story resets the demo, so track what we've applied per run.
  const processed = useRef(new Set<number>());

  const start = async (m: Mode) => {
    const r = await post<StoryRun & { message?: string }>('/story', { mode: m, shoppers: 10, stock: 5, speed });
    if (r.status >= 300) {
      notify(r.data.message ?? 'Could not start', 'danger');
      return;
    }
    processed.current = new Set();
    setFrames([firstFrame(r.data)]);
    setIndex(0);
    setPlaying(playback === 'auto');
    setRun(r.data);
  };

  // Record every real event for this run's shoppers as a new step.
  useEffect(() => {
    if (!run) return;
    const prefix = `story-${run.runId}-`;
    const fresh = events
      .filter((e) => e.userId?.startsWith(prefix) && STAGE_FROM_EVENT[e.type] && !processed.current.has(e.seq))
      .sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return;
    for (const e of fresh) processed.current.add(e.seq);
    setFrames((prev) => {
      const out = [...prev];
      for (const e of fresh) {
        const f = nextFrame(out[out.length - 1], e);
        if (f) out.push(f);
      }
      return out;
    });
  }, [events, run]);

  const last = frames.length - 1;
  const shown = Math.min(index, last);
  const frame = frames[shown];
  const finished = !!run && frames.length > 0 && isDone(frames[last], run.mode);

  // Auto-play: a steady beat that shows each step for a moment, then moves on (or waits for new steps).
  // `last` is read through a ref so new steps arriving don't restart the beat.
  const lastRef = useRef(last);
  lastRef.current = last;
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setIndex((i) => Math.min(i + 1, lastRef.current)), STEP_MS[speed]);
    return () => clearInterval(t);
  }, [playing, speed]);

  const go = useCallback(
    (to: number) => {
      setPlaying(false);
      setIndex(Math.max(0, Math.min(to, last)));
    },
    [last],
  );

  // Keyboard: ← and → step through, space plays/pauses.
  useEffect(() => {
    if (!run) return;
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && (ev.target as HTMLInputElement).type !== 'range')) return;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault(); // also stops the scrubber from moving a second time
        go(shown + (ev.key === 'ArrowRight' ? 1 : -1));
      } else if (ev.key === ' ' && tag !== 'BUTTON') {
        ev.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, shown, go]);

  return (
    <section className="story">
      <div className="card story-intro">
        <h2>🎬 Watch a flash sale in slow motion</h2>
        <p>
          <b>10 shoppers</b> try to buy <b>5 limited sneakers</b> at the same moment. Pick a shop and let it play, or go through it step by
          step. Everything you see is the real system working; it has just been slowed down so you can follow each shopper.
        </p>
        <div className="story-buttons">
          <button className={`story-btn bad ${run?.mode === 'naive' ? 'current' : ''}`} onClick={() => start('naive')}>
            <span className="big">🏚️</span>
            <span>
              <b>Shop A: the naive shop</b>
              <small>Cashiers check the shelf, then write the order</small>
            </span>
          </button>
          <button className={`story-btn good ${run?.mode === 'flash' ? 'current' : ''}`} onClick={() => start('flash')}>
            <span className="big">🏬</span>
            <span>
              <b>Shop B: the ticket-desk shop</b>
              <small>A ticket desk decides first, a fair waitlist catches returns</small>
            </span>
          </button>
          <label className="speed">
            Playback
            <select value={playback} onChange={(e) => setPlayback(e.target.value as Playback)}>
              <option value="auto">Auto-play</option>
              <option value="step">Step by step (I click Next)</option>
            </select>
          </label>
          <label className="speed">
            Speed
            <select value={speed} onChange={(e) => setSpeed(e.target.value as StorySpeed)}>
              <option value="slow">Slow</option>
              <option value="very-slow">Very slow</option>
            </select>
          </label>
        </div>
        <p className="hint">Starting a story resets the demo data. The 🔬 Lab tab runs the same code with thousands of shoppers.</p>
      </div>

      {!run || !frame ? (
        <div className="card story-empty">
          <div className="big-emoji">👟👟👟👟👟</div>
          <p>Choose Shop A or Shop B above to start.</p>
        </div>
      ) : (
        <div className={`card scene ${run.mode === 'naive' ? 'scene-a' : 'scene-b'}`}>
          {run.mode === 'naive' ? <NaivePhase frame={frame} run={run} /> : <FlashPhase frame={frame} run={run} />}
          <Stepper
            index={shown}
            total={frames.length}
            playing={playing}
            waiting={!finished && shown >= last}
            onFirst={() => go(0)}
            onPrev={() => go(shown - 1)}
            onNext={() => go(shown + 1)}
            onLast={() => go(last)}
            atFinish={finished && shown >= last}
            onToggle={() => {
              if (finished && shown >= last) {
                setIndex(0); // replay from the start
                setPlaying(true);
              } else setPlaying((p) => !p);
            }}
            onSeek={go}
          />
          <div className="step-caption" key={`${run.runId}-${shown}`}>
            <span className="step-no">Step {shown + 1}</span>
            <span>{frame.caption}</span>
          </div>
          {run.mode === 'naive' ? <NaiveScene frame={frame} run={run} /> : <FlashScene frame={frame} run={run} />}
        </div>
      )}
    </section>
  );
}

function isDone(f: Frame, mode: Mode): boolean {
  const open: Stage[] = mode === 'naive' ? ['door', 'looked'] : ['door', 'ticket', 'queued', 'processing', 'offered', 'saved'];
  const all = Object.values(f.shoppers);
  // A walk-away's sneaker that hasn't been handed on yet (while people are waiting) means the story isn't over.
  const pendingHandoff = all.some((p) => p.stage === 'walked' && !p.handedTo) && all.some((p) => p.stage === 'waiting');
  return !pendingHandoff && all.every((p) => !open.includes(p.stage));
}

function Stepper(props: {
  index: number;
  total: number;
  playing: boolean;
  waiting: boolean;
  atFinish: boolean;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLast: () => void;
  onToggle: () => void;
  onSeek: (i: number) => void;
}) {
  const atStart = props.index === 0;
  const atEnd = props.index >= props.total - 1;
  return (
    <div className="stepper">
      <div className="stepper-buttons">
        <button className="btn" onClick={props.onFirst} disabled={atStart} title="First step" aria-label="First step">
          ⏮
        </button>
        <button className="btn" onClick={props.onPrev} disabled={atStart} title="Previous step (←)">
          ◀ Previous
        </button>
        <button className="btn btn-primary play" onClick={props.onToggle} title="Play / pause (space)">
          {props.atFinish ? '↺ Replay' : props.playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button className="btn" onClick={props.onNext} disabled={atEnd} title="Next step (→)">
          Next ▶
        </button>
        <button className="btn" onClick={props.onLast} disabled={atEnd} title="Latest step" aria-label="Latest step">
          ⏭
        </button>
        <span className="step-count">
          Step <b>{props.index + 1}</b> of {props.total}
          {props.waiting && <span className="waiting"> · waiting for the next thing to happen…</span>}
        </span>
      </div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(0, props.total - 1)}
        value={props.index}
        onChange={(e) => props.onSeek(Number(e.target.value))}
        aria-label="Story step"
      />
      <div className="stepper-hint">Tip: ← and → step through, space plays or pauses.</div>
    </div>
  );
}

function Token({ p, label, tone, focus }: { p: Shopper; label?: ReactNode; tone?: 'ok' | 'bad' | 'warn'; focus?: boolean }) {
  return (
    <span className={`token ${tone ? `tok-${tone}` : ''} ${focus ? 'focus' : ''}`} title={`Shopper ${p.n}`}>
      <span className="tok-face">{p.avatar}</span>
      <span className="tok-num">{p.n}</span>
      {label !== undefined && <span className="tok-label">{label}</span>}
    </span>
  );
}

function Zone(props: { icon: string; title: string; subtitle: string; tech?: string; active?: boolean; tone?: 'bad' | 'good'; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className={`zone ${props.active ? 'active' : ''} ${props.tone ? `zone-${props.tone}` : ''}`}>
      <div className="zone-head">
        <span className="zone-icon">{props.icon}</span>
        <div>
          <div className="zone-title">{props.title}</div>
          <div className="zone-sub">{props.subtitle}</div>
        </div>
      </div>
      <div className="zone-body">{props.children}</div>
      {props.footer && <div className="zone-foot">{props.footer}</div>}
      {props.tech && <div className="zone-tech">{props.tech}</div>}
    </div>
  );
}

function Arrow({ active }: { active: boolean }) {
  return (
    <div className={`arrow ${active ? 'active' : ''}`} aria-hidden>
      <span />
    </div>
  );
}

function Narration({ step, text, tone }: { step: string; text: ReactNode; tone?: 'bad' | 'good' }) {
  return (
    <div className={`narration ${tone ?? ''}`} key={step}>
      <span className="narr-step">{step}</span>
      <span className="narr-text">{text}</span>
    </div>
  );
}

function Shelf({ stock, initial, label }: { stock: number; initial: number; label: string }) {
  const items = [];
  for (let i = 0; i < initial; i++) items.push(<span key={`s${i}`} className={`sneaker ${i < stock ? '' : 'gone'}`}>👟</span>);
  for (let i = 0; i < -stock; i++) items.push(<span key={`m${i}`} className="sneaker missing">❓</span>);
  return (
    <div className="shelf">
      <div className="shelf-label">{label}</div>
      <div className="shelf-items">{items}</div>
      <div className={`shelf-count ${stock < 0 ? 'neg' : ''}`} key={stock}>
        {stock}
      </div>
    </div>
  );
}

const list = (f: Frame, ...stages: Stage[]) =>
  Object.values(f.shoppers)
    .filter((x) => stages.includes(x.stage))
    .sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0) || a.n - b.n);

/** The big "what's going on" sentence for the current phase of Shop A. */
function NaivePhase({ frame, run }: { frame: Frame; run: StoryRun }) {
  const looked = list(frame, 'looked');
  const ordered = list(frame, 'ordered');
  const oversold = Math.max(0, frame.orders - run.stock);
  const maxSeen = Math.max(...looked.map((x) => x.seen ?? 0), 0);
  if (isDone(frame, 'naive')) {
    return oversold ? (
      <Narration step="Result" tone="bad" text={<>😱 <b>{frame.orders} orders for {run.stock} sneakers.</b> {oversold} customers paid for a sneaker that doesn't exist. This is <b>overselling</b>: every cashier checked the shelf <i>before</i> anyone took a sneaker, so every check said "yes".</>} />
    ) : (
      <Narration step="Result" tone="good" text={<>No overselling this time: {frame.orders} orders for {run.stock} sneakers.</>} />
    );
  }
  if (ordered.length > 0) {
    return <Narration step="Phase 3" tone="bad" text={<>✍️ Now the cashiers write their orders, each taking a sneaker off the count… <b>and the count keeps going, even below zero.</b></>} />;
  }
  if (looked.length > 0) {
    return <Narration step="Phase 2" text={<>👀 The cashiers check the shelf and see <b>{maxSeen} sneakers left</b>. Nobody has written an order yet, so <b>every check passes</b>: {looked.length} shoppers are now "approved" for the same {run.stock} sneakers…</>} />;
  }
  return <Narration step="Phase 1" text={<>🚪 The doors open. {Object.keys(frame.shoppers).length} shoppers rush in for {run.stock} sneakers. Each one gets a cashier.</>} />;
}

/** The big "what's going on" sentence for the current phase of Shop B. */
function FlashPhase({ frame, run }: { frame: Frame; run: StoryRun }) {
  const soldout = list(frame, 'soldout', 'rejected', 'waiting');
  const waiting = list(frame, 'waiting');
  const moved = list(frame, 'ticket', 'queued', 'processing', 'saved', 'paid');
  const walked = list(frame, 'walked');
  if (isDone(frame, 'flash')) {
    return (
      <Narration
        step="Result"
        tone="good"
        text={
          <>
            🎉 <b>{frame.paid} sneakers sold and paid for, out of {run.stock}.</b> Every "yes" matched a real sneaker.
            {walked.length > 0 && <> One shopper walked away, and their sneaker went to <b>the first person on the waitlist</b>, not to whoever clicked fastest.</>}
            {waiting.length > 0 && <> {waiting.length} shoppers are still on the waitlist, in order.</>}
          </>
        }
      />
    );
  }
  if (walked.length > 0) {
    return <Narration step="Phase 5" text={<>⌛ A shopper didn't pay in time. Their sneaker is <b>not</b> put back for anyone to grab: in one atomic step it's <b>handed to #1 on the waitlist</b>, who is notified and goes through the clerk like everyone else.</>} />;
  }
  if (frame.paid > 0) {
    return <Narration step="Phase 4" text={<>💳 Ticket holders pay for their sneakers… but watch: one of them is about to walk away without paying.</>} />;
  }
  if (soldout.length > 0) {
    return <Narration step="Phase 3" text={<>🚫 The tickets are gone. Everyone else hears <b>"sold out" immediately</b> and joins the <b>🔔 waitlist</b>, in order. Meanwhile the clerk writes each ticket holder's order, <b>one at a time</b>.</>} />;
  }
  if (moved.length > 0) {
    return <Narration step="Phase 2" text={<>🎟️ The ticket desk hands out tickets <b>one at a time</b>. It can never give the same ticket to two people. <b>{frame.count} left.</b> Ticket holders join the line for the clerk.</>} />;
  }
  return <Narration step="Phase 1" text={<>🚪 The doors open. {Object.keys(frame.shoppers).length} shoppers arrive for {run.stock} sneakers. Before anything else, each one goes to the ticket desk.</>} />;
}

function NaiveScene({ frame, run }: { frame: Frame; run: StoryRun }) {
  const door = list(frame, 'door');
  const looked = list(frame, 'looked');
  const ordered = list(frame, 'ordered');
  const soldout = list(frame, 'soldout');
  const oversold = Math.max(0, frame.orders - run.stock);
  const f = (p: Shopper) => p.id === frame.focus;

  return (
    <>
      <Shelf stock={frame.count} initial={run.stock} label="Sneakers on the shelf (the shop's records)" />
      <div className="lanes">
        <Zone icon="🚪" title="At the door" subtitle="waiting for a cashier" active={door.length > 0}>
          {door.map((p) => <Token key={p.id} p={p} focus={f(p)} />)}
        </Zone>
        <Arrow active={door.length > 0} />
        <Zone icon="👀" title="Checked the shelf" subtitle="saw stock, about to write the order" tech="SELECT stock … (then a pause)" active={looked.length > 0}>
          {looked.map((p) => <Token key={p.id} p={p} label={`saw ${p.seen}`} tone="warn" focus={f(p)} />)}
        </Zone>
        <Arrow active={looked.length > 0} />
        <Zone icon="🧾" title="Order written" subtitle="was told: you got it!" tech="UPDATE stock, INSERT order" tone={oversold ? 'bad' : undefined} active={ordered.length > 0}>
          {ordered.map((p) => (
            <Token
              key={p.id}
              p={p}
              focus={f(p)}
              label={(p.orderNo ?? 0) <= run.stock ? `👟 #${p.orderNo}` : '❌ no sneaker!'}
              tone={(p.orderNo ?? 0) <= run.stock ? 'ok' : 'bad'}
            />
          ))}
        </Zone>
        <Zone icon="😞" title="Sold out" subtitle="saw an empty shelf" active={soldout.length > 0}>
          {soldout.map((p) => <Token key={p.id} p={p} focus={f(p)} />)}
        </Zone>
      </div>
      <div className="scoreboard">
        <div><span>Sneakers</span><b>{run.stock}</b></div>
        <div><span>Orders written</span><b className={frame.orders > run.stock ? 'bad' : ''}>{frame.orders}</b></div>
        <div><span>Customers let down</span><b className={oversold ? 'bad' : ''}>{oversold}</b></div>
      </div>
      <Legend
        items={[
          ['🧑', 'Shopper', 'one person pressing "Buy" (one web request)'],
          ['👀', 'Checking the shelf', 'reading the stock number from the database'],
          ['⏸️', 'The pause', 'the tiny gap between checking and writing, stretched to seconds here'],
          ['🧾', 'Order written', 'updating the stock and saving the order'],
        ]}
      />
    </>
  );
}

function FlashScene({ frame, run }: { frame: Frame; run: StoryRun }) {
  const door = list(frame, 'door');
  const line = list(frame, 'ticket', 'queued', 'offered');
  const processing = list(frame, 'processing');
  const book = list(frame, 'saved', 'paid', 'walked');
  const soldout = list(frame, 'soldout', 'rejected');
  const waitlist = Object.values(frame.shoppers)
    .filter((x) => x.stage === 'waiting')
    .sort((a, b) => (a.waitPos ?? 99) - (b.waitPos ?? 99));
  const f = (p: Shopper) => p.id === frame.focus;
  const nameOf = (id?: string) => (id ? `Shopper ${frame.shoppers[id]?.n}` : '');

  return (
    <>
      <div className="lanes lanes-b">
        <Zone icon="🚪" title="At the door" subtitle="arriving" active={door.length > 0}>
          {door.map((p) => <Token key={p.id} p={p} focus={f(p)} />)}
        </Zone>
        <Arrow active={door.length > 0} />
        <Zone
          icon="🎟️"
          title="Ticket desk"
          subtitle="instant yes / no"
          tech="Redis: atomic counter + waitlist"
          active={door.length > 0 || list(frame, 'offered').length > 0}
          footer={
            <div className="tickets">
              {Array.from({ length: run.stock }, (_, i) => (
                <span key={i} className={`ticket ${i < frame.count ? '' : 'taken'}`}>🎟️</span>
              ))}
              <b>{frame.count} left</b>
            </div>
          }
        >
          {soldout.length > 0 && (
            <div className="soldout-bin">
              <div className="bin-title">😞 Told "sold out" instantly</div>
              {soldout.map((p) => <Token key={p.id} p={p} focus={f(p)} />)}
            </div>
          )}
          {waitlist.length > 0 && (
            <div className="soldout-bin waitlist-bin">
              <div className="bin-title">🔔 Waitlist: first in line gets the next returned sneaker</div>
              {waitlist.map((p) => <Token key={p.id} p={p} label={`#${p.waitPos}`} tone="warn" focus={f(p)} />)}
            </div>
          )}
        </Zone>
        <Arrow active={line.length > 0} />
        <Zone icon="🧍" title="Waiting line" subtitle="has a ticket, waiting for paperwork" tech="message queue" active={line.length > 0}>
          {line.map((p) => <Token key={p.id} p={p} label={p.stage === 'offered' ? '🔔 from waitlist' : '🎟️'} tone="ok" focus={f(p)} />)}
        </Zone>
        <Arrow active={processing.length > 0} />
        <Zone icon="✍️" title="Clerk" subtitle="writes one order at a time" tech="worker" active={processing.length > 0}>
          {processing.map((p) => <Token key={p.id} p={p} label="writing…" focus={f(p)} />)}
        </Zone>
        <Arrow active={processing.length > 0} />
        <Zone icon="📒" title="Order book" subtitle="the official record" tech="PostgreSQL database" tone="good" active={book.length > 0}>
          {book.map((p) =>
            p.stage === 'walked' ? (
              <span key={p.id} className="faded">
                <Token p={p} label={p.handedTo ? `⌛ #${p.orderNo} → ${nameOf(p.handedTo)}` : `⌛ didn't pay`} tone="bad" focus={f(p)} />
              </span>
            ) : (
              <Token
                key={p.id}
                p={p}
                label={p.stage === 'paid' ? `✅ 👟 #${p.orderNo} paid` : `👟 #${p.orderNo} · unpaid`}
                tone={p.stage === 'paid' ? 'ok' : 'warn'}
                focus={f(p)}
              />
            ),
          )}
        </Zone>
      </div>
      <div className="scoreboard">
        <div><span>Sneakers</span><b>{run.stock}</b></div>
        <div><span>Paid</span><b className="good">{frame.paid}</b></div>
        <div><span>Active orders</span><b>{frame.orders}</b></div>
        <div><span>On the waitlist</span><b>{waitlist.length}</b></div>
        <div><span>Customers let down</span><b className="good">0</b></div>
      </div>
      <Legend
        items={[
          ['🎟️', 'Ticket desk', 'Redis: a super-fast counter that hands out exactly one ticket per sneaker, never two at once'],
          ['🔔', 'Waitlist', 'a list in Redis, in arrival order. A returned sneaker goes to #1 in the same atomic step that frees it, so nobody can snipe it'],
          ['🧍', 'Waiting line', 'a message queue: absorbs the rush so the database is never overwhelmed'],
          ['✍️', 'Clerk', 'a background worker writing orders at a safe pace (slowed to 1 clerk here)'],
          ['📒', 'Order book', 'the database: the permanent, official record'],
          ['⌛', "Didn't pay", 'every reservation has a time limit; when it runs out, the sneaker is freed'],
        ]}
      />
    </>
  );
}

function Legend({ items }: { items: [string, string, string][] }) {
  return (
    <details className="legend">
      <summary>What do these pictures mean in tech terms?</summary>
      <ul>
        {items.map(([icon, name, text]) => (
          <li key={name}>
            <span>{icon}</span> <b>{name}</b>: {text}
          </li>
        ))}
      </ul>
    </details>
  );
}
