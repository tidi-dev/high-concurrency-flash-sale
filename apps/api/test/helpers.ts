import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { AdminService } from '../src/admin/admin.service';
import { DemoConfigService } from '../src/common/demo-config.service';
import { keys, PRODUCTS } from '../src/common/keys';
import { PrismaService } from '../src/common/prisma.service';
import { QueueService, ReservationJob } from '../src/common/queue.service';
import { REDIS } from '../src/common/redis';
import { PersistenceService, PersistOutcome } from '../src/flash/persistence.service';
import { WorkerRunner } from '../src/flash/worker.runner';
import { WorkerRunnerModule } from '../src/worker.module';

export const FLASH = PRODUCTS.flash.id;
export const NAIVE = PRODUCTS.naive.id;

export interface TestCtx {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  queue: QueueService;
  config: DemoConfigService;
  admin: AdminService;
  get<T>(cls: abstract new (...args: never[]) => T): T;
  close(): Promise<void>;
}

/** Boots the API module (and the worker module, but without starting the worker loop). */
export async function bootstrap(): Promise<TestCtx> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, WorkerRunnerModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  const get = <T>(cls: abstract new (...args: never[]) => T): T => app.get(cls as never);
  return {
    app,
    prisma: get(PrismaService),
    redis: app.get(REDIS),
    queue: get(QueueService),
    config: get(DemoConfigService),
    admin: get(AdminService),
    get,
    close: async () => {
      await get(WorkerRunner).stop();
      await app.close();
    },
  };
}

/** Deterministic stand-in for the worker: pull every waiting job and run the persistence step once. */
export async function drainManually(ctx: TestCtx): Promise<PersistOutcome[]> {
  const persistence = ctx.get(PersistenceService);
  const outcomes: PersistOutcome[] = [];
  for (;;) {
    const jobs = await ctx.queue.queue.getJobs(['waiting', 'prioritized'], 0, 999);
    if (jobs.length === 0) return outcomes;
    for (const job of jobs) {
      outcomes.push(await persistence.persist(job.data as ReservationJob));
      await job.remove();
    }
  }
}

export async function redisStock(ctx: TestCtx): Promise<number | null> {
  const v = await ctx.redis.get(keys.stock(FLASH));
  return v === null ? null : Number(v);
}

export async function dbStock(ctx: TestCtx, productId: string = FLASH): Promise<number> {
  return (await ctx.prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock;
}

export async function countByStatus(ctx: TestCtx): Promise<Record<string, number>> {
  const rows = await ctx.prisma.reservation.groupBy({ by: ['status'], _count: { _all: true } });
  const out: Record<string, number> = { RESERVED: 0, PAID: 0, EXPIRED: 0, REJECTED: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}

/** Mode B conservation: every unit is either available, held, or sold. */
export async function conservation(ctx: TestCtx): Promise<{ ok: boolean; stock: number; reserved: number; paid: number; initial: number }> {
  const p = await ctx.prisma.product.findUniqueOrThrow({ where: { id: FLASH } });
  const c = await countByStatus(ctx);
  return { ok: p.stock + c.RESERVED + c.PAID === p.initialStock, stock: p.stock, reserved: c.RESERVED, paid: c.PAID, initial: p.initialStock };
}
