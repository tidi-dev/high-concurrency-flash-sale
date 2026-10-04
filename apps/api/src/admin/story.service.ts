import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { DemoConfig, Mode, StoryRun, StorySpeed } from '@flash/shared';
import { DemoConfigService } from '../common/demo-config.service';
import { QueueService } from '../common/queue.service';
import { TelemetryService } from '../common/telemetry.service';
import { sleep } from '../common/util';
import { LifecycleService } from '../flash/lifecycle.service';
import { ReservationService } from '../flash/reservation.service';
import { WaitlistService } from '../flash/waitlist.service';
import { NaiveService } from '../naive/naive.service';
import { AdminService } from './admin.service';
import { SimulationService } from './simulation.service';

/** Slow-motion pacing per speed. These are real delays inside the real code paths, not animation tricks. */
interface Pace {
  naiveDelayMs: number;
  workerDelayMs: number;
  arrivalGapMs: { naive: number; flash: number };
  /** Shop B second act: pause between payments, and before the walk-away's time "runs out". */
  payGapMs: number;
  timeoutMs: number;
}
const PACE: Record<StorySpeed, Pace> = {
  slow: { naiveDelayMs: 2500, workerDelayMs: 900, arrivalGapMs: { naive: 150, flash: 350 }, payGapMs: 600, timeoutMs: 1500 },
  'very-slow': { naiveDelayMs: 4500, workerDelayMs: 1600, arrivalGapMs: { naive: 250, flash: 600 }, payGapMs: 1000, timeoutMs: 2500 },
};

/**
 * "Story mode": a tiny, slowed-down flash sale (about 10 shoppers, 5 sneakers) that a non-technical
 * viewer can follow. It uses the real endpoints' code paths; only the pacing knobs change:
 *  - Mode A: a long pause between "look at the shelf" and "write the order", so you can SEE
 *    every shopper reading the same stock value before anyone writes.
 *  - Mode B: shoppers arrive one by one, and a single slow worker ("one clerk") writes orders,
 *    so you can see the ticket desk answer instantly while the paperwork queues up. Sold-out
 *    shoppers join the waitlist; one ticket holder walks away without paying, and their sneaker
 *    is handed to waitlist #1.
 * The previous knob values are restored when the story ends.
 */
@Injectable()
export class StoryService {
  private readonly log = new Logger('Story');
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  constructor(
    private readonly admin: AdminService,
    private readonly config: DemoConfigService,
    private readonly naive: NaiveService,
    private readonly reservations: ReservationService,
    private readonly lifecycle: LifecycleService,
    private readonly waitlist: WaitlistService,
    private readonly queue: QueueService,
    private readonly simulation: SimulationService,
    private readonly telemetry: TelemetryService,
  ) {}

  async start(mode: Mode, shoppers: number, stock: number, speed: StorySpeed): Promise<StoryRun> {
    if (this.running || this.simulation.running) throw new ConflictException('Something is already running. Wait a few seconds.');
    this.running = true;
    try {
      const before = await this.config.get();
      await this.admin.reset(stock);
      const pace = PACE[speed];
      const patch: Partial<DemoConfig> =
        mode === 'naive' ? { naiveDelayMs: pace.naiveDelayMs } : { workerDelayMs: pace.workerDelayMs, workerConcurrency: 1 };
      await this.config.update(patch);

      const runId = Date.now().toString(36);
      const run: StoryRun = {
        runId,
        mode,
        stock,
        shoppers: Array.from({ length: shoppers }, (_, i) => `story-${runId}-${i + 1}`),
        startedAt: Date.now(),
      };
      await this.telemetry.record({ type: 'STORY_STARTED', mode, detail: `${shoppers} shoppers, ${stock} sneakers` });
      void this.play(run, pace, before);
      return run;
    } catch (err) {
      this.running = false;
      throw err;
    }
  }

  private async play(run: StoryRun, pace: Pace, before: DemoConfig): Promise<void> {
    try {
      // Give both processes time to pick up the new knobs (config cache 250ms, worker polls every 500ms).
      await sleep(1200);
      if (run.mode === 'naive') await this.playNaive(run, pace);
      else await this.playFlash(run, pace);
      await this.telemetry.record({ type: 'STORY_FINISHED', mode: run.mode });
    } catch (err) {
      this.log.warn(`story failed: ${(err as Error).message}`);
    } finally {
      await this.config
        .update({ naiveDelayMs: before.naiveDelayMs, workerDelayMs: before.workerDelayMs, workerConcurrency: before.workerConcurrency })
        .catch(() => undefined);
      this.running = false;
    }
  }

  private async playNaive(run: StoryRun, pace: Pace): Promise<void> {
    const buys: Promise<unknown>[] = [];
    for (const userId of run.shoppers) {
      buys.push(this.naive.buy(userId).catch(() => undefined));
      await sleep(pace.arrivalGapMs.naive);
    }
    await Promise.all(buys);
  }

  /**
   * Shop B in two acts.
   *  Act 1: shoppers arrive; the ticket desk (Redis) admits exactly `stock`; sold-out shoppers join
   *         the waitlist; one clerk persists the orders.
   *  Act 2: ticket holders pay, except one who walks away. Their reservation expires, and the
   *         release script hands the sneaker to waitlist #1, who is notified and pays.
   */
  private async playFlash(run: StoryRun, pace: Pace): Promise<void> {
    const holders: { userId: string; reservationId: string }[] = [];
    const buys: Promise<unknown>[] = [];
    for (const userId of run.shoppers) {
      buys.push(
        this.reservations
          .reserve(userId)
          .then(async (r) => {
            if (r.status === 'RESERVED' && r.reservationId) holders.push({ userId, reservationId: r.reservationId });
            if (r.status === 'SOLD_OUT') await this.waitlist.join(userId); // told "sold out", joins the line
          })
          .catch(() => undefined),
      );
      await sleep(pace.arrivalGapMs.flash);
    }
    await Promise.all(buys);
    await this.waitForQueue(60_000);
    if (holders.length === 0) return;

    // Act 2: everyone pays except the last ticket holder, who walks away.
    const walkAway = holders[holders.length - 1];
    await sleep(pace.payGapMs);
    for (const h of holders.slice(0, -1)) {
      await this.lifecycle.pay(h.reservationId);
      await sleep(pace.payGapMs);
    }
    await sleep(pace.timeoutMs); // ...their timer runs out (forced here so you don't wait the full TTL)
    await this.lifecycle.expire(walkAway.reservationId, { force: true }); // -> handed to waitlist #1
    await this.waitForQueue(60_000);

    // The waitlisted shopper got their "notification" (a held reservation) and pays.
    for (const userId of run.shoppers) {
      const st = await this.waitlist.status(userId);
      if (st.status === 'OFFERED' && st.reservationId) {
        await sleep(pace.payGapMs);
        await this.lifecycle.pay(st.reservationId);
        return;
      }
    }
    this.log.warn('no waitlist offer found (nobody was sold out?)');
  }

  private async waitForQueue(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const c = await this.queue.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      if (Object.values(c).every((n) => n === 0)) return;
      await sleep(250);
    }
  }
}
