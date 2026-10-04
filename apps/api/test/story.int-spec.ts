// Story mode drives the REAL code paths in slow motion. These tests check that what the
// non-technical viewer is told is true: Shop A really oversells, Shop B really doesn't.
import { StoryService } from '../src/admin/story.service';
import { WorkerRunner } from '../src/flash/worker.runner';
import { bootstrap, conservation, dbStock, NAIVE, TestCtx } from './helpers';

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

  it('Shop B (Redis + queue, one slow clerk): 8 shoppers, 4 sneakers -> exactly 4 orders', async () => {
    await ctx.config.resetToDefaults();
    await story.start('flash', 8, 4, 'slow');
    await waitUntilDone(story);

    expect(await ctx.prisma.order.count({ where: { productId: 'flash-sneaker' } })).toBe(4);
    expect((await conservation(ctx)).ok).toBe(true);
    const cfg = await ctx.config.get();
    expect(cfg.workerConcurrency).toBe(16);
    expect(cfg.workerDelayMs).toBe(0);
  });
});
