// Failure scenarios that Redis atomicity alone does NOT solve, and what repairs them.
import request from 'supertest';
import { keys } from '../src/common/keys';
import { ReconcileService } from '../src/flash/reconcile.service';
import { ReservationScripts } from '../src/flash/redis-scripts';
import { ReservationService, SimulatedCrashError } from '../src/flash/reservation.service';
import { StateService } from '../src/admin/state.service';
import { bootstrap, conservation, countByStatus, dbStock, drainManually, FLASH, redisStock, TestCtx } from './helpers';

describe('failure scenarios', () => {
  let ctx: TestCtx;
  let reservations: ReservationService;
  let reconcile: ReconcileService;
  beforeAll(async () => {
    ctx = await bootstrap();
    reservations = ctx.get(ReservationService);
    reconcile = ctx.get(ReconcileService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe('API crashes after the Redis reservation, before publishing to the queue', () => {
    beforeEach(async () => {
      await ctx.admin.reset(10, { resetConfig: true });
    });

    it('leaks a unit (Redis 9, PostgreSQL 10), and reconcile gives it back', async () => {
      await ctx.config.update({ crashAfterReservePercent: 100 });
      await expect(reservations.reserve('alice')).rejects.toBeInstanceOf(SimulatedCrashError);

      expect(await redisStock(ctx)).toBe(9);
      expect(await dbStock(ctx)).toBe(10);
      expect(await drainManually(ctx)).toEqual([]); // no message exists: nobody will ever persist it
      // drift = redis - (db - pending) = 9 - (10 - 1) = 0: it's still "pending", so it looks in flight...
      expect(await reconcile.drift()).toBe(0);
      // ...which is why the dashboard has a separate orphan check.
      const before = await ctx.get(StateService).snapshot();
      expect(before.flash.invariants.find((i) => i.id === 'flash-no-orphans')?.ok).toBe(false);

      const report = await reconcile.reconcile({ graceMs: 0 });
      expect(report.orphansReleased).toBe(1);
      expect(await redisStock(ctx)).toBe(10);
      expect(await ctx.redis.zcard(keys.pending(FLASH))).toBe(0);
      expect(report.driftAfter).toBe(0);
    });

    it('does not release a reservation that is merely waiting in a paused queue', async () => {
      await ctx.admin.pauseWorker();
      await reservations.reserve('alice');

      const report = await reconcile.reconcile({ graceMs: 0 });

      expect(report).toMatchObject({ orphansReleased: 0, skippedInQueue: 1 });
      expect(await redisStock(ctx)).toBe(9);
      await ctx.admin.resumeWorker();
      expect(await drainManually(ctx)).toEqual(['CREATED']);
      expect((await conservation(ctx)).ok).toBe(true);
    });

    it('if the worker arrives after the reconciler released the unit, it records REJECTED and changes no stock', async () => {
      const r = await reservations.reserve('alice');
      const job = (await ctx.queue.queue.getJob(r.reservationId!))!;
      await job.remove(); // message lost (but we kept a copy to deliver late)
      await reconcile.reconcile({ graceMs: 0 });
      expect(await redisStock(ctx)).toBe(10);

      await ctx.queue.add(job.data, `${r.reservationId}-late`);
      expect(await drainManually(ctx)).toEqual(['REJECTED_ORPHAN']);
      expect(await dbStock(ctx)).toBe(10);
      expect((await countByStatus(ctx)).REJECTED).toBe(1);
    });
  });

  describe('the worker confirmed a reservation but its job then died (e.g. PostgreSQL down for all retries)', () => {
    it('stays visible as pending, and reconcile re-publishes the message instead of leaking the unit', async () => {
      await ctx.admin.reset(10, { resetConfig: true });
      const r = await reservations.reserve('alice');
      const job = (await ctx.queue.queue.getJob(r.reservationId!))!;
      // The worker got as far as the Redis handshake, then every DB attempt failed and the job is gone.
      expect(await ctx.get(ReservationScripts).confirm(FLASH, r.reservationId!)).toBe('OK');
      await job.remove();

      expect(await ctx.redis.zcard(keys.pending(FLASH))).toBe(1); // still visible
      const snap = await ctx.get(StateService).snapshot();
      expect(snap.flash.invariants.find((i) => i.id === 'flash-no-orphans')?.ok).toBe(false);

      const report = await reconcile.reconcile({ graceMs: 0 });
      expect(report).toMatchObject({ orphansReleased: 0, redriven: 1 });
      expect(await drainManually(ctx)).toEqual(['CREATED']);

      expect(await ctx.redis.zcard(keys.pending(FLASH))).toBe(0);
      expect(await redisStock(ctx)).toBe(9);
      expect(await dbStock(ctx)).toBe(9);
      expect(await reconcile.drift()).toBe(0);
    });
  });

  describe('stale messages from a previous sale (fencing token)', () => {
    it('a message admitted before a reset cannot write into the new sale', async () => {
      await ctx.admin.reset(5, { resetConfig: true });
      const r = await reservations.reserve('alice');
      const stale = (await ctx.queue.queue.getJob(r.reservationId!))!.data;

      await ctx.admin.reset(5, { resetConfig: true }); // new sale, new saleId
      await ctx.queue.add(stale, `${r.reservationId}-straggler`); // e.g. an enqueue that landed after the reset

      expect(await drainManually(ctx)).toEqual(['STALE']);
      expect(await ctx.prisma.reservation.count()).toBe(0);
      expect(await dbStock(ctx)).toBe(5);
      expect(await redisStock(ctx)).toBe(5);
      expect(await reconcile.drift()).toBe(0);
    });
  });

  describe('Redis loses its data', () => {
    beforeEach(async () => {
      await ctx.admin.reset(20, { resetConfig: true });
      for (let i = 0; i < 10; i++) await reservations.reserve(`early-${i}`);
      await drainManually(ctx); // 10 RESERVED in PostgreSQL, DB stock 10
    });

    it('re-seeding from the INITIAL stock re-admits sold units; only the PostgreSQL guard prevents oversell', async () => {
      await ctx.admin.simulateRedisDataLoss('initial');
      expect(await redisStock(ctx)).toBe(20); // wrong: 10 are already held

      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reservations.reserve(`late-${i}`)));
      expect(results.filter((r) => r.status === 'RESERVED')).toHaveLength(20); // 20 users told "reserved"

      const outcomes = await drainManually(ctx);
      expect(outcomes.filter((o) => o === 'CREATED')).toHaveLength(10);
      expect(outcomes.filter((o) => o === 'REJECTED')).toHaveLength(10); // 10 of them get bad news later

      const c = await countByStatus(ctx);
      expect(c.RESERVED + c.PAID).toBe(20); // never more than the 20 units
      expect(await dbStock(ctx)).toBe(0);
      expect((await conservation(ctx)).ok).toBe(true);
    });

    it('re-seeding from PostgreSQL admits exactly what is really left', async () => {
      await ctx.admin.simulateRedisDataLoss('db');
      expect(await redisStock(ctx)).toBe(10);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reservations.reserve(`late-${i}`)));
      expect(results.filter((r) => r.status === 'RESERVED')).toHaveLength(10);
      expect((await drainManually(ctx)).every((o) => o === 'CREATED')).toBe(true);
      expect((await conservation(ctx)).ok).toBe(true);
    });

    it('not re-seeding at all: buys are refused with NOT_INITIALIZED (503)', async () => {
      await ctx.admin.simulateRedisDataLoss('none');
      const res = await request(ctx.app.getHttpServer()).post('/api/flash-sale/buy').send({ userId: 'x' }).expect(503);
      expect(res.body.status).toBe('NOT_INITIALIZED');
    });
  });

  it('re-delivering already-processed messages is harmless', async () => {
    await ctx.admin.reset(5, { resetConfig: true });
    for (const u of ['a', 'b', 'c']) await reservations.reserve(u);
    await drainManually(ctx);

    await ctx.admin.duplicateDelivery(3);
    expect(await drainManually(ctx)).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
    expect(await dbStock(ctx)).toBe(2);

    const snap = await ctx.get(StateService).snapshot();
    expect(snap.flash.invariants.every((i) => i.ok)).toBe(true);
    expect(snap.flash.metrics.duplicatesIgnored).toBe(3);
  });

  it('GET /api/state returns a snapshot of both modes', async () => {
    await ctx.admin.reset(5, { resetConfig: true });
    const res = await request(ctx.app.getHttpServer()).get('/api/state').expect(200);
    expect(res.body.naive.product.initialStock).toBe(5);
    expect(res.body.flash.redis.stock).toBe(5);
    expect(res.body.config.reserveStrategy).toBe('lua');
  });
});
