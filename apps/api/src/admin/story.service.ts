import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { DemoConfig, Mode, StoryRun, StorySpeed } from '@flash/shared';
import { DemoConfigService } from '../common/demo-config.service';
import { QueueService } from '../common/queue.service';
import { TelemetryService } from '../common/telemetry.service';
import { sleep } from '../common/util';
import { ReservationService } from '../flash/reservation.service';
import { NaiveService } from '../naive/naive.service';
import { AdminService } from './admin.service';
import { SimulationService } from './simulation.service';

/** Slow-motion pacing per speed. These are real delays inside the real code paths, not animation tricks. */
const PACE: Record<StorySpeed, { naiveDelayMs: number; workerDelayMs: number; arrivalGapMs: { naive: number; flash: number } }> = {
  slow: { naiveDelayMs: 2500, workerDelayMs: 900, arrivalGapMs: { naive: 150, flash: 350 } },
  'very-slow': { naiveDelayMs: 4500, workerDelayMs: 1600, arrivalGapMs: { naive: 250, flash: 600 } },
};

/**
 * "Story mode": a tiny, slowed-down flash sale (about 10 shoppers, 5 sneakers) that a non-technical
 * viewer can follow. It uses the real endpoints' code paths; only the pacing knobs change:
 *  - Mode A: a long pause between "look at the shelf" and "write the order", so you can SEE
 *    every shopper reading the same stock value before anyone writes.
 *  - Mode B: shoppers arrive one by one, and a single slow worker ("one clerk") writes orders,
 *    so you can see the ticket desk answer instantly while the paperwork queues up.
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
      void this.play(run, pace.arrivalGapMs[mode], before);
      return run;
    } catch (err) {
      this.running = false;
      throw err;
    }
  }

  private async play(run: StoryRun, gapMs: number, before: DemoConfig): Promise<void> {
    try {
      // Give both processes time to pick up the new knobs (config cache 250ms, worker polls every 500ms).
      await sleep(1200);
      const buys: Promise<unknown>[] = [];
      for (const userId of run.shoppers) {
        buys.push((run.mode === 'naive' ? this.naive.buy(userId) : this.reservations.reserve(userId)).catch(() => undefined));
        await sleep(gapMs);
      }
      await Promise.all(buys);
      if (run.mode === 'flash') await this.waitForQueue(60_000);
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

  private async waitForQueue(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const c = await this.queue.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      if (Object.values(c).every((n) => n === 0)) return;
      await sleep(250);
    }
  }
}
