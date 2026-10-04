import { Inject, Injectable } from '@nestjs/common';
import type { ReservationView } from '@flash/shared';
import type Redis from 'ioredis';
import { keys, PRODUCTS } from '../common/keys';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';
import { TelemetryService } from '../common/telemetry.service';
import { mapLimit } from '../common/util';
import { ReservationStatus } from '../generated/prisma/enums';
import { canTransition } from './reservation-state';
import { ReservationScripts } from './redis-scripts';

const M = keys.flashMetrics;
const PRODUCT = PRODUCTS.flash.id;

export type PayCode = 'PAID' | 'NOT_FOUND' | 'NOT_PERSISTED' | 'EXPIRED' | 'ALREADY_PAID' | 'INVALID_STATE';

export interface PayResult {
  code: PayCode;
  message: string;
}

/**
 * Reservation lifecycle after the worker persisted it: pay, expire, release.
 *
 * Every state change is a CONDITIONAL update: `UPDATE ... WHERE id = $1 AND status = 'RESERVED'`.
 * If two things race (pay vs. expire, or two sweepers expiring the same row), PostgreSQL's row
 * lock makes them run one after the other, and the second one's WHERE no longer matches,
 * so it changes 0 rows. "Did my update change exactly one row?" is how each caller learns
 * whether it won. No read-then-write, no race.
 */
