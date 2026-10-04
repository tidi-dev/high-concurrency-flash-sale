import type { DemoEvent, Mode, StateSnapshot, StoryRun, StorySpeed } from '@flash/shared';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { post } from '../api';

const AVATARS = ['🧑', '👩', '👨', '🧓', '👧', '🧔', '👩‍🦱', '👨‍🦰', '👱‍♀️', '🧑‍🦱', '👵', '👦', '👩‍🦳', '🧑‍🦲', '👨‍🦳', '👱'];

type Stage = 'door' | 'looked' | 'ordered' | 'soldout' | 'ticket' | 'queued' | 'processing' | 'saved' | 'rejected';

interface Shopper {
  id: string;
  n: number;
  avatar: string;
  stage: Stage;
  /** Mode A: the stock value this shopper saw on the shelf. */
  seen?: number;
  /** 1-based position among completed orders. */
  orderNo?: number;
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
};

// Never move a shopper backwards (events can arrive in the same tick out of order).
const RANK: Record<Stage, number> = { door: 0, looked: 1, ticket: 1, queued: 2, processing: 3, ordered: 4, saved: 4, soldout: 4, rejected: 4 };

export function StoryMode({ s, events, notify }: { s: StateSnapshot; events: DemoEvent[]; notify: (m: string, t?: 'ok' | 'danger') => void }) {
  const [speed, setSpeed] = useState<StorySpeed>('slow');
  const [run, setRun] = useState<StoryRun | null>(null);
  const [shoppers, setShoppers] = useState<Record<string, Shopper>>({});
  // Event sequence numbers restart when a story resets the demo, so track what we've applied per run.
  const processed = useRef(new Set<number>());

  const start = async (m: Mode) => {
    const r = await post<StoryRun & { message?: string }>('/story', { mode: m, shoppers: 10, stock: 5, speed });
    if (r.status >= 300) {
      notify(r.data.message ?? 'Could not start', 'danger');
      return;
    }
    processed.current = new Set();
    setShoppers(Object.fromEntries(r.data.shoppers.map((id, i) => [id, { id, n: i + 1, avatar: AVATARS[i % AVATARS.length], stage: 'door' as Stage }])));
    setRun(r.data);
  };

  // Turn the live event stream into shopper movements.
  useEffect(() => {
    if (!run) return;
    const prefix = `story-${run.runId}-`;
    const fresh = events.filter((e) => e.userId?.startsWith(prefix) && STAGE_FROM_EVENT[e.type]).sort((a, b) => a.seq - b.seq);
    const newOnes = fresh.filter((e) => !processed.current.has(e.seq));
    if (!newOnes.length) return;
    for (const e of newOnes) processed.current.add(e.seq);
    setShoppers((prev) => {
      const next = { ...prev };
      for (const e of newOnes) {
        const cur = next[e.userId!];
        const stage = STAGE_FROM_EVENT[e.type]!;
        if (!cur || RANK[stage] < RANK[cur.stage]) continue;
        const upd: Shopper = { ...cur, stage };
        if (e.type === 'NAIVE_STOCK_READ') upd.seen = Number(/saw (-?\d+)/.exec(e.detail ?? '')?.[1]);
        // Derived from state (not a ref) so React's dev double-invocation of updaters can't skip numbers.
        if (stage === 'ordered' || stage === 'saved') upd.orderNo = Object.values(next).filter((x) => x.orderNo).length + 1;
        next[e.userId!] = upd;
      }
      return next;
    });
  }, [events, run]);

  const list = useMemo(() => Object.values(shoppers).sort((a, b) => a.n - b.n), [shoppers]);
  const at = (...stages: Stage[]) => list.filter((x) => stages.includes(x.stage));

  return (
    <section className="story">
      <div className="card story-intro">
        <h2>🎬 Watch a flash sale in slow motion</h2>
        <p>
          <b>10 shoppers</b> try to buy <b>5 limited sneakers</b> at the same moment. Pick a shop and press play. Everything you see is the
          real system working; it has just been slowed down so you can follow each shopper.
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
              <small>A ticket desk decides first, clerks do paperwork later</small>
            </span>
          </button>
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

      {!run ? (
        <div className="card story-empty">
          <div className="big-emoji">👟👟👟👟👟</div>
          <p>Choose Shop A or Shop B above to start.</p>
        </div>
      ) : run.mode === 'naive' ? (
        <NaiveScene s={s} run={run} list={list} at={at} />
      ) : (
        <FlashScene s={s} run={run} list={list} at={at} />
      )}
    </section>
  );
}

