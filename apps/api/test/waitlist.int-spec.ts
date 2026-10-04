// Waitlist: a sold-out shopper joins; when a unit comes back it is HELD for the first person in line
// (atomically), never put back in the public stock where someone else could grab it.
import request from 'supertest';
import { keys } from '../src/common/keys';
import { LifecycleService } from '../src/flash/lifecycle.service';
import { ReconcileService } from '../src/flash/reconcile.service';
import { ReservationScripts } from '../src/flash/redis-scripts';
import { ReservationService } from '../src/flash/reservation.service';
import { bootstrap, conservation, drainManually, FLASH, redisStock, TestCtx } from './helpers';

describe('waitlist', () => {
  let ctx: TestCtx;
  let server: ReturnType<TestCtx['app']['getHttpServer']>;
  let lifecycle: LifecycleService;
  beforeAll(async () => {
    ctx = await bootstrap();
    server = ctx.app.getHttpServer();
    lifecycle = ctx.get(LifecycleService);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.admin.reset(1, { resetConfig: true });
  });

  const buy = (userId: string) => request(server).post('/api/flash-sale/buy').send({ userId });
  const join = (userId: string) => request(server).post('/api/flash-sale/waitlist').send({ userId }).expect(200);
  const status = async (userId: string) => (await request(server).get(`/api/flash-sale/waitlist/${userId}`).expect(200)).body;

  it('sold out -> join -> the winner does not pay -> the unit is held for the first person in line', async () => {
    const alice = (await buy('alice').expect(202)).body.reservationId as string;
    const bob = await buy('bob').expect(409);
    expect(bob.body.message).toMatch(/waitlist/i);

    expect((await join('bob')).body).toMatchObject({ status: 'WAITING', position: 1 });
    expect((await join('carol')).body).toMatchObject({ status: 'WAITING', position: 2 });
    await drainManually(ctx);

    // Alice's reservation expires unpaid.
    const exp = await lifecycle.expire(alice, { force: true });
    expect(exp.redis).toBe('HANDED_OFF:bob');

    // Bob is "notified": his status now says a sneaker is held for him.
    const offer = await status('bob');
    expect(offer).toMatchObject({ status: 'OFFERED' });
    expect(offer.reservationId).toBeDefined();

    // The unit never went back to the public: a newcomer can't snipe it.
    expect(await redisStock(ctx)).toBe(0);
    await buy('dave').expect(409);

    // Bob's reservation goes through the normal pipeline, then he pays.
    expect(await drainManually(ctx)).toEqual(['CREATED']);
    await request(server).post(`/api/flash-sale/reservations/${offer.reservationId}/pay`).expect(200);
    expect((await status('bob')).status).toBe('PAID');
    expect((await status('carol')).status).toBe('WAITING');
    expect((await status('carol')).position).toBe(1);

    expect((await conservation(ctx)).ok).toBe(true);
    expect(await ctx.get(ReconcileService).drift()).toBe(0);
  });

  it('an offer that is not paid in time moves on to the next person in line', async () => {
    const alice = (await buy('alice').expect(202)).body.reservationId as string;
    await join('bob');
    await join('carol');
    await drainManually(ctx);

    await lifecycle.expire(alice, { force: true }); // -> bob
    await drainManually(ctx);
    const bobOffer = await status('bob');
    await lifecycle.expire(bobOffer.reservationId, { force: true }); // bob doesn't pay -> carol

    expect((await status('bob')).status).toBe('OFFER_ENDED');
    expect((await status('carol')).status).toBe('OFFERED');
    expect(await drainManually(ctx)).toEqual(['CREATED']);
    expect((await conservation(ctx)).ok).toBe(true);
  });

  it('you cannot join while stock is available, or while holding a reservation', async () => {
    expect((await join('x')).body.status).toBe('STOCK_AVAILABLE');
    await buy('alice').expect(202);
    expect((await join('alice')).body.status).toBe('ALREADY_RESERVED');
  });

  it('if the process dies right after the hand-off, the reconciler passes the unit on to the next in line', async () => {
    const alice = (await buy('alice').expect(202)).body.reservationId as string;
    await join('bob');
    await join('carol');
    await drainManually(ctx);
    // Do only the DB half of expiry, then the Redis release WITHOUT publishing bob's message:
    // exactly what a crash between "hand-off" and "publish" leaves behind.
    await lifecycle.expireInDbOnly(alice, { force: true });
    const handoff = { reservationId: 'held-for-bob', nowMs: Date.now() - 60_000, expiresAtMs: Date.now() + 30_000 };
    expect(await ctx.get(ReservationScripts).release(FLASH, alice, 'alice', 'EXPIRED', handoff)).toBe('HANDED_OFF:bob');
    await ctx.prisma.reservation.update({ where: { id: alice }, data: { redisReleasedAt: new Date() } });
    expect(await drainManually(ctx)).toEqual([]); // no message for bob

    const report = await ctx.get(ReconcileService).reconcile({ graceMs: 0 });

    expect(report.orphansReleased).toBe(1);
    expect((await status('carol')).status).toBe('OFFERED'); // the unit moved on, it wasn't lost
    expect(await ctx.redis.exists(keys.user(FLASH, 'bob'))).toBe(0);
    expect(await drainManually(ctx)).toEqual(['CREATED']);
    expect((await conservation(ctx)).ok).toBe(true);
    expect(await ctx.get(ReconcileService).drift()).toBe(0);
  });

  it('with nobody waiting, an expired unit goes back on sale', async () => {
    const r = await ctx.get(ReservationService).reserve('alice');
    await drainManually(ctx);
    expect((await lifecycle.expire(r.reservationId!, { force: true })).redis).toBe('RELEASED');
    expect(await redisStock(ctx)).toBe(1);
  });
});
