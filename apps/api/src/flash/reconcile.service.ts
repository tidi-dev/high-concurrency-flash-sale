import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { env } from '../common/env';
import { keys, PRODUCTS } from '../common/keys';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { REDIS } from '../common/redis';
import { TelemetryService } from '../common/telemetry.service';
import { ReservationScripts } from './redis-scripts';

const PRODUCT = PRODUCTS.flash.id;
const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

export interface ReconcileReport {
  checked: number;
  orphansReleased: number;
  skippedInQueue: number;
  redriven: number;
  driftBefore: number | null;
  driftAfter: number | null;
  stockOverwritten: boolean;
  note: string;
}

/**
 * Repairs the two-system inconsistencies that atomic Redis commands cannot prevent.
 *
 * 1. ORPHANS: Redis admitted a request (stock decremented, reservation recorded in the
 *    `pending` set) but the message never reached the queue, e.g. the API crashed in between.
 *    Nobody will ever persist or expire it, so the unit is leaked. We release reservations
 *    that are older than a grace period, have no live queue job, no PostgreSQL row, and that
 *    the worker never confirmed. The `confirmed` check happens inside a Lua script, so a worker
 *    that confirms at the same moment can't be overruled.
 *
 *    If the worker DID confirm it (so it may still reach PostgreSQL) but its job is gone, we
 *    re-publish the message instead of releasing the unit.
 *
 * 2. DRIFT: Redis stock vs. what PostgreSQL implies. Optionally overwrite Redis from the DB.
 *    That overwrite is only safe while no one is buying (it's a blind SET). In production you'd
 *    pause the sale or use a versioned/fenced update.
 *
 * In production this runs periodically with alerts. Here it's a button so you can watch the leak first.
 */
@Injectable()
export class ReconcileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scripts: ReservationScripts,
    private readonly queue: QueueService,
    private readonly telemetry: TelemetryService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** redisStock - (dbStock - pending - expiredNotYetReleasedToRedis). 0 = consistent. */
  async drift(): Promise<number | null> {
    const [raw, pending, product, unreleased] = await Promise.all([
      this.redis.get(keys.stock(PRODUCT)),
      this.redis.zcard(keys.pending(PRODUCT)),
      this.prisma.product.findUnique({ where: { id: PRODUCT } }),
      this.prisma.reservation.count({ where: { productId: PRODUCT, status: 'EXPIRED', redisReleasedAt: null } }),
    ]);
    if (raw === null || !product) return null;
    return Number(raw) - (product.stock - pending - unreleased);
  }

  async reconcile(opts: { graceMs?: number; overwriteStock?: boolean } = {}): Promise<ReconcileReport> {
    const graceMs = opts.graceMs ?? env.orphanGraceMs;
    const driftBefore = await this.drift();
    const cutoff = Date.now() - graceMs;
    const candidates = await this.redis.zrangebyscore(keys.pending(PRODUCT), 0, cutoff);

    let orphansReleased = 0;
    let skippedInQueue = 0;
    let redriven = 0;
    for (const rid of candidates) {
      const job = await this.queue.queue.getJob(rid);
      if (job && LIVE_JOB_STATES.has(await job.getState())) {
        skippedInQueue++; // just slow (e.g. worker paused), not lost
        continue;
      }
      if (await this.prisma.reservation.findUnique({ where: { id: rid }, select: { id: true } })) continue;
      const hash = await this.redis.hgetall(keys.reservation(PRODUCT, rid));
      const userId = hash.userId ?? '';
      const outcome = await this.scripts.releaseOrphan(PRODUCT, rid, userId, cutoff);
      if (outcome === 'CONFIRMED') {
        // The worker confirmed it (so we may NOT release the unit) but its job is gone: failed after
        // all retries, or lost. Re-publish the message; the worker is idempotent, so this is safe
        // even if the original attempt actually committed.
        await this.queue.add(
          {
            reservationId: rid,
            productId: PRODUCT,
            userId,
            createdAtMs: Number(hash.createdAt),
            expiresAtMs: Number(hash.expiresAt),
            saleId: hash.saleId ?? '',
          },
          `${rid}-redrive-${Date.now()}`,
        );
        redriven++;
        await this.telemetry.record(
          { type: 'REDRIVEN', mode: 'flash', reservationId: rid, userId, detail: 'confirmed by the worker but its job died; message re-published' },
          { hash: keys.flashMetrics, incr: { redriven: 1 } },
        );
      } else if (outcome === 'RELEASED') {
        orphansReleased++;
        await this.telemetry.record(
          { type: 'ORPHAN_RELEASED', mode: 'flash', reservationId: rid, userId, detail: 'admitted by Redis but never queued; unit returned' },
          { hash: keys.flashMetrics, incr: { orphansReleased: 1 } },
        );
      }
    }

    let stockOverwritten = false;
    let note = 'Released orphaned reservations; re-published messages of confirmed reservations whose job died.';
    if (opts.overwriteStock) {
      const counts = await this.queue.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      const busy = Object.values(counts).some((n) => n > 0);
      const pending = await this.redis.zcard(keys.pending(PRODUCT));
      if (busy || pending > 0) {
        note = 'Did NOT overwrite Redis stock: the queue or pending set is not empty, so a blind SET would race with in-flight work.';
      } else {
        const product = await this.prisma.product.findUniqueOrThrow({ where: { id: PRODUCT } });
        const unreleased = await this.prisma.reservation.count({ where: { productId: PRODUCT, status: 'EXPIRED', redisReleasedAt: null } });
        await this.redis.set(keys.stock(PRODUCT), product.stock - unreleased);
        stockOverwritten = true;
        note = `Overwrote Redis stock from PostgreSQL (${product.stock - unreleased}). Only safe because nothing was in flight.`;
      }
    }

    const driftAfter = await this.drift();
    await this.telemetry.record({
      type: 'RECONCILED',
      mode: 'system',
      detail: `orphans released: ${orphansReleased}, re-driven: ${redriven}, drift ${driftBefore} -> ${driftAfter}${stockOverwritten ? ' (stock overwritten)' : ''}`,
    });
    return { checked: candidates.length, orphansReleased, skippedInQueue, redriven, driftBefore, driftAfter, stockOverwritten, note };
  }
}
