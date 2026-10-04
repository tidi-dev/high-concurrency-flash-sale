// Mode A demonstrations. The first two tests PASS WHEN THE BUG HAPPENS: they prove that the
// intentionally unsafe implementation oversells under concurrency.
import { NaiveService } from '../src/naive/naive.service';
import { StateService } from '../src/admin/state.service';
import { bootstrap, dbStock, NAIVE, TestCtx } from './helpers';

const STOCK = 50;
const BUYERS = 300;

describe('Mode A: naive PostgreSQL checkout', () => {
  let ctx: TestCtx;
  let naive: NaiveService;
  beforeAll(async () => {
    ctx = await bootstrap();
    naive = ctx.get(NaiveService);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const orders = () => ctx.prisma.order.count({ where: { productId: NAIVE } });
  const buyAll = () => Promise.all(Array.from({ length: BUYERS }, (_, i) => naive.buy(`buyer-${i}`)));

  it('check-then-act OVERSELLS: more orders than units, stock goes negative', async () => {
    await ctx.admin.reset(STOCK, { resetConfig: true });
    await ctx.config.update({ naiveVariant: 'check-then-act', naiveDelayMs: 20 });

    await buyAll();

    const n = await orders();
    const stock = await dbStock(ctx, NAIVE);
    expect(n).toBeGreaterThan(STOCK); // <- the oversell
    expect(stock).toBeLessThan(0);
    expect(stock + n).toBe(STOCK); // relative decrements are not lost, they just go below zero

    const snap = await ctx.get(StateService).snapshot();
    expect(snap.naive.oversold).toBe(n - STOCK);
    expect(snap.naive.invariants.find((i) => i.id === 'naive-no-oversell')?.ok).toBe(false);
    expect(snap.naive.metrics.raceWindowPeak).toBeGreaterThan(1);
  });

  it('lost-update OVERSELLS and HIDES it: stock looks fine, orders exceed units', async () => {
    await ctx.admin.reset(STOCK, { resetConfig: true });
    await ctx.config.update({ naiveVariant: 'lost-update', naiveDelayMs: 20 });

    await buyAll();

    const n = await orders();
    const stock = await dbStock(ctx, NAIVE);
    expect(n).toBeGreaterThan(STOCK);
    expect(stock).toBeGreaterThanOrEqual(0); // looks healthy...
    expect(stock + n).not.toBe(STOCK); // ...but the books don't balance
  });

  it('atomic conditional UPDATE never oversells, even with the same concurrency', async () => {
    await ctx.admin.reset(STOCK, { resetConfig: true });
    await ctx.config.update({ naiveVariant: 'atomic' });

    const results = await buyAll();

    expect(results.filter((r) => r.status === 'ORDER_CREATED')).toHaveLength(STOCK);
    expect(await orders()).toBe(STOCK);
    expect(await dbStock(ctx, NAIVE)).toBe(0);
  });
});
