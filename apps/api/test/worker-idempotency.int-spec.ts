import { PersistenceService } from '../src/flash/persistence.service';
import { ReservationService } from '../src/flash/reservation.service';
import { keys } from '../src/common/keys';
import { bootstrap, conservation, countByStatus, dbStock, drainManually, FLASH, TestCtx } from './helpers';

describe('Mode B worker: persistence and idempotency', () => {
  let ctx: TestCtx;
  let reservations: ReservationService;
  beforeAll(async () => {
    ctx = await bootstrap();
    reservations = ctx.get(ReservationService);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.admin.reset(5, { resetConfig: true });
  });

  it('persists a reservation: row RESERVED, order PENDING_PAYMENT, DB stock decremented', async () => {
    const r = await reservations.reserve('alice');
    expect(await drainManually(ctx)).toEqual(['CREATED']);

    const row = await ctx.prisma.reservation.findUniqueOrThrow({ where: { id: r.reservationId! }, include: { order: true } });
    expect(row.status).toBe('RESERVED');
    expect(row.order?.status).toBe('PENDING_PAYMENT');
    expect(await dbStock(ctx)).toBe(4);
    expect((await conservation(ctx)).ok).toBe(true);
  });

  it('the same message delivered twice creates ONE reservation, ONE order, ONE decrement', async () => {
    await ctx.config.update({ duplicateDelivery: true }); // API enqueues every job twice
    await reservations.reserve('alice');
    await reservations.reserve('bob');

    const outcomes = await drainManually(ctx);

    expect(outcomes.sort()).toEqual(['CREATED', 'CREATED', 'DUPLICATE', 'DUPLICATE']);
    expect(await ctx.prisma.reservation.count()).toBe(2);
    expect(await ctx.prisma.order.count()).toBe(2);
    expect(await dbStock(ctx)).toBe(3);
    expect((await conservation(ctx)).ok).toBe(true);
  });

  it('duplicates processed concurrently are still applied once (the DB primary key decides)', async () => {
    const r = await reservations.reserve('alice');
    const job = (await ctx.queue.queue.getJob(r.reservationId!))!.data;
    const persistence = ctx.get(PersistenceService);

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => persistence.persist(job)));

    expect(outcomes.filter((o) => o === 'CREATED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(9);
    expect(await dbStock(ctx)).toBe(4);
  });

  it('BROKEN idempotency (side effect outside the guard): duplicates double-decrement stock', async () => {
    await ctx.config.update({ duplicateDelivery: true, workerIdempotency: 'broken' });
    await reservations.reserve('alice');

    await drainManually(ctx);

    // The unique key still prevents a second reservation row...
    expect(await ctx.prisma.reservation.count()).toBe(1);
    // ...but the stock decrement ran twice: one unit vanished. This is the bug the demo shows.
    expect(await dbStock(ctx)).toBe(3);
    expect((await conservation(ctx)).ok).toBe(false);
  });

  it('rejects when PostgreSQL has no stock left even though Redis admitted (drift)', async () => {
    await ctx.prisma.product.update({ where: { id: 'flash-sneaker' }, data: { stock: 0 } });
    await reservations.reserve('alice');

    expect(await drainManually(ctx)).toEqual(['REJECTED']);
    expect((await countByStatus(ctx)).REJECTED).toBe(1);
    expect(await ctx.prisma.order.count()).toBe(0);
    expect(await dbStock(ctx)).toBe(0); // never negative
    // The user got nothing, so they must be free to try again (and nothing is left "pending").
    expect(await ctx.redis.exists(keys.user(FLASH, 'alice'))).toBe(0);
    expect(await ctx.redis.zcard(keys.pending(FLASH))).toBe(0);
  });
});
