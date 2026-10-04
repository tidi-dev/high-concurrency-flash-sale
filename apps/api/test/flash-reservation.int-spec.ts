import request from 'supertest';
import { keys } from '../src/common/keys';
import { bootstrap, FLASH, redisStock, TestCtx } from './helpers';

describe('Mode B: POST /api/flash-sale/buy', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await bootstrap();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.admin.reset(3, { resetConfig: true });
  });

  it('reserves a unit: 202, Redis decremented, reservation recorded, job queued', async () => {
    const res = await request(ctx.app.getHttpServer()).post('/api/flash-sale/buy').send({ userId: 'alice' }).expect(202);

    expect(res.body.status).toBe('RESERVED');
    expect(res.body.message).toMatch(/Reserved for 30 seconds/);
    const rid = res.body.reservationId as string;
    expect(await redisStock(ctx)).toBe(2);
    expect(await ctx.redis.hget(keys.reservation(FLASH, rid), 'status')).toBe('RESERVED');
    const job = await ctx.queue.queue.getJob(rid);
    expect(job?.data).toMatchObject({ reservationId: rid, userId: 'alice', productId: FLASH });
    // Nothing in PostgreSQL yet: persistence is asynchronous.
    expect(await ctx.prisma.reservation.count()).toBe(0);
  });

  it('answers 409 SOLD_OUT once stock is exhausted, without queueing anything', async () => {
    const server = ctx.app.getHttpServer();
    for (const u of ['a', 'b', 'c']) await request(server).post('/api/flash-sale/buy').send({ userId: u }).expect(202);
    const res = await request(server).post('/api/flash-sale/buy').send({ userId: 'd' }).expect(409);

    expect(res.body.status).toBe('SOLD_OUT');
    expect(await redisStock(ctx)).toBe(0);
    expect(await ctx.queue.queue.getWaitingCount()).toBe(3);
  });

  it('answers 409 ALREADY_RESERVED for a second attempt by the same user', async () => {
    const server = ctx.app.getHttpServer();
    const first = await request(server).post('/api/flash-sale/buy').send({ userId: 'alice' }).expect(202);
    const res = await request(server).post('/api/flash-sale/buy').send({ userId: 'alice' }).expect(409);
    expect(res.body.status).toBe('ALREADY_RESERVED');
    // A client whose first response got lost can recover the reservation it holds.
    expect(res.body.reservationId).toBe(first.body.reservationId);
    expect(await redisStock(ctx)).toBe(2);
  });

  it('decr strategy: same admissions, no per-user limit', async () => {
    await ctx.config.update({ reserveStrategy: 'decr' });
    const server = ctx.app.getHttpServer();
    await request(server).post('/api/flash-sale/buy').send({ userId: 'alice' }).expect(202);
    await request(server).post('/api/flash-sale/buy').send({ userId: 'alice' }).expect(202);
    expect(await redisStock(ctx)).toBe(1);
  });

  it('simulated crash after reservation: 500 to the client, unit held in Redis, nothing queued', async () => {
    await ctx.config.update({ crashAfterReservePercent: 100 });
    const res = await request(ctx.app.getHttpServer()).post('/api/flash-sale/buy').send({ userId: 'alice' }).expect(500);
    expect(res.body.status).toBe('SIMULATED_CRASH');
    expect(await redisStock(ctx)).toBe(2);
    expect(await ctx.redis.zcard(keys.pending(FLASH))).toBe(1);
    expect(await ctx.queue.queue.getWaitingCount()).toBe(0);
  });
});
