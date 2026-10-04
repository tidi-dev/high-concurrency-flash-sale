import { Inject, Injectable } from '@nestjs/common';
import type { DemoConfig, FlashMetrics, FlashState, Invariant, NaiveMetrics, NaiveState, StateSnapshot } from '@flash/shared';
import type Redis from 'ioredis';
import { DemoConfigService } from '../common/demo-config.service';
import { keys, PRODUCTS } from '../common/keys';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { REDIS } from '../common/redis';
import { ReconcileService } from '../flash/reconcile.service';
import { SimulationService } from './simulation.service';

const NAIVE_FIELDS: (keyof NaiveMetrics)[] = ['requests', 'success', 'soldOut', 'errors', 'dbQueries', 'raceWindow', 'raceWindowPeak'];
const FLASH_FIELDS: (keyof FlashMetrics)[] = [
  'requests', 'allowed', 'soldOut', 'alreadyReserved', 'errors', 'queued', 'enqueueFailed', 'compensations',
  'confirmed', 'persisted', 'duplicatesIgnored', 'rejected', 'staleDropped', 'redriven', 'paid', 'expired', 'released', 'orphansReleased',
];

function numbers<K extends string>(hash: Record<string, string>, fields: K[]): Record<K, number> {
  return Object.fromEntries(fields.map((f) => [f, Number(hash[f] ?? 0)])) as Record<K, number>;
}

/**
 * Builds the dashboard snapshot. It deliberately separates:
 *  - FACTS: PostgreSQL rows and the Redis stock value
 *  - COUNTERS: metrics hashes (observations, may drift from facts after crashes/resets)
 * and evaluates the invariants against the facts.
 */