type At = (...stages: Stage[]) => Shopper[];

function Token({ p, label, tone }: { p: Shopper; label?: ReactNode; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <span className={`token ${tone ? `tok-${tone}` : ''}`} title={`Shopper ${p.n}`}>
      <span className="tok-face">{p.avatar}</span>
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
      <div className={`shelf-count ${stock < 0 ? 'neg' : ''}`}>{stock}</div>
    </div>
  );
}

function NaiveScene({ s, run, list, at }: { s: StateSnapshot; run: StoryRun; list: Shopper[]; at: At }) {
  const door = at('door');
  const looked = at('looked');
  const ordered = at('ordered').sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0));
  const soldout = at('soldout');
  const stock = s.naive.product?.stock ?? run.stock;
  const orders = s.naive.orders;
  const done = list.length > 0 && door.length === 0 && looked.length === 0;
  const oversold = Math.max(0, orders - run.stock);
  const maxSeen = Math.max(...looked.map((x) => x.seen ?? 0), 0);

  let narr: { step: string; text: ReactNode; tone?: 'bad' | 'good' };
  if (done) {
    narr = oversold
      ? { step: 'Result', tone: 'bad', text: <>😱 <b>{orders} orders for {run.stock} sneakers.</b> {oversold} customers paid for a sneaker that doesn't exist. This is <b>overselling</b>: every cashier checked the shelf <i>before</i> anyone took a sneaker, so every check said "yes".</> }
      : { step: 'Result', tone: 'good', text: <>No overselling this time: {orders} orders for {run.stock} sneakers.</> };
  } else if (ordered.length > 0) {
    narr = { step: 'Step 3', tone: 'bad', text: <>✍️ Now the cashiers write their orders, each one taking a sneaker off the count… <b>the count keeps going, even below zero.</b></> };
  } else if (looked.length > 0) {
    narr = { step: 'Step 2', text: <>👀 Each cashier looks at the shelf and sees <b>{maxSeen} sneakers left</b>. Nobody has written an order yet, so <b>every check passes</b>. {looked.length} shoppers are now "approved" for the same {run.stock} sneakers…</> };
  } else {
    narr = { step: 'Step 1', text: <>🚪 The doors open. {list.length} shoppers rush in for {run.stock} sneakers. Each one gets a cashier.</> };
  }

  return (
    <div className="card scene scene-a">
      <Narration {...narr} />
      <Shelf stock={stock} initial={run.stock} label="Sneakers on the shelf (the shop's records)" />
      <div className="lanes">
        <Zone icon="🚪" title="At the door" subtitle="waiting for a cashier" active={door.length > 0}>
          {door.map((p) => <Token key={p.id} p={p} />)}
        </Zone>
        <Arrow active={door.length > 0} />
        <Zone icon="👀" title="Checked the shelf" subtitle="saw stock, about to write the order" tech="SELECT stock … (then a pause)" active={looked.length > 0}>
          {looked.map((p) => <Token key={p.id} p={p} label={`saw ${p.seen}`} tone="warn" />)}
        </Zone>
        <Arrow active={looked.length > 0} />
        <Zone icon="🧾" title="Order written" subtitle="was told: you got it!" tech="UPDATE stock, INSERT order" tone={oversold ? 'bad' : undefined} active={ordered.length > 0}>
          {ordered.map((p) => (
            <Token key={p.id} p={p} label={(p.orderNo ?? 0) <= run.stock ? `👟 #${p.orderNo}` : '❌ no sneaker!'} tone={(p.orderNo ?? 0) <= run.stock ? 'ok' : 'bad'} />
          ))}
        </Zone>
        <Zone icon="😞" title="Sold out" subtitle="saw an empty shelf" active={soldout.length > 0}>
          {soldout.map((p) => <Token key={p.id} p={p} />)}
        </Zone>
      </div>
      <div className="scoreboard">
        <div><span>Sneakers</span><b>{run.stock}</b></div>
        <div><span>Orders written</span><b className={orders > run.stock ? 'bad' : ''}>{orders}</b></div>
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
    </div>
  );
}

