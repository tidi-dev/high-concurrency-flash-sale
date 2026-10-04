import { Injectable } from '@nestjs/common';
import { DemoConfigService } from '../common/demo-config.service';
import { keys } from '../common/keys';
import { PrismaService } from '../common/prisma.service';
import type { ReservationJob } from '../common/queue.service';
import { TelemetryService } from '../common/telemetry.service';
import { sleep } from '../common/util';
import { ReservationScripts } from './redis-scripts';

export type PersistOutcome = 'CREATED' | 'DUPLICATE' | 'REJECTED' | 'REJECTED_ORPHAN' | 'STALE';

/** The message belongs to an older sale (the demo was reset / Redis lost its data since). */
class StaleSaleError extends Error {}

const M = keys.flashMetrics;

/**
 * What the worker does with one queue message. It may receive the same message more than
 * once (retries, redelivery, duplicate publish), so it must be IDEMPOTENT: applying it twice
 * has the same effect as applying it once.
 */
@Injectable()
export class PersistenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scripts: ReservationScripts,
    private readonly config: DemoConfigService,
    private readonly telemetry: TelemetryService,
  ) {}

  async persist(job: ReservationJob): Promise<PersistOutcome> {
    const cfg = await this.config.get();
    await this.telemetry.record({ type: 'WORKER_PICKED', mode: 'flash', reservationId: job.reservationId, userId: job.userId });
    if (cfg.workerDelayMs > 0) await sleep(cfg.workerDelayMs); // "slow worker" knob

    // Handshake with Redis: from now on the reconciler won't treat this reservation as orphaned.
    const handshake = await this.scripts.confirm(job.productId, job.reservationId);
    if (handshake === 'RELEASED') {
      // The reconciler already gave this unit back (we were too slow). Record it, change no stock.
      await this.prisma.reservation.createMany({
        data: [{ ...this.row(job), status: 'REJECTED', rejectReason: 'ORPHAN_RELEASED_BEFORE_PERSIST' }],
        skipDuplicates: true,
      });
      await this.emit('REJECTED_ORPHAN', job);
      return 'REJECTED_ORPHAN';
    }
    if (handshake === 'OK') await this.telemetry.record(null, { hash: M, incr: { confirmed: 1 } });
    // handshake === 'MISSING': Redis lost its copy (e.g. data loss). Carry on, because PostgreSQL decides.

    const outcome = cfg.workerIdempotency === 'broken' ? await this.persistBroken(job) : await this.persistIdempotent(job);
    if (outcome === 'CREATED' || outcome === 'DUPLICATE') {
      // Only now, after the commit, is the reservation no longer "admitted but not persisted".
      await this.scripts.clearPending(job.productId, job.reservationId);
    } else {
      // REJECTED / STALE: PostgreSQL never had this unit, so no INCR. Free the user and stop tracking it.
      await this.scripts.markRejected(job.productId, job.reservationId, job.userId).catch(() => undefined);
    }
    await this.emit(outcome, job);
    return outcome;
  }

  /**
   * Correct version. One transaction:
   *   1. INSERT the reservation with ON CONFLICT DO NOTHING (skipDuplicates). Primary key = reservationId.
   *      0 rows inserted means we've seen this message before, so stop: no side effects.
   *   2. Guarded stock decrement: UPDATE ... SET stock = stock - 1 WHERE stock > 0.
   *      PostgreSQL re-checks the stock itself. Redis is fast, PostgreSQL has the final say.
   *   3. Create the order (Order.reservationId is UNIQUE as a second safety net).
   * Either all three happen or none do.
   */
  private persistIdempotent(job: ReservationJob): Promise<PersistOutcome> {
    return this.prisma
      .$transaction(async (tx) => {
        const inserted = await tx.reservation.createMany({ data: [{ ...this.row(job), status: 'RESERVED' }], skipDuplicates: true });
        if (inserted.count === 0) return 'DUPLICATE' as const;

        // Guarded decrement + FENCING TOKEN: only for the sale this message was admitted under.
        const decremented = await tx.product.updateMany({
          where: { id: job.productId, saleId: job.saleId ?? '(none)', stock: { gt: 0 } },
          data: { stock: { decrement: 1 } },
        });
        if (decremented.count === 0) {
          const product = await tx.product.findUnique({ where: { id: job.productId } });
          if (!product || product.saleId !== job.saleId) throw new StaleSaleError(); // roll back the insert too
          await tx.reservation.update({ where: { id: job.reservationId }, data: { status: 'REJECTED', rejectReason: 'NO_STOCK_IN_DATABASE' } });
          return 'REJECTED' as const;
        }

        await tx.order.create({
          data: { productId: job.productId, reservationId: job.reservationId, userId: job.userId, source: 'FLASH', status: 'PENDING_PAYMENT' },
        });
        return 'CREATED' as const;
      })
      .catch((err: unknown) => {
        if (err instanceof StaleSaleError) return 'STALE' as const;
        throw err; // anything else: BullMQ retries the job (the transaction was rolled back)
      });
  }

  /**
   * INTENTIONALLY BROKEN (demo knob `workerIdempotency=broken`).
   * Looks idempotent ("we have a unique key!"), but the stock decrement happens BEFORE and
   * OUTSIDE the duplicate check, so a redelivered message decrements stock again.
   */
  private async persistBroken(job: ReservationJob): Promise<PersistOutcome> {
    const product = await this.prisma.product.findUnique({ where: { id: job.productId } });
    if (!product || product.saleId !== job.saleId) return 'STALE'; // (the fence isn't what this mode is about)
    await this.prisma.product.update({ where: { id: job.productId }, data: { stock: { decrement: 1 } } });
    const inserted = await this.prisma.reservation.createMany({ data: [{ ...this.row(job), status: 'RESERVED' }], skipDuplicates: true });
    if (inserted.count === 0) return 'DUPLICATE';
    await this.prisma.order.create({
      data: { productId: job.productId, reservationId: job.reservationId, userId: job.userId, source: 'FLASH', status: 'PENDING_PAYMENT' },
    });
    return 'CREATED';
  }

  private row(job: ReservationJob) {
    return { id: job.reservationId, productId: job.productId, userId: job.userId, expiresAt: new Date(job.expiresAtMs), createdAt: new Date(job.createdAtMs) };
  }

  private emit(outcome: PersistOutcome, job: ReservationJob): Promise<void> {
    const base = { mode: 'flash' as const, reservationId: job.reservationId, userId: job.userId };
    switch (outcome) {
      case 'CREATED':
        return this.telemetry.record({ ...base, type: 'ORDER_CREATED', detail: 'reservation + order persisted in PostgreSQL' }, { hash: M, incr: { persisted: 1 } });
      case 'DUPLICATE':
        return this.telemetry.record({ ...base, type: 'DUPLICATE_MESSAGE_IGNORED' }, { hash: M, incr: { duplicatesIgnored: 1 } });
      case 'REJECTED':
        return this.telemetry.record({ ...base, type: 'RESERVATION_REJECTED', detail: 'PostgreSQL has no stock left (Redis and DB disagree)' }, { hash: M, incr: { rejected: 1 } });
      case 'STALE':
        return this.telemetry.record(
          { ...base, type: 'STALE_MESSAGE_DROPPED', detail: 'message from an older sale (reset / Redis data loss since): fenced out by saleId' },
          { hash: M, incr: { staleDropped: 1 } },
        );
      case 'REJECTED_ORPHAN':
        return this.telemetry.record({ ...base, type: 'RESERVATION_REJECTED', detail: 'unit was already released by the reconciler' }, { hash: M, incr: { rejected: 1 } });
    }
  }
}
