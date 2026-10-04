// These tests run the real Lua scripts against a real Redis (DB 1).
// Start it with `npm run infra` (docker compose up -d postgres redis).
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { keys } from '../common/keys';
import { ReservationScripts } from './redis-scripts';

describe('Redis reservation scripts', () => {
  let redis: Redis;
  let scripts: ReservationScripts;
  let productId: string;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL!);
    scripts = new ReservationScripts(redis);
  });
  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    productId = `test-${randomUUID()}`; // isolate every test
  });
  afterEach(async () => {
    const found = await redis.keys(keys.productPattern(productId));
    if (found.length) await redis.del(...found);
  });

  const seed = (stock: number, saleId = 'sale-1') => redis.mset(keys.stock(productId), stock, keys.sale(productId), saleId);
  const reserve = (userId: string, reservationId: string = randomUUID(), now = Date.now()) =>
    scripts.reserve({ productId, reservationId, userId, nowMs: now, expiresAtMs: now + 30_000 });

  describe('reserve (Lua strategy)', () => {
    it('admits, decrements, and records the reservation atomically', async () => {
      await seed(2);
      const res = await reserve('u1', 'r1', 1000);

      expect(res).toEqual({ result: 'ALLOWED', remaining: 1, saleId: 'sale-1' });
      expect(await redis.get(keys.stock(productId))).toBe('1');
      expect(await redis.hgetall(keys.reservation(productId, 'r1'))).toEqual({
        status: 'RESERVED',
        userId: 'u1',
        createdAt: '1000',
        expiresAt: '31000',
        confirmed: '0',
        saleId: 'sale-1',
      });
      expect(await redis.get(keys.user(productId, 'u1'))).toBe('r1');
      expect(await redis.zscore(keys.pending(productId), 'r1')).toBe('1000');
    });

    it('returns SOLD_OUT without touching stock when stock is 0', async () => {
      await seed(0);
      expect(await reserve('u1')).toEqual({ result: 'SOLD_OUT', remaining: 0 });
      expect(await redis.get(keys.stock(productId))).toBe('0');
    });

    it('enforces one reservation per user', async () => {
      await seed(5);
      await reserve('u1', 'r1');
      // The retry learns WHICH reservation it already holds, so a client whose first response
      // was lost can still go on to pay.
      expect(await reserve('u1', 'r2')).toMatchObject({ result: 'ALREADY_RESERVED', remaining: 4, existingReservationId: 'r1' });
      expect(await redis.get(keys.stock(productId))).toBe('4');
    });

    it('refuses when the stock key was never seeded (instead of silently creating it like DECR would)', async () => {
      expect(await reserve('u1')).toEqual({ result: 'NOT_INITIALIZED', remaining: -1 });
      expect(await redis.exists(keys.stock(productId))).toBe(0);
    });

    it('admits exactly `stock` out of 1,000 parallel attempts and never goes negative', async () => {
      await seed(100);
      const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => reserve(`u${i}`)));

      const allowed = results.filter((r) => r.result === 'ALLOWED');
      expect(allowed).toHaveLength(100);
      expect(results.filter((r) => r.result === 'SOLD_OUT')).toHaveLength(900);
      expect(Math.min(...results.map((r) => r.remaining))).toBeGreaterThanOrEqual(0);
      expect(await redis.get(keys.stock(productId))).toBe('0');
      expect(await redis.zcard(keys.pending(productId))).toBe(100);
    });
  });

  describe('reserve (decr strategy: the interview version)', () => {
    const reserveDecr = (userId: string, reservationId: string = randomUUID()) =>
      scripts.reserveWithDecr({ productId, reservationId, userId, nowMs: Date.now(), expiresAtMs: Date.now() + 30_000 });

    it('also admits exactly `stock`, but the counter dips below zero along the way', async () => {
      await seed(100);
      const results = await Promise.all(Array.from({ length: 1000 }, (_, i) => reserveDecr(`u${i}`)));

      expect(results.filter((r) => r.result === 'ALLOWED')).toHaveLength(100);
      expect(await redis.get(keys.stock(productId))).toBe('0'); // settles back to 0...
      const observed = Math.min(...results.map((r) => r.observed));
      expect(observed).toBeLessThan(0); // ...but other readers could see negative values meanwhile
      expect(results.filter((r) => r.compensated)).toHaveLength(900);
    });
  });

  describe('confirm (worker handshake)', () => {
    it('marks the reservation confirmed but keeps it pending until PostgreSQL has it', async () => {
      await seed(1);
      await reserve('u1', 'r1');
      expect(await scripts.confirm(productId, 'r1')).toBe('OK');
      expect(await redis.hget(keys.reservation(productId, 'r1'), 'confirmed')).toBe('1');
      // Still pending: if the DB write then fails for good, the reconciler must still be able to find it.
      expect(await redis.zscore(keys.pending(productId), 'r1')).not.toBeNull();
      await scripts.clearPending(productId, 'r1');
      expect(await redis.zscore(keys.pending(productId), 'r1')).toBeNull();
    });

    it('reports RELEASED if the reconciler already gave the unit back', async () => {
      await seed(1);
      await reserve('u1', 'r1', 1000);
      expect(await scripts.releaseOrphan(productId, 'r1', 'u1', 2000)).toBe('RELEASED');
      expect(await scripts.confirm(productId, 'r1')).toBe('RELEASED');
    });

    it('reports MISSING when Redis has no record (e.g. after data loss)', async () => {
      expect(await scripts.confirm(productId, 'nope')).toBe('MISSING');
    });
  });

  describe('release (expiry)', () => {
    it('returns the unit exactly once no matter how often it runs', async () => {
      await seed(1);
      await reserve('u1', 'r1');
      expect(await redis.get(keys.stock(productId))).toBe('0');

      const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => scripts.release(productId, 'r1', 'u1', 'EXPIRED')));

      expect(outcomes.filter((o) => o === 'RELEASED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'NOT_RESERVED:EXPIRED')).toHaveLength(4);
      expect(await redis.get(keys.stock(productId))).toBe('1');
      expect(await redis.hget(keys.reservation(productId, 'r1'), 'status')).toBe('EXPIRED');
      expect(await redis.exists(keys.user(productId, 'u1'))).toBe(0); // user may buy again
      expect(await redis.ttl(keys.reservation(productId, 'r1'))).toBeGreaterThan(0); // garbage-collected later
    });

    it('does nothing for a PAID reservation', async () => {
      await seed(1);
      await reserve('u1', 'r1');
      expect(await scripts.markPaid(productId, 'r1')).toBe('PAID');
      expect(await scripts.release(productId, 'r1', 'u1', 'EXPIRED')).toBe('NOT_RESERVED:PAID');
      expect(await redis.get(keys.stock(productId))).toBe('0');
    });

    it('reports MISSING and does not INCR when the record is gone', async () => {
      await seed(0);
      expect(await scripts.release(productId, 'ghost', 'u1', 'EXPIRED')).toBe('MISSING');
      expect(await redis.get(keys.stock(productId))).toBe('0');
    });

    it('does not delete the user key if it now points at a newer reservation', async () => {
      await seed(2);
      await reserve('u1', 'r1');
      await scripts.release(productId, 'r1', 'u1', 'EXPIRED');
      await reserve('u1', 'r2');
      expect(await scripts.release(productId, 'r1', 'u1', 'EXPIRED')).toBe('NOT_RESERVED:EXPIRED');
      expect(await redis.get(keys.user(productId, 'u1'))).toBe('r2');
    });
  });

  describe('markRejected (worker found no stock in PostgreSQL)', () => {
    it('marks REJECTED, frees the user to try again, leaves pending, sets a GC TTL, and does NOT give stock back', async () => {
      await seed(1);
      await reserve('u1', 'r1');
      expect(await scripts.markRejected(productId, 'r1', 'u1')).toBe('REJECTED');
      expect(await redis.hget(keys.reservation(productId, 'r1'), 'status')).toBe('REJECTED');
      expect(await redis.exists(keys.user(productId, 'u1'))).toBe(0);
      expect(await redis.zscore(keys.pending(productId), 'r1')).toBeNull();
      expect(await redis.ttl(keys.reservation(productId, 'r1'))).toBeGreaterThan(0);
      expect(await redis.get(keys.stock(productId))).toBe('0');
    });

    it('does not create a stray hash when Redis has no record', async () => {
      expect(await scripts.markRejected(productId, 'ghost', 'u1')).toBe('MISSING');
      expect(await redis.exists(keys.reservation(productId, 'ghost'))).toBe(0);
    });
  });

  describe('waitlist', () => {
    const join = (userId: string, now = Date.now()) => scripts.joinWaitlist(productId, userId, now);

    it('refuses to queue people while stock is still available (just buy)', async () => {
      await seed(1);
      expect(await join('u1')).toEqual({ result: 'STOCK_AVAILABLE', position: 0 });
      expect(await redis.zcard(keys.waitlist(productId))).toBe(0);
    });

    it('queues sold-out shoppers in arrival order, once each', async () => {
      await seed(0);
      expect(await join('u1', 1000)).toEqual({ result: 'WAITING', position: 1 });
      expect(await join('u2', 2000)).toEqual({ result: 'WAITING', position: 2 });
      expect(await join('u1', 3000)).toEqual({ result: 'WAITING', position: 1 }); // joining again keeps your place
    });

    it('refuses a shopper who already holds a reservation', async () => {
      await seed(1);
      await reserve('u1', 'r1');
      expect(await join('u1')).toEqual({ result: 'ALREADY_RESERVED', position: 0 });
    });

    it('a released unit goes to the FIRST person in line, atomically, never back to the public', async () => {
      await seed(1);
      await reserve('u1', 'r1');
      await join('w1', 1000);
      await join('w2', 2000);

      const out = await scripts.release(productId, 'r1', 'u1', 'EXPIRED', { reservationId: 'r-w1', nowMs: 5000, expiresAtMs: 35000 });

      expect(out).toBe('HANDED_OFF:w1');
      expect(await redis.get(keys.stock(productId))).toBe('0'); // a random buyer can't snipe it
      expect(await redis.hgetall(keys.reservation(productId, 'r-w1'))).toMatchObject({
        status: 'RESERVED',
        userId: 'w1',
        expiresAt: '35000',
        saleId: 'sale-1',
        via: 'waitlist',
      });
      expect(await redis.get(keys.user(productId, 'w1'))).toBe('r-w1');
      expect(await redis.zscore(keys.pending(productId), 'r-w1')).toBe('5000');
      expect(await redis.zrange(keys.waitlist(productId), 0, -1)).toEqual(['w2']);
    });

    it('skips waitlisted shoppers who meanwhile got a unit another way', async () => {
      await seed(2);
      await reserve('u1', 'r1');
      await reserve('w1', 'r2'); // w1 joined earlier, then bought normally... (stale entry)
      await redis.zadd(keys.waitlist(productId), 1, 'w1', 2, 'w2');

      expect(await scripts.release(productId, 'r1', 'u1', 'EXPIRED', { reservationId: 'r-w', nowMs: 5000, expiresAtMs: 35000 })).toBe('HANDED_OFF:w2');
    });

    it('with an empty waitlist the unit goes back to the public stock as before', async () => {
      await seed(1);
      await reserve('u1', 'r1');
      expect(await scripts.release(productId, 'r1', 'u1', 'EXPIRED')).toBe('RELEASED');
      expect(await redis.get(keys.stock(productId))).toBe('1');
    });

    it('the orphan reconciler hands off too', async () => {
      await seed(1);
      await reserve('u1', 'r1', 1000);
      await join('w1', 1500);
      expect(await scripts.releaseOrphan(productId, 'r1', 'u1', 5000, { reservationId: 'r-w1', nowMs: 6000, expiresAtMs: 36000 })).toBe('HANDED_OFF:w1');
      expect(await redis.get(keys.stock(productId))).toBe('0');
    });

    it('a normal successful buy removes the buyer from the waitlist', async () => {
      await seed(0);
      await join('w1');
      await redis.set(keys.stock(productId), 1); // a unit appears (e.g. stock overwrite)
      await reserve('w1', 'r1');
      expect(await redis.zcard(keys.waitlist(productId))).toBe(0);
    });
  });

  describe('releaseOrphan (reconciler)', () => {
    it('releases an unconfirmed reservation older than the cutoff', async () => {
      await seed(1);
      await reserve('u1', 'r1', 1000);
      expect(await scripts.releaseOrphan(productId, 'r1', 'u1', 5000)).toBe('RELEASED');
      expect(await redis.get(keys.stock(productId))).toBe('1');
      expect(await redis.hget(keys.reservation(productId, 'r1'), 'status')).toBe('ORPHAN_RELEASED');
      expect(await redis.zcard(keys.pending(productId))).toBe(0);
    });

    it('refuses a reservation the worker already confirmed (it will reach PostgreSQL)', async () => {
      await seed(1);
      await reserve('u1', 'r1', 1000);
      await scripts.confirm(productId, 'r1');
      expect(await scripts.releaseOrphan(productId, 'r1', 'u1', 5000)).toBe('CONFIRMED');
      expect(await redis.get(keys.stock(productId))).toBe('0');
    });

    it('refuses a reservation younger than the cutoff', async () => {
      await seed(1);
      await reserve('u1', 'r1', 9000);
      expect(await scripts.releaseOrphan(productId, 'r1', 'u1', 5000)).toBe('TOO_YOUNG');
    });
  });
});
