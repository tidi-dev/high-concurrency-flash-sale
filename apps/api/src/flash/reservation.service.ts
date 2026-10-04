import { Injectable } from '@nestjs/common';
import type { BuyResponse } from '@flash/shared';
import { randomUUID } from 'node:crypto';
import { DemoConfigService } from '../common/demo-config.service';
import { keys, PRODUCTS } from '../common/keys';
import { QueueService, ReservationJob } from '../common/queue.service';
import { TelemetryService } from '../common/telemetry.service';
import { ReservationScripts } from './redis-scripts';

const PRODUCT = PRODUCTS.flash.id;
const M = keys.flashMetrics;

/** Thrown by the "crash after reservation" failure simulation. */
export class SimulatedCrashError extends Error {
  constructor(readonly reservationId: string) {
    super('Simulated API crash after the Redis reservation, before publishing to the queue');
  }
}

/**
 * Mode B request path. The ONLY thing that happens synchronously, while the user waits:
 *
 *   1. atomic admission in Redis (Lua script or DECR)
 *   2. publish a message to the queue (if admitted)
 *   3. answer immediately
 *
 * PostgreSQL is not touched here. That is the whole point: 2,000,000 requests become
 * at most `stock` queue messages, and the database only ever sees those.
 */
@Injectable()
export class ReservationService {
  constructor(
    private readonly scripts: ReservationScripts,
    private readonly queue: QueueService,
    private readonly config: DemoConfigService,
    private readonly telemetry: TelemetryService,
  ) {}

  async reserve(userId: string = `anon-${randomUUID()}`): Promise<BuyResponse> {
    const cfg = await this.config.get();
    // The reservation id is created HERE, before anything is persisted. It travels in the
    // queue message and becomes the PostgreSQL primary key: our idempotency key.
    const reservationId = randomUUID();
    const nowMs = Date.now();
    const expiresAtMs = nowMs + cfg.reservationTtlSec * 1000;
    const input = { productId: PRODUCT, reservationId, userId, nowMs, expiresAtMs };

    let result: 'ALLOWED' | 'SOLD_OUT' | 'ALREADY_RESERVED' | 'NOT_INITIALIZED';
    let saleId = '';
    let remaining = 0;
    let existingReservationId: string | undefined;
    if (cfg.reserveStrategy === 'lua') {
      const r = await this.scripts.reserve(input);
      result = r.result;
      remaining = r.remaining;
      saleId = r.saleId ?? '';
      existingReservationId = r.existingReservationId;
    } else {
      const r = await this.scripts.reserveWithDecr(input);
      result = r.result;
      remaining = r.remaining;
      saleId = r.saleId ?? '';
      if (r.compensated) {
        await this.scripts.recordMinObserved(r.observed);
        await this.telemetry.record(null, { hash: M, incr: { compensations: 1 } });
      }
    }

    if (result !== 'ALLOWED') {
      const field = result === 'SOLD_OUT' ? 'soldOut' : result === 'ALREADY_RESERVED' ? 'alreadyReserved' : 'errors';
      await this.telemetry.record(
        { type: result, mode: 'flash', userId, reservationId: existingReservationId, detail: result === 'NOT_INITIALIZED' ? 'stock key missing in Redis' : undefined },
        { hash: M, incr: { requests: 1, [field]: 1 } },
      );
      // ALREADY_RESERVED tells the client which reservation it holds: if its first response was
      // lost, the retry can still pay. (Same effect as a replayed idempotent request.)
      return { status: result, reservationId: existingReservationId, message: MESSAGES[result](cfg.reservationTtlSec) };
    }

    await this.telemetry.record(
      { type: 'RESERVATION_ALLOWED', mode: 'flash', reservationId, userId, detail: `${remaining} left` },
      { hash: M, incr: { requests: 1, allowed: 1 } },
    );

    // ---- Failure simulation: the process dies between the two writes (Redis, then queue). ----
    if (cfg.crashAfterReservePercent > 0 && Math.random() * 100 < cfg.crashAfterReservePercent) {
      await this.telemetry.record(
        { type: 'ENQUEUE_FAILED', mode: 'flash', reservationId, userId, detail: 'simulated crash: unit is held in Redis but no message exists' },
        { hash: M, incr: { enqueueFailed: 1 } },
      );
      throw new SimulatedCrashError(reservationId);
    }

    const job: ReservationJob = { reservationId, productId: PRODUCT, userId, createdAtMs: nowMs, expiresAtMs, saleId };
    await this.queue.add(job);
    if (cfg.duplicateDelivery) {
      // At-least-once delivery in action: the same logical message arrives twice.
      // A different jobId bypasses BullMQ's own dedupe, like a redelivery would.
      await this.queue.add(job, `${reservationId}-redelivery`);
    }
    await this.telemetry.record({ type: 'ORDER_QUEUED', mode: 'flash', reservationId, userId }, { hash: M, incr: { queued: 1 } });

    return { status: 'RESERVED', reservationId, expiresAt: expiresAtMs, message: MESSAGES.ALLOWED(cfg.reservationTtlSec) };
  }
}

const MESSAGES: Record<'ALLOWED' | 'SOLD_OUT' | 'ALREADY_RESERVED' | 'NOT_INITIALIZED', (ttl: number) => string> = {
  ALLOWED: (ttl: number) => `Reserved for ${ttl} seconds. Complete payment before the reservation expires.`,
  SOLD_OUT: () => 'Sold out.',
  ALREADY_RESERVED: () => 'You already hold a reservation for this product (see reservationId).',
  NOT_INITIALIZED: () => 'Sale not initialized: the Redis stock key does not exist (reset the demo).',
};
