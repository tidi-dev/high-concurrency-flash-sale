import { Injectable, Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { DEFAULT_CONFIG } from '../common/demo-config';
import { DemoConfigService } from '../common/demo-config.service';
import { env } from '../common/env';
import { QueueService, ReservationJob } from '../common/queue.service';
import { createBullConnection } from '../common/redis';
import { LifecycleService } from './lifecycle.service';
import { PersistenceService } from './persistence.service';

/**
 * The worker process: consumes the reservation queue at a controlled concurrency
 * (`workerConcurrency` jobs at a time, a live demo knob, whatever the request spike looks like) and runs the
 * expiry sweeper on a timer.
 */
@Injectable()
export class WorkerRunner {
  private readonly log = new Logger('Worker');
  private worker: Worker<ReservationJob> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private configTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly persistence: PersistenceService,
    private readonly lifecycle: LifecycleService,
    private readonly queue: QueueService,
    private readonly config: DemoConfigService,
  ) {}

  start(opts: { sweepIntervalMs?: number } = {}): void {
    if (this.worker) return;
    this.worker = new Worker<ReservationJob>(env.queueName, (job) => this.persistence.persist(job.data), {
      connection: createBullConnection(),
      concurrency: DEFAULT_CONFIG.workerConcurrency, // then follows the live `workerConcurrency` knob
    });
    this.worker.on('failed', (job, err) => this.log.warn(`job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));

    // "How many clerks": the dashboard can change worker concurrency live.
    this.configTimer = setInterval(() => void this.applyConcurrency(), 500);
    void this.applyConcurrency();

    const interval = opts.sweepIntervalMs ?? env.sweepIntervalMs;
    if (interval > 0) {
      this.sweepTimer = setInterval(() => void this.sweepOnce(), interval);
    }
    this.log.log(`consuming "${env.queueName}"; sweeping every ${interval}ms`);
  }

  private async applyConcurrency(): Promise<void> {
    try {
      const { workerConcurrency } = await this.config.get();
      if (this.worker && this.worker.concurrency !== workerConcurrency) {
        this.worker.concurrency = workerConcurrency;
        this.log.log(`concurrency -> ${workerConcurrency}`);
      }
    } catch {
      // Redis briefly unavailable: keep the current setting
    }
  }

  private async sweepOnce(): Promise<void> {
    if (this.sweeping) return; // don't overlap with ourselves (other processes may overlap, and that's safe)
    this.sweeping = true;
    try {
      await this.lifecycle.sweep();
    } catch (err) {
      this.log.warn(`sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Resolves once the queue has no waiting/active jobs (used by tests and the CLI). */
  async waitForDrain(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = await this.queue.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      if (Object.values(c).every((n) => n === 0)) return;
      if (Date.now() > deadline) throw new Error(`queue did not drain: ${JSON.stringify(c)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.configTimer) clearInterval(this.configTimer);
    this.sweepTimer = null;
    this.configTimer = null;
    if (this.worker) {
      const connection = this.worker.opts.connection as { quit?: () => Promise<unknown> };
      await this.worker.close();
      await connection.quit?.().catch(() => undefined);
    }
    this.worker = null;
  }
}
