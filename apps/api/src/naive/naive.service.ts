// ============================================================================
//  MODE A: NAIVE POSTGRESQL CHECKOUT
//  The `check-then-act` and `lost-update` variants are INTENTIONALLY UNSAFE.
//  They exist to demonstrate overselling. Never copy them into real code.
// ============================================================================
import { Injectable } from '@nestjs/common';
import type { NaiveBuyResponse } from '@flash/shared';
import { randomUUID } from 'node:crypto';
import { DemoConfigService } from '../common/demo-config.service';
import { keys, PRODUCTS } from '../common/keys';
import { PrismaService } from '../common/prisma.service';
import { TelemetryService } from '../common/telemetry.service';
import { sleep } from '../common/util';

const PRODUCT = PRODUCTS.naive.id;
const M = keys.naiveMetrics;

@Injectable()
export class NaiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: DemoConfigService,
    private readonly telemetry: TelemetryService,
  ) {}

  async buy(userId: string = `anon-${randomUUID()}`): Promise<NaiveBuyResponse> {
    const cfg = await this.config.get();
    try {
      const res = cfg.naiveVariant === 'atomic' ? await this.buyAtomic(userId) : await this.buyUnsafe(userId, cfg.naiveVariant, cfg.naiveDelayMs);
      if (res.status === 'ORDER_CREATED') {
        await this.telemetry.record({ type: 'NAIVE_ORDER_CREATED', mode: 'naive', userId, detail: `read stock=${res.stockRead ?? '?'}${res.stockAfter !== undefined ? `; stock now ${res.stockAfter}` : ''}` }, { hash: M, incr: { requests: 1, success: 1 } });
      } else {
        await this.telemetry.record({ type: 'NAIVE_SOLD_OUT', mode: 'naive', userId }, { hash: M, incr: { requests: 1, soldOut: 1 } });
      }
      return res;
    } catch (err) {
      await this.telemetry.record(null, { hash: M, incr: { requests: 1, errors: 1 } });
      throw err;
    }
  }

  /**
   * INTENTIONALLY UNSAFE.
   *
   *   1. SELECT stock                        <- everyone reads "1"
   *   2. if stock > 0                        <- everyone passes the check
   *   3. ...artificial delay...              <- the race window, made wide on purpose
   *   4. UPDATE stock                        <- everyone writes
   *   5. INSERT order                        <- everyone gets an order
   *
   * `check-then-act`: step 4 is `stock = stock - 1`. The stock goes negative.
   * `lost-update`:    step 4 is `stock = <value read in step 1> - 1`. Writers overwrite each
   *                   other, so the stock looks plausible while orders exceed the initial stock.
   *                   The oversell is hidden.
   */
  private async buyUnsafe(userId: string, variant: 'check-then-act' | 'lost-update', delayMs: number): Promise<NaiveBuyResponse> {
    const product = await this.prisma.product.findUniqueOrThrow({ where: { id: PRODUCT } }); // 1. SELECT
    await this.telemetry.record({ type: 'NAIVE_STOCK_READ', mode: 'naive', userId, detail: `saw ${product.stock} left` }, { hash: M, incr: { dbQueries: 1 } });
    if (product.stock <= 0) {
      return { status: 'SOLD_OUT', stockRead: product.stock, message: 'Sold out.' }; // 2. check
    }

    await this.telemetry.gauge(M, 'raceWindow', +1);
    try {
      if (delayMs > 0) await sleep(delayMs); // 3. the window between check and act

      const updated = await this.prisma.product.update({
        where: { id: PRODUCT },
        data: variant === 'check-then-act' ? { stock: { decrement: 1 } } : { stock: product.stock - 1 }, // 4. UPDATE
      });
      const order = await this.prisma.order.create({ data: { productId: PRODUCT, userId, source: 'NAIVE', status: 'PAID' } }); // 5. INSERT
      await this.countQueries(2);
      return { status: 'ORDER_CREATED', orderId: order.id, stockRead: product.stock, stockAfter: updated.stock, message: 'Order created.' };
    } finally {
      await this.telemetry.gauge(M, 'raceWindow', -1);
    }
  }

  /**
   * SAFE, but still "everything in the database".
   *
   *   BEGIN;
   *   UPDATE product SET stock = stock - 1 WHERE id = $1 AND stock > 0;   -- check AND act, one statement
   *   -- 0 rows updated => sold out
   *   INSERT INTO "Order" ...;
   *   COMMIT;
   *
   * PostgreSQL takes a row lock for the UPDATE and re-evaluates `stock > 0` after any
   * concurrent writer commits, so it can't oversell. The price is that every buyer queues
   * for the same row lock and a DB connection. That's correct, but it's a bottleneck at flash-sale scale.
   */
  private async buyAtomic(userId: string): Promise<NaiveBuyResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.updateMany({ where: { id: PRODUCT, stock: { gt: 0 } }, data: { stock: { decrement: 1 } } });
      if (updated.count === 0) return null;
      return tx.order.create({ data: { productId: PRODUCT, userId, source: 'NAIVE', status: 'PAID' } });
    });
    await this.countQueries(result ? 2 : 1);
    return result
      ? { status: 'ORDER_CREATED', orderId: result.id, message: 'Order created.' }
      : { status: 'SOLD_OUT', message: 'Sold out.' };
  }

  private countQueries(n: number): Promise<void> {
    return this.telemetry.record(null, { hash: M, incr: { dbQueries: n } });
  }
}
