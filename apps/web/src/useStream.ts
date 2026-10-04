import type { DemoEvent, StateSnapshot } from '@flash/shared';
import { useEffect, useRef, useState } from 'react';

const MAX_EVENTS = 150;

export interface Rates {
  /** requests/s hitting each mode, and messages/s through the pipeline, since the previous tick. */
  naiveRequests: number;
  flashRequests: number;
  allowed: number;
  queued: number;
  persisted: number;
}

/** Subscribes to the API's Server-Sent Events stream: a snapshot every 500ms plus new events. */
export function useStream() {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [rates, setRates] = useState<Rates>({ naiveRequests: 0, flashRequests: 0, allowed: 0, queued: 0, persisted: 0 });
  const prev = useRef<StateSnapshot | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      const { snapshot: s, events: fresh } = JSON.parse(msg.data) as { snapshot: StateSnapshot; events: DemoEvent[] };
      const p = prev.current;
      if (p) {
        const dt = Math.max(0.001, (s.ts - p.ts) / 1000);
        const r = (a: number, b: number) => Math.max(0, Math.round((a - b) / dt));
        setRates({
          naiveRequests: r(s.naive.metrics.requests, p.naive.metrics.requests),
          flashRequests: r(s.flash.metrics.requests, p.flash.metrics.requests),
          allowed: r(s.flash.metrics.allowed, p.flash.metrics.allowed),
          queued: r(s.flash.metrics.queued, p.flash.metrics.queued),
          persisted: r(s.flash.metrics.persisted + s.flash.metrics.duplicatesIgnored + s.flash.metrics.rejected, p.flash.metrics.persisted + p.flash.metrics.duplicatesIgnored + p.flash.metrics.rejected),
        });
      }
      const newSale = !!p && p.saleId !== s.saleId;
      prev.current = s;
      setSnapshot(s);
      if (newSale) setEvents([]);
      if (fresh.length) {
        setEvents((old) => {
          // A reset restarts sequence numbers: start the list over.
          const base = old.length && fresh[0].seq <= old[0].seq ? [] : old;
          return [...fresh.slice().reverse(), ...base].slice(0, MAX_EVENTS);
        });
      }
    };
    return () => es.close();
  }, []);

  return { snapshot, events, connected, rates };
}
