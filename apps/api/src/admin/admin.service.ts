import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { DemoConfigService } from '../common/demo-config.service';
import { keys, PRODUCTS } from '../common/keys';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { REDIS } from '../common/redis';
import { TelemetryService } from '../common/telemetry.service';
import { randomUUID } from 'node:crypto';
import { sleep } from '../common/util';

export type ReseedStrategy = 'initial' | 'db' | 'none';

/** Demo controls: reset, worker pause, failure injection. */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: DemoConfigService,
    private readonly telemetry: TelemetryService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Wipe everything and start a new sale with `initialStock` units for each mode.
   * Order matters: stop the queue first, so no in-flight job writes into the fresh dataset.
   */
  async reset(initialStock = 500, opts: { resetConfig?: boolean } = {}): Promise<void> {
    // A new sale id is a FENCING TOKEN: any straggler message from the previous sale (a buy that was
    // in flight during the reset, a job that outlived the wait below) carries the old id, and the
    // worker's guarded UPDATE refuses it. Without it, stale work could write into the fresh sale.
    const saleId = randomUUID();
    await this.stopQueue();
    try {
      await this.deleteKeys([keys.productPattern(PRODUCTS.flash.id), keys.productPattern(PRODUCTS.naive.id)]);
      await this.redis.del(keys.flashMetrics, keys.naiveMetrics, keys.events, keys.eventsSeq, keys.simCurrent, keys.simLast('naive'), keys.simLast('flash'));
      if (opts.resetConfig) await this.config.resetToDefaults();

      await withDeadlockRetry(() =>
        this.prisma.$transaction([
          this.prisma.order.deleteMany(),
          this.prisma.reservation.deleteMany(),
          ...Object.values(PRODUCTS).map((p) =>
            this.prisma.product.upsert({
              where: { id: p.id },
              create: { id: p.id, name: p.name, initialStock, stock: initialStock, saleId },
              update: { name: p.name, initialStock, stock: initialStock, saleId },
            }),
          ),
        ]),
      );
      await this.redis.mset(keys.stock(PRODUCTS.flash.id), initialStock, keys.sale(PRODUCTS.flash.id), saleId);
    } finally {
      // Never leave the demo with a paused queue, even if something above failed.
      await this.queue.queue.resume();
    }
    await this.telemetry.record({ type: 'DEMO_RESET', mode: 'system', detail: `initial stock ${initialStock} for both modes (sale ${saleId.slice(0, 8)})` });
  }

  async pauseWorker(): Promise<void> {
    // BullMQ pause is global: every worker process stops picking up new jobs.
    await this.queue.queue.pause();
    await this.telemetry.record({ type: 'WORKER_PAUSED', mode: 'system', detail: 'requests are still admitted; messages pile up in the queue' });
  }

  async resumeWorker(): Promise<void> {
    await this.queue.queue.resume();
    await this.telemetry.record({ type: 'WORKER_RESUMED', mode: 'system' });
  }

  /** Re-publish the messages of the `count` most recent reservations, as a broker redelivery would. */
  async duplicateDelivery(count = 10): Promise<{ enqueued: number }> {
    const recent = await this.prisma.reservation.findMany({ where: { productId: PRODUCTS.flash.id }, orderBy: { createdAt: 'desc' }, take: count });
    const { saleId } = await this.prisma.product.findUniqueOrThrow({ where: { id: PRODUCTS.flash.id } });
    const stamp = Date.now();
    for (const r of recent) {
      await this.queue.add(
        { reservationId: r.id, productId: r.productId, userId: r.userId, createdAtMs: r.createdAt.getTime(), expiresAtMs: r.expiresAt.getTime(), saleId },
        `${r.id}-dup-${stamp}`,
      );
    }
    return { enqueued: recent.length };
  }

  /**
   * Simulate Redis losing its data (crash without persistence, failover to a lagging replica...).
   * Stock counter, reservation records, pending set AND the BullMQ queue are gone.
   *   reseed 'initial' -> naive restart script: SET stock = initialStock   (re-admits units already sold!)
   *   reseed 'db'      -> rebuild from the source of truth: SET stock = PostgreSQL stock
   *   reseed 'none'    -> Redis comes back empty; buy requests get NOT_INITIALIZED
   */
  async simulateRedisDataLoss(reseed: ReseedStrategy): Promise<{ lostJobs: number; lostPending: number; newStock: number | null }> {
    const counts = await this.queue.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    const lostJobs = Object.values(counts).reduce((a, b) => a + b, 0);
    const lostPending = await this.redis.zcard(keys.pending(PRODUCTS.flash.id));

    await this.stopQueue();
    // The queue is gone, so this is a new "sale epoch": rotate the fencing token in both stores.
    const saleId = randomUUID();
    let newStock: number | null = null;
    try {
      await this.deleteKeys([keys.productPattern(PRODUCTS.flash.id)]);
      const product = await this.prisma.product.update({ where: { id: PRODUCTS.flash.id }, data: { saleId } });
      newStock = reseed === 'initial' ? product.initialStock : reseed === 'db' ? product.stock : null;
      if (newStock !== null) await this.redis.mset(keys.stock(PRODUCTS.flash.id), newStock, keys.sale(PRODUCTS.flash.id), saleId);
    } finally {
      await this.queue.queue.resume();
    }

    await this.telemetry.record({
      type: 'REDIS_DATA_LOST',
      mode: 'system',
      detail: `lost ${lostJobs} queued jobs and ${lostPending} unpersisted reservations; stock re-seeded from ${reseed} -> ${newStock ?? 'missing'}`,
    });
    return { lostJobs, lostPending, newStock };
  }

  private async stopQueue(): Promise<void> {
    await this.queue.queue.pause();
    // Best effort: let active jobs finish. Anything still running afterwards is fenced out by saleId.
    const deadline = Date.now() + 10_000;
    while ((await this.queue.queue.getActiveCount()) > 0 && Date.now() < deadline) await sleep(50);
    await this.queue.queue.obliterate({ force: true });
  }

  private async deleteKeys(patterns: string[]): Promise<void> {
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, found] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        cursor = next;
        if (found.length) await this.redis.unlink(...found);
      } while (cursor !== '0');
    }
  }
}

/** Reset deletes rows while the sweeper/pay may be locking them in the opposite order: retry on deadlock (40P01). */
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const deadlock = /40P01|deadlock/i.test(String((err as { code?: string; message?: string })?.code) + String((err as Error)?.message));
      if (!deadlock || i >= attempts) throw err;
      await sleep(50 * i);
    }
  }
}
