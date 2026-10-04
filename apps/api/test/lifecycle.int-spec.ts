import request from 'supertest';
import { keys } from '../src/common/keys';
import { LifecycleService } from '../src/flash/lifecycle.service';
import { ReservationService } from '../src/flash/reservation.service';
import { bootstrap, conservation, dbStock, drainManually, FLASH, redisStock, TestCtx } from './helpers';

describe('Mode B reservation lifecycle', () => {
  let ctx: TestCtx;
  let reservations: ReservationService;
  let lifecycle: LifecycleService;
  beforeAll(async () => {
    ctx = await bootstrap();
    reservations = ctx.get(ReservationService);
    lifecycle = ctx.get(LifecycleService);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.admin.reset(2, { resetConfig: true });
  });

  async function reservePersisted(userId: string): Promise<string> {
    const r = await reservations.reserve(userId);
    await drainManually(ctx);
    return r.reservationId!;
  }

  it('pay: RESERVED -> PAID, order PAID, stock stays sold', async () => {
    const id = await reservePersisted('alice');
    const res = await request(ctx.app.getHttpServer()).post(`/api/flash-sale/reservations/${id}/pay`).expect(200);

    expect(res.body.code).toBe('PAID');
    const row = await ctx.prisma.reservation.findUniqueOrThrow({ where: { id }, include: { order: true } });
    expect(row.status).toBe('PAID');
    expect(row.order?.status).toBe('PAID');
    expect(await ctx.redis.hget(keys.reservation(FLASH, id), 'status')).toBe('PAID');
    expect(await dbStock(ctx)).toBe(1);
    expect(await redisStock(ctx)).toBe(1);
  });

  it('pay before the worker persisted the reservation: 409 NOT_PERSISTED (retry later)', async () => {
    const r = await reservations.reserve('alice');
    const res = await request(ctx.app.getHttpServer()).post(`/api/flash-sale/reservations/${r.reservationId}/pay`).expect(409);
    expect(res.body.code).toBe('NOT_PERSISTED');
  });

  it('pay an unknown reservation: 404', async () => {
    await request(ctx.app.getHttpServer()).post('/api/flash-sale/reservations/nope/pay').expect(404);
  });

  it('expiry restores stock in PostgreSQL AND Redis, cancels the order, frees the user', async () => {
    await ctx.config.update({ reservationTtlSec: 1 });
    const id = await reservePersisted('alice');
    expect(await dbStock(ctx)).toBe(1);
    expect(await redisStock(ctx)).toBe(1);

    expect(await lifecycle.sweep()).toEqual({ expired: 0, released: 0 }); // not due yet
    await new Promise((r) => setTimeout(r, 1100));
    expect(await lifecycle.sweep()).toEqual({ expired: 1, released: 1 });

    const row = await ctx.prisma.reservation.findUniqueOrThrow({ where: { id }, include: { order: true } });
    expect(row.status).toBe('EXPIRED');
    expect(row.redisReleasedAt).not.toBeNull();
    expect(row.order?.status).toBe('CANCELLED');
    expect(await dbStock(ctx)).toBe(2);
    expect(await redisStock(ctx)).toBe(2);
    expect(await ctx.redis.exists(keys.user(FLASH, 'alice'))).toBe(0);
    expect((await conservation(ctx)).ok).toBe(true);
  });

  it('expiring the same reservation concurrently returns the unit exactly once', async () => {
    const id = await reservePersisted('alice');

    const results = await Promise.all(Array.from({ length: 8 }, () => lifecycle.expire(id, { force: true })));

    expect(results.filter((r) => r.expired)).toHaveLength(1);
    expect(await dbStock(ctx)).toBe(2);
    expect(await redisStock(ctx)).toBe(2);
    expect(await lifecycle.sweep()).toEqual({ expired: 0, released: 0 }); // the sweeper finds nothing left to do
    expect(await redisStock(ctx)).toBe(2);
  });

  it('crash between the DB expiry and the Redis release is repaired by the next sweep', async () => {
    const id = await reservePersisted('alice');
    // Do only the DB half of expiry, as if the process died right after the commit.
    await lifecycle.expireInDbOnly(id, { force: true });
    expect(await dbStock(ctx)).toBe(2);
    expect(await redisStock(ctx)).toBe(1); // Redis hasn't been told yet

    expect(await lifecycle.sweep()).toEqual({ expired: 0, released: 1 });
    expect(await redisStock(ctx)).toBe(2);
  });

  it('pay racing expire: exactly one wins every time, and conservation holds', async () => {
    for (let i = 0; i < 15; i++) {
      await ctx.admin.reset(1, { resetConfig: true });
      const id = await reservePersisted(`user-${i}`);
      const [pay, exp] = await Promise.all([lifecycle.pay(id), lifecycle.expire(id, { force: true })]);

      expect(Number(pay.code === 'PAID') + Number(exp.expired)).toBe(1);
      expect((await conservation(ctx)).ok).toBe(true);
      expect(await redisStock(ctx)).toBe(pay.code === 'PAID' ? 0 : 1);
    }
  });

  it('pay after expiry is refused', async () => {
    const id = await reservePersisted('alice');
    await lifecycle.expire(id, { force: true });
    const res = await lifecycle.pay(id);
    expect(res.code).toBe('EXPIRED');
    expect(await dbStock(ctx)).toBe(2);
  });

  it('GET reservation shows both the Redis and the PostgreSQL view', async () => {
    const id = await reservePersisted('alice');
    const res = await request(ctx.app.getHttpServer()).get(`/api/flash-sale/reservations/${id}`).expect(200);
    expect(res.body).toMatchObject({ id, status: 'RESERVED', persisted: true, userId: 'alice', order: { status: 'PENDING_PAYMENT' } });
    expect(res.body.redis.status).toBe('RESERVED');
  });
});
