import { Controller, MessageEvent, Sse } from '@nestjs/common';
import type { DemoEvent } from '@flash/shared';
import { defer, exhaustMap, from, interval, map, Observable, startWith } from 'rxjs';
import { TelemetryService } from '../common/telemetry.service';
import { StateService } from './state.service';

const TICK_MS = 500;

/**
 * Server-Sent Events: a plain HTTP response that stays open and receives `data:` lines.
 * We picked SSE over WebSocket because data only flows server -> browser, no extra library
 * is needed, and EventSource reconnects automatically.
 */
@Controller()
export class StreamController {
  constructor(
    private readonly state: StateService,
    private readonly telemetry: TelemetryService,
  ) {}

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return defer(() => {
      let lastSeq = 0;
      let lastSale = '';
      return interval(TICK_MS).pipe(
        startWith(0),
        // exhaustMap: if building a snapshot takes longer than a tick, skip ticks instead of piling up.
        exhaustMap(() =>
          from(
            (async () => {
              const [snapshot, recent] = await Promise.all([this.state.snapshot(), this.telemetry.recentEvents(60)]);
              // A reset starts a new sale and restarts the event sequence: start over.
              if (snapshot.saleId !== lastSale || (recent.length && recent[0].seq < lastSeq)) lastSeq = 0;
              lastSale = snapshot.saleId;
              const events: DemoEvent[] = recent.filter((e) => e.seq > lastSeq).reverse();
              if (recent.length) lastSeq = recent[0].seq;
              return { snapshot, events };
            })(),
          ),
        ),
        map((data) => ({ data }) as MessageEvent),
      );
    });
  }
}
