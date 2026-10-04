// THE critical invariant of the whole demo:
//   initial stock = 500, N = 2,000 concurrent reservation attempts (N > 500)
//   => successful reservations <= 500, Redis stock >= 0,
//      and after the worker processed everything: paid + active reservations <= 500.
import { ReserveStrategy } from '@flash/shared';
import { ReconcileService } from '../src/flash/reconcile.service';
import { LifecycleService } from '../src/flash/lifecycle.service';
import { ReservationService } from '../src/flash/reservation.service';
import { WorkerRunner } from '../src/flash/worker.runner';
import { runLoad } from '../src/loadgen/run-load';
import { bootstrap, conservation, countByStatus, redisStock, TestCtx } from './helpers';

const INITIAL = 500;
const ATTEMPTS = 2000;

describe.each<ReserveStrategy>(['lua', 'decr'])('critical invariant with the %s strategy', (strategy) => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await bootstrap();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it(`${ATTEMPTS} concurrent attempts on ${INITIAL} units never oversell, end to end`, async () => {
    await ctx.admin.reset(INITIAL, { resetConfig: true });
    await ctx.config.update({ reserveStrategy: strategy, reservationTtlSec: 300 });
    const reservations = ctx.get(ReservationService);

    const results = await Promise.all(Array.from({ length: ATTEMPTS }, (_, i) => reservations.reserve(`user-${i}`)));

    const allowed = results.filter((r) => r.status === 'RESERVED');
    expect(allowed.length).toBeLessThanOrEqual(INITIAL);
    expect(allowed.length).toBe(INITIAL); // and nothing was wrongly refused either
    expect(new Set(allowed.map((r) => r.reservationId)).size).toBe(INITIAL);
    expect(await redisStock(ctx)).toBeGreaterThanOrEqual(0);
    expect(await redisStock(ctx)).toBe(0);

    // Let the real BullMQ worker persist everything, then pay for some of the reservations.
    const runner = ctx.get(WorkerRunner);
    runner.start({ sweepIntervalMs: 0 });
    await runner.waitForDrain();
    const { paid } = await ctx.get(LifecycleService).payRandom(40);
    expect(paid).toBeGreaterThan(0);

    const c = await countByStatus(ctx);
    expect(c.PAID + c.RESERVED).toBeLessThanOrEqual(INITIAL);
    expect(c.PAID + c.RESERVED).toBe(INITIAL);
    expect(c.REJECTED).toBe(0);
    expect((await conservation(ctx)).ok).toBe(true);
    expect(await ctx.prisma.product.findUniqueOrThrow({ where: { id: 'flash-sneaker' } })).toMatchObject({ stock: 0 });
    expect(await ctx.prisma.order.count({ where: { status: { in: ['PENDING_PAYMENT', 'PAID'] } } })).toBe(INITIAL);
    expect(await ctx.get(ReconcileService).drift()).toBe(0);
  });
});

describe('critical invariant over real HTTP (load generator)', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await bootstrap();
    await ctx.app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('1,000 HTTP requests against 100 units: exactly 100 RESERVED, 900 SOLD_OUT, no errors', async () => {
    await ctx.admin.reset(100, { resetConfig: true });
    const baseUrl = (await ctx.app.getUrl()).replace('[::1]', '127.0.0.1');

    const result = await runLoad({ baseUrl, mode: 'flash', users: 1000, concurrency: 200 });

    expect(result.outcomes).toEqual({ RESERVED: 100, SOLD_OUT: 900 });
    expect(result.errors).toBe(0);
    expect(result.latency.count).toBe(1000);
    expect(await redisStock(ctx)).toBe(0);
  });
});
