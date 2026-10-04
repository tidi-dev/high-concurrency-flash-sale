import { Inject, Injectable } from '@nestjs/common';
import type { WaitlistStatus } from '@flash/shared';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DemoConfigService } from '../common/demo-config.service';
import { keys, PRODUCTS } from '../common/keys';
import { QueueService } from '../common/queue.service';
import { REDIS } from '../common/redis';
import { TelemetryService } from '../common/telemetry.service';
import { Handoff, ReservationScripts } from './redis-scripts';

const PRODUCT = PRODUCTS.flash.id;
const M = keys.flashMetrics;
const HANDED_OFF = 'HANDED_OFF:';

/**
 * Waitlist for sold-out shoppers.
 *
 * A unit can come back after "sold out": a reservation expires unpaid, or the reconciler frees a
 * leaked one. Instead of putting it back in the public stock (where whoever retries fastest grabs it),
 * the release script gives it to the FIRST shopper on the waitlist, in the same atomic step, as a
 * fresh reservation (see GIVE_BACK_LUA). This service does the rest:
 *   - publishes that reservation's queue message, so it is persisted like any other reservation
 *     (if we crash before publishing, it's an ordinary orphan: the reconciler releases it to the next
 *     person in line);
 *   - "notifies" the shopper: an event on the live stream plus a notice their client can poll.
 *     In production this would be a push notification, email or SMS.
 */
@Injectable()
export class WaitlistService {
  constructor(
    private readonly scripts: ReservationScripts,
    private readonly queue: QueueService,
    private readonly config: DemoConfigService,
    private readonly telemetry: TelemetryService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The reservation a freed unit would become if someone is waiting. */
  async newHandoff(): Promise<Handoff> {
    const { reservationTtlSec } = await this.config.get();
    const nowMs = Date.now();
    return { reservationId: randomUUID(), nowMs, expiresAtMs: nowMs + reservationTtlSec * 1000 };
  }

  async join(userId: string): Promise<WaitlistStatus> {
    const { result, position } = await this.scripts.joinWaitlist(PRODUCT, userId, Date.now());
    if (result === 'WAITING') {
      await this.redis.del(keys.notice(PRODUCT, userId)); // a fresh wait replaces an old, finished offer
      await this.telemetry.record({ type: 'WAITLIST_JOINED', mode: 'flash', userId, detail: `#${position} in line` }, { hash: M, incr: { waitlistJoined: 1 } });
      return { status: 'WAITING', position, message: `You're #${position} in line. If a sneaker comes back, it will be held for you.` };
    }
    const message = {
      STOCK_AVAILABLE: 'Not sold out right now: just buy.',
      ALREADY_RESERVED: 'You already hold a reservation for this product.',
      NOT_INITIALIZED: 'Sale not initialized.',
    }[result];
    return { status: result, message };
  }

  async leave(userId: string): Promise<void> {
    await this.redis.zrem(keys.waitlist(PRODUCT), userId);
  }

  async status(userId: string): Promise<WaitlistStatus> {
    const [notice, rank] = await Promise.all([this.redis.hgetall(keys.notice(PRODUCT, userId)), this.redis.zrank(keys.waitlist(PRODUCT), userId)]);
    if (notice.reservationId) {
      const current = await this.redis.hget(keys.reservation(PRODUCT, notice.reservationId), 'status');
      const status = current === 'RESERVED' ? 'OFFERED' : current === 'PAID' ? 'PAID' : 'OFFER_ENDED';
      const message = {
        OFFERED: 'A sneaker came back and is held for you. Pay before the timer runs out!',
        PAID: 'Paid. The sneaker is yours.',
        OFFER_ENDED: 'Your held sneaker was not paid in time and went to the next person in line.',
      }[status];
      return { status, reservationId: notice.reservationId, expiresAt: Number(notice.expiresAt), message };
    }
    if (rank !== null) return { status: 'WAITING', position: rank + 1, message: `You're #${rank + 1} in line.` };
    return { status: 'NONE', message: 'Not on the waitlist.' };
  }

  length(): Promise<number> {
    return this.redis.zcard(keys.waitlist(PRODUCT));
  }

  /** Call after a release script: if it handed the unit to a waitlisted shopper, publish and notify. */
  async afterRelease(productId: string, outcome: string, handoff: Handoff): Promise<void> {
    if (!outcome.startsWith(HANDED_OFF)) return;
    const userId = outcome.slice(HANDED_OFF.length);
    const saleId = (await this.redis.hget(keys.reservation(productId, handoff.reservationId), 'saleId')) ?? '';
    await this.queue.add({ reservationId: handoff.reservationId, productId, userId, createdAtMs: handoff.nowMs, expiresAtMs: handoff.expiresAtMs, saleId });
    const notice = keys.notice(productId, userId);
    await this.redis
      .multi()
      .hset(notice, { reservationId: handoff.reservationId, expiresAt: handoff.expiresAtMs, offeredAt: handoff.nowMs })
      .expire(notice, Math.ceil((handoff.expiresAtMs - handoff.nowMs) / 1000) + 3600)
      .exec();
    await this.telemetry.record(
      { type: 'WAITLIST_OFFERED', mode: 'flash', reservationId: handoff.reservationId, userId, detail: 'a unit came back: held for the first shopper in line' },
      { hash: M, incr: { waitlistOffered: 1 } },
    );
  }
}

export const isFreed = (outcome: string) => outcome === 'RELEASED' || outcome.startsWith(HANDED_OFF);