@Injectable()
export class StateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly config: DemoConfigService,
    private readonly reconcile: ReconcileService,
    private readonly simulation: SimulationService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async snapshot(): Promise<StateSnapshot> {
    const config = await this.config.get();
    const [naive, flash, saleId] = await Promise.all([
      this.naive(),
      this.flash(config),
      this.prisma.product.findUnique({ where: { id: PRODUCTS.flash.id }, select: { saleId: true } }).then((p) => p?.saleId ?? ''),
    ]);
    return { ts: Date.now(), saleId, config, naive, flash, simulation: this.simulation.progress() };
  }

  private async naive(): Promise<NaiveState> {
    const id = PRODUCTS.naive.id;
    const [product, orders, metricsHash, lastRun] = await Promise.all([
      this.prisma.product.findUnique({ where: { id } }),
      this.prisma.order.count({ where: { productId: id } }),
      this.redis.hgetall(keys.naiveMetrics),
      this.simulation.lastRun('naive'),
    ]);
    const metrics = numbers(metricsHash, NAIVE_FIELDS);
    const invariants: Invariant[] = [];
    if (product) {
      const oversold = Math.max(0, orders - product.initialStock);
      invariants.push(
        {
          id: 'naive-no-oversell',
          label: 'Orders ≤ initial stock',
          ok: orders <= product.initialStock,
          detail: `${orders} orders for ${product.initialStock} units${oversold ? `: OVERSOLD by ${oversold}` : ''}`,
        },
        { id: 'naive-stock-nonneg', label: 'DB stock ≥ 0', ok: product.stock >= 0, detail: `stock = ${product.stock}` },
        {
          id: 'naive-conservation',
          label: 'stock + orders = initial stock',
          ok: product.stock + orders === product.initialStock,
          detail: `${product.stock} + ${orders} = ${product.stock + orders} (expected ${product.initialStock})${
            product.stock >= 0 && orders > product.initialStock ? ': lost updates are hiding the oversell' : ''
          }`,
        },
      );
    }
    return {
      product: product && { id: product.id, name: product.name, initialStock: product.initialStock, stock: product.stock },
      orders,
      oversold: product ? Math.max(0, orders - product.initialStock) : 0,
      metrics,
      lastRun,
      invariants,
    };
  }

  private async flash(config: DemoConfig): Promise<FlashState> {
    const id = PRODUCTS.flash.id;
    const [product, rawStock, pending, metricsHash, byStatus, ordersByStatus, expiredNotReleased, jobCounts, paused, drift, lastRun] =
      await Promise.all([
        this.prisma.product.findUnique({ where: { id } }),
        this.redis.get(keys.stock(id)),
        this.redis.zcard(keys.pending(id)),
        this.redis.hgetall(keys.flashMetrics),
        this.prisma.reservation.groupBy({ by: ['status'], where: { productId: id }, _count: { _all: true } }),
        this.prisma.order.groupBy({ by: ['status'], where: { productId: id }, _count: { _all: true } }),
        this.prisma.reservation.count({ where: { productId: id, status: 'EXPIRED', redisReleasedAt: null } }),
        this.queue.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized'),
        this.queue.queue.isPaused(),
        this.reconcile.drift(),
        this.simulation.lastRun('flash'),
      ]);

    const r = Object.fromEntries(byStatus.map((x) => [x.status, x._count._all])) as Record<string, number>;
    const o = Object.fromEntries(ordersByStatus.map((x) => [x.status, x._count._all])) as Record<string, number>;
    const db = {
      reserved: r.RESERVED ?? 0,
      paid: r.PAID ?? 0,
      expired: r.EXPIRED ?? 0,
      rejected: r.REJECTED ?? 0,
      ordersTotal: (o.PENDING_PAYMENT ?? 0) + (o.PAID ?? 0) + (o.CANCELLED ?? 0),
      ordersPending: o.PENDING_PAYMENT ?? 0,
      ordersPaid: o.PAID ?? 0,
      ordersCancelled: o.CANCELLED ?? 0,
      expiredNotReleasedToRedis: expiredNotReleased,
    };
    const redisStock = rawStock === null ? null : Number(rawStock);
    const minObserved = metricsHash.minObservedStock === undefined ? null : Number(metricsHash.minObservedStock);
    const queue = {
      waiting: (jobCounts.waiting ?? 0) + (jobCounts.prioritized ?? 0),
      active: jobCounts.active ?? 0,
      delayed: jobCounts.delayed ?? 0,
      completed: jobCounts.completed ?? 0,
      failed: jobCounts.failed ?? 0,
      paused,
    };

    const invariants: Invariant[] = [];
    if (product) {
      const held = db.reserved + db.paid;
      const inFlight = queue.waiting + queue.active + queue.delayed;
      invariants.push(
        {
          id: 'redis-nonneg',
          label: 'Redis stock ≥ 0',
          ok: redisStock !== null && redisStock >= 0 && (minObserved === null || minObserved >= 0),
          detail:
            redisStock === null
              ? 'stock key missing in Redis'
              : minObserved !== null && minObserved < 0
                ? `now ${redisStock}, but DECR returned values as low as ${minObserved} (decr strategy: transiently negative, admissions still correct)`
                : `now ${redisStock}, never observed below 0`,
        },
        { id: 'flash-no-oversell', label: 'RESERVED + PAID ≤ initial stock', ok: held <= product.initialStock, detail: `${db.reserved} + ${db.paid} = ${held} of ${product.initialStock}` },
        { id: 'flash-db-nonneg', label: 'PostgreSQL stock ≥ 0', ok: product.stock >= 0, detail: `stock = ${product.stock}` },
        {
          id: 'flash-conservation',
          label: 'DB stock + RESERVED + PAID = initial',
          ok: product.stock + held === product.initialStock,
          detail: `${product.stock} + ${db.reserved} + ${db.paid} = ${product.stock + held} (expected ${product.initialStock})`,
        },
        {
          id: 'flash-orders-match',
          label: 'Active orders = RESERVED + PAID (1 order per reservation)',
          ok: db.ordersPending + db.ordersPaid === held,
          detail: `${db.ordersPending} pending + ${db.ordersPaid} paid orders vs ${held} reservations`,
        },
        {
          // A crash between "Redis reserved" and "queue published" doesn't show up as drift, because the
          // reservation sits in `pending` and looks in flight. The tell: more pending reservations
          // than messages that could ever confirm them.
          id: 'flash-no-orphans',
          label: 'Every admitted reservation has a queue message',
          ok: pending <= inFlight,
          detail:
            (pending <= inFlight
              ? `${pending} pending, ${inFlight} messages in the queue`
              : `${pending - inFlight} reservation(s) admitted by Redis but not in the queue: leaked units (run reconcile)${
                  this.simulation.running ? '; may be transient during a run' : ''
                }`) + (config.duplicateDelivery ? ' · note: duplicate delivery doubles the message count, which can hide orphans' : ''),
        },
        {
          id: 'flash-drift',
          label: 'Redis agrees with PostgreSQL (drift = 0)',
          ok: drift === 0,
          detail:
            drift === null
              ? 'stock key missing in Redis'
              : drift === 0
                ? 'redis stock = db stock − pending − expired-not-yet-released'
                : `drift ${drift > 0 ? '+' : ''}${drift}${inFlight > 0 ? ' (work in flight; may be transient)' : ''}: ${
                    drift < 0
                      ? 'Redis is holding units nobody owns (leak): run reconcile; if it persists while idle, use "overwrite Redis stock from DB"'
                      : 'Redis will admit more than PostgreSQL can persist (extra buyers will be REJECTED): rebuild Redis stock from the DB while idle'
                  }`,
        },
      );
    }

    return {
      product: product && { id: product.id, name: product.name, initialStock: product.initialStock, dbStock: product.stock },
      redis: { stock: redisStock, pending, minObservedStock: minObserved },
      db,
      queue,
      metrics: numbers(metricsHash, FLASH_FIELDS),
      drift,
      lastRun,
      invariants,
    };
  }
}