@Injectable()
export class LifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scripts: ReservationScripts,
    private readonly telemetry: TelemetryService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async pay(reservationId: string): Promise<PayResult> {
    const now = new Date();
    const paid = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.reservation.updateMany({
        where: { id: reservationId, status: 'RESERVED', expiresAt: { gt: now } },
        data: { status: 'PAID', paidAt: now },
      });
      if (updated.count === 0) return false;
      await tx.order.update({ where: { reservationId }, data: { status: 'PAID' } });
      return true;
    });

    if (paid) {
      const row = await this.prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
      // Best effort: PostgreSQL already committed the payment; a Redis hiccup must not turn it into a 500.
      await this.scripts.markPaid(row.productId, reservationId).catch(() => undefined);
      await this.telemetry.record({ type: 'PAYMENT_COMPLETED', mode: 'flash', reservationId, userId: row.userId }, { hash: M, incr: { paid: 1 } });
      return { code: 'PAID', message: 'Payment completed. The unit is yours.' };
    }

    const refused = await this.explainPayRefusal(reservationId, now);
    await this.telemetry.record({ type: 'PAYMENT_REJECTED', mode: 'flash', reservationId, detail: refused.code });
    return refused;
  }

  private async explainPayRefusal(reservationId: string, now: Date): Promise<PayResult> {
    const row = await this.prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!row) {
      const redisStatus = await this.redis.hget(keys.reservation(PRODUCT, reservationId), 'status');
      if (redisStatus === 'RESERVED') {
        return { code: 'NOT_PERSISTED', message: 'Reservation accepted but not yet written to PostgreSQL by the worker. Retry in a moment.' };
      }
      return redisStatus
        ? { code: 'INVALID_STATE', message: `This reservation will not be completed (Redis status ${redisStatus}).` }
        : { code: 'NOT_FOUND', message: 'Unknown reservation.' };
    }
    if (row.status === 'PAID') return { code: 'ALREADY_PAID', message: 'Already paid.' };
    if (row.status === 'EXPIRED' || (row.status === 'RESERVED' && row.expiresAt <= now)) {
      return { code: 'EXPIRED', message: 'The reservation expired before payment.' };
    }
    return { code: 'INVALID_STATE', message: `Cannot pay a reservation in state ${row.status}.` };
  }

  /**
   * Step 1 of expiry, in ONE transaction: RESERVED -> EXPIRED, return the unit to Product.stock,
   * cancel the order. Only the caller whose UPDATE matched gets `true`.
   * (Exposed separately so tests can simulate a crash right after this commit.)
   */
  async expireInDbOnly(reservationId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.reservation.updateMany({
        where: { id: reservationId, status: 'RESERVED', ...(opts.force ? {} : { expiresAt: { lte: now } }) },
        data: { status: 'EXPIRED', expiredAt: now },
      });
      if (updated.count === 0) return false;
      const row = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
      await tx.product.update({ where: { id: row.productId }, data: { stock: { increment: 1 } } });
      await tx.order.updateMany({ where: { reservationId }, data: { status: 'CANCELLED' } });
      return true;
    });
  }

  /** Full expiry: DB transition, then give the unit back to Redis. */
  async expire(reservationId: string, opts: { force?: boolean } = {}): Promise<{ expired: boolean; reason?: string; redis?: string }> {
    const expired = await this.expireInDbOnly(reservationId, opts);
    if (!expired) {
      const row = await this.prisma.reservation.findUnique({ where: { id: reservationId } });
      const reason = !row
        ? 'not in PostgreSQL (unknown, or still in the queue)'
        : !canTransition(row.status, ReservationStatus.EXPIRED)
          ? `already ${row.status}`
          : 'not due yet';
      return { expired: false, reason };
    }
    const row = await this.prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    await this.telemetry.record({ type: 'RESERVATION_EXPIRED', mode: 'flash', reservationId, userId: row.userId }, { hash: M, incr: { expired: 1 } });
    return { expired: true, redis: await this.releaseToRedis(reservationId) };
  }

  /**
   * Step 2 of expiry: INCR the Redis stock. This is a second system, so it can't be in the
   * same transaction. It's safe to retry because the Lua script only releases a reservation
   * that Redis still sees as RESERVED. `redisReleasedAt` records that step 2 is done, and the
   * sweeper retries any EXPIRED row where it's still NULL.
   */
  async releaseToRedis(reservationId: string): Promise<string> {
    const row = await this.prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!row || row.status !== 'EXPIRED' || row.redisReleasedAt) return 'NOOP';

    const outcome = await this.scripts.release(row.productId, reservationId, row.userId, 'EXPIRED');
    if (outcome === 'RELEASED') {
      await this.telemetry.record({ type: 'STOCK_RELEASED', mode: 'flash', reservationId, userId: row.userId }, { hash: M, incr: { released: 1 } });
    } else if (outcome === 'MISSING') {
      await this.telemetry.record({
        type: 'STOCK_RELEASE_SKIPPED',
        mode: 'flash',
        reservationId,
        detail:
          'Redis has no record of this reservation (data loss?), so it was not given its unit back. Redis and PostgreSQL may now disagree: check drift, and rebuild Redis stock from the DB (reconcile + overwrite) while idle.',
      });
    }
    // 'NOT_RESERVED:EXPIRED' means an earlier attempt already released it. Fine either way.
    await this.prisma.reservation.update({ where: { id: reservationId }, data: { redisReleasedAt: new Date() } });
    return outcome;
  }

  /**
   * The expiry sweeper (the worker runs it every second). Safe to run in several processes at
   * once: every step is conditional and idempotent.
   */
  async sweep(batch = 500): Promise<{ expired: number; released: number }> {
    const due = await this.prisma.reservation.findMany({
      where: { status: 'RESERVED', expiresAt: { lte: new Date() } },
      select: { id: true },
      take: batch,
    });
    const results = await mapLimit(due, 10, (r) => this.expire(r.id));
    // Retry the Redis half for rows whose earlier attempt died between the two steps.
    const unreleased = await this.prisma.reservation.findMany({
      where: { status: 'EXPIRED', redisReleasedAt: null },
      select: { id: true },
      take: batch,
    });
    const released = await mapLimit(unreleased, 10, (r) => this.releaseToRedis(r.id));
    return {
      expired: results.filter((r) => r.expired).length,
      released: [...results.map((r) => r.redis), ...released].filter((o) => o === 'RELEASED').length,
    };
  }

  /** Demo helper: pay for a random share of the currently active reservations. */
  async payRandom(percent: number): Promise<{ attempted: number; paid: number }> {
    const active = await this.prisma.reservation.findMany({
      where: { status: 'RESERVED', expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    const chosen = active.filter(() => Math.random() * 100 < percent);
    const results = await mapLimit(chosen, 10, (r) => this.pay(r.id));
    return { attempted: chosen.length, paid: results.filter((r) => r.code === 'PAID').length };
  }

  async view(reservationId: string): Promise<ReservationView | null> {
    const [row, redisHash] = await Promise.all([
      this.prisma.reservation.findUnique({ where: { id: reservationId }, include: { order: true } }),
      this.redis.hgetall(keys.reservation(PRODUCT, reservationId)),
    ]);
    const redis = Object.keys(redisHash).length ? redisHash : null;
    if (!row && !redis) return null;
    return {
      id: reservationId,
      userId: row?.userId ?? redis?.userId ?? null,
      status: row?.status ?? redis?.status ?? 'UNKNOWN',
      persisted: !!row,
      expiresAt: row ? row.expiresAt.getTime() : redis?.expiresAt ? Number(redis.expiresAt) : null,
      createdAt: row ? row.createdAt.getTime() : redis?.createdAt ? Number(redis.createdAt) : null,
      paidAt: row?.paidAt?.getTime() ?? null,
      redis,
      order: row?.order ? { id: row.order.id, status: row.order.status } : null,
    };
  }

  async recent(limit = 20): Promise<ReservationView[]> {
    const rows = await this.prisma.reservation.findMany({ orderBy: { createdAt: 'desc' }, take: limit, include: { order: true } });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      status: row.status,
      persisted: true,
      expiresAt: row.expiresAt.getTime(),
      createdAt: row.createdAt.getTime(),
      paidAt: row.paidAt?.getTime() ?? null,
      redis: null,
      order: row.order ? { id: row.order.id, status: row.order.status } : null,
    }));
  }
}
