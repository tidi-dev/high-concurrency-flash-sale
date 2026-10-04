// Story mode drives the REAL code paths in slow motion. These tests check that what the
// non-technical viewer is told is true: Shop A really oversells, Shop B really doesn't.
import { StoryService } from '../src/admin/story.service';
import { WorkerRunner } from '../src/flash/worker.runner';
import { keys } from '../src/common/keys';
import { ReconcileService } from '../src/flash/reconcile.service';
import { bootstrap, conservation, countByStatus, dbStock, FLASH, NAIVE, redisStock, TestCtx } from './helpers';

async function waitUntilDone(story: StoryService): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (story.isRunning && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

describe('story mode', () => {
  let ctx: TestCtx;
  let story: StoryService;
  beforeAll(async () => {
    ctx = await bootstrap();
    story = ctx.get(StoryService);
    ctx.get(WorkerRunner).start({ sweepIntervalMs: 0 });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('Shop A (naive, slowed down): 8 shoppers, 4 sneakers -> every shopper gets an order: oversold', async () => {
    await ctx.config.resetToDefaults();
    const run = await story.start('naive', 8, 4, 'slow');
    expect(run.shoppers).toHaveLength(8);
    await waitUntilDone(story);

    expect(await ctx.prisma.order.count({ where: { productId: NAIVE } })).toBe(8);
    expect(await dbStock(ctx, NAIVE)).toBe(-4);
    // pacing knobs are restored afterwards
    expect((await ctx.config.get()).naiveDelayMs).toBe(20);
  });

  it('Shop B (Redis + queue + waitlist): 8 shoppers, 4 sneakers -> 4 paid, one of them via the waitlist', async () => {
    await ctx.config.resetToDefaults();
    const run = await story.start('flash', 8, 4, 'slow');
    await waitUntilDone(story);

    const byStatus = await countByStatus(ctx);
    expect(byStatus.PAID).toBe(4); // every sneaker sold, none oversold
    expect(byStatus.EXPIRED).toBe(1); // the shopper who walked away without paying
    // ...and their sneaker went to the first sold-out shopper on the waitlist, who paid for it:
    const soldOutShoppers = run.shoppers.slice(4);
    const paidViaWaitlist = await ctx.prisma.reservation.count({ where: { status: 'PAID', userId: { in: soldOutShoppers } } });
    expect(paidViaWaitlist).toBe(1);
    expect(await ctx.redis.zcard(keys.waitlist(FLASH))).toBe(3); // the others are still waiting

    expect((await conservation(ctx)).ok).toBe(true);
    expect(await redisStock(ctx)).toBe(0);
    expect(await ctx.get(ReconcileService).drift()).toBe(0);
    const cfg = await ctx.config.get();
    expect(cfg.workerConcurrency).toBe(16);
    expect(cfg.workerDelayMs).toBe(0);
  });
});