function FlashScene({ s, run, list, at }: { s: StateSnapshot; run: StoryRun; list: Shopper[]; at: At }) {
  const door = at('door');
  const ticket = at('ticket', 'queued');
  const processing = at('processing');
  const saved = at('saved').sort((a, b) => (a.orderNo ?? 0) - (b.orderNo ?? 0));
  const soldout = at('soldout', 'rejected');
  const tickets = s.flash.redis.stock ?? run.stock;
  const book = s.flash.db.reserved + s.flash.db.paid;
  const done = list.length > 0 && door.length === 0 && ticket.length === 0 && processing.length === 0;

  let narr: { step: string; text: ReactNode; tone?: 'bad' | 'good' };
  if (done) {
    narr = { step: 'Result', tone: 'good', text: <>🎉 <b>{saved.length} orders for {run.stock} sneakers.</b> Every "yes" matched a real sneaker. Shoppers got an answer instantly; the slow paperwork happened calmly in the back.</> };
  } else if (soldout.length > 0) {
    narr = { step: 'Step 3', text: <>🚫 The tickets are gone. Everyone else hears <b>"sold out" immediately</b>, with no waiting and no extra work for the back office. Meanwhile the clerk writes each ticket holder's order, <b>one at a time</b>.</> };
  } else if (ticket.length + processing.length + saved.length > 0) {
    narr = { step: 'Step 2', text: <>🎟️ The ticket desk hands out tickets <b>one at a time</b>. It can never give the same ticket to two people. <b>{tickets} left.</b> Ticket holders join the line for the clerk.</> };
  } else {
    narr = { step: 'Step 1', text: <>🚪 The doors open. {list.length} shoppers arrive for {run.stock} sneakers. Before anything else, each one goes to the ticket desk.</> };
  }

  return (
    <div className="card scene scene-b">
      <Narration {...narr} />
      <div className="lanes lanes-b">
        <Zone icon="🚪" title="At the door" subtitle="arriving" active={door.length > 0}>
          {door.map((p) => <Token key={p.id} p={p} />)}
        </Zone>
        <Arrow active={door.length > 0} />
        <Zone
          icon="🎟️"
          title="Ticket desk"
          subtitle="instant yes / no"
          tech="Redis: atomic counter"
          active={door.length > 0}
          footer={
            <div className="tickets">
              {Array.from({ length: run.stock }, (_, i) => (
                <span key={i} className={`ticket ${i < tickets ? '' : 'taken'}`}>🎟️</span>
              ))}
              <b>{tickets} left</b>
            </div>
          }
        >
          {soldout.length > 0 && (
            <div className="soldout-bin">
              <div className="bin-title">😞 Told "sold out" instantly</div>
              {soldout.map((p) => <Token key={p.id} p={p} />)}
            </div>
          )}
        </Zone>
        <Arrow active={ticket.length > 0} />
        <Zone icon="🧍" title="Waiting line" subtitle="has a ticket, waiting for paperwork" tech="message queue" active={ticket.length > 0}>
          {ticket.map((p) => <Token key={p.id} p={p} label="🎟️" tone="ok" />)}
        </Zone>
        <Arrow active={processing.length > 0} />
        <Zone icon="✍️" title="Clerk" subtitle="writes one order at a time" tech="worker" active={processing.length > 0}>
          {processing.map((p) => <Token key={p.id} p={p} label="writing…" />)}
        </Zone>
        <Arrow active={processing.length > 0} />
        <Zone icon="📒" title="Order book" subtitle="the official record" tech="PostgreSQL database" tone="good" active={saved.length > 0}>
          {saved.map((p) => <Token key={p.id} p={p} label={`👟 #${p.orderNo}`} tone="ok" />)}
        </Zone>
      </div>
      <div className="scoreboard">
        <div><span>Sneakers</span><b>{run.stock}</b></div>
        <div><span>Tickets given</span><b>{run.stock - Math.max(0, tickets)}</b></div>
        <div><span>Orders in the book</span><b>{book}</b></div>
        <div><span>Customers let down</span><b className="good">0</b></div>
      </div>
      <Legend
        items={[
          ['🎟️', 'Ticket desk', 'Redis: a super-fast counter that hands out exactly one ticket per sneaker, never two at once'],
          ['🧍', 'Waiting line', 'a message queue: absorbs the rush so the database is never overwhelmed'],
          ['✍️', 'Clerk', 'a background worker writing orders at a safe pace (slowed to 1 clerk here)'],
          ['📒', 'Order book', 'the database: the permanent, official record'],
        ]}
      />
    </div>
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
