import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { env } from './env';
import { createBullConnection } from './redis';

/** What the API puts on the queue for every admitted request. */
export interface ReservationJob {
  reservationId: string;
  productId: string;
  userId: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** Fencing token: the sale this reservation was admitted under (see Product.saleId). */
  saleId: string;
}

export const PERSIST_JOB = 'persist-reservation';

// BullMQ is a queue *stored in Redis*. Conceptually it plays the role Kafka plays in the
// interview answer: it absorbs the burst so the worker can write to PostgreSQL at its own pace.
// Big difference: it lives in the same Redis as the stock counter, so losing Redis loses both.
@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly connection: Redis = createBullConnection();
  readonly queue = new Queue<ReservationJob>(env.queueName, {
    connection: this.connection,
    defaultJobOptions: {
      // ~8 attempts over ~2 minutes (0.5s, 1s, 2s, ... 64s) so a short PostgreSQL outage doesn't
      // turn into permanently failed jobs. If a job still fails for good, the reconciler re-drives it.
      attempts: 8,
      backoff: { type: 'exponential', delay: 500 },
      // Keep finished jobs around for a while so you can inspect them, but not forever.
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 24 * 3600, count: 5000 },
    },
  });

  /**
   * jobId = reservationId gives us *some* producer-side dedupe: BullMQ ignores an add with an id
   * it still remembers. Once the job is removed, the same id can be added again, so the worker
   * must be idempotent anyway.
   */
  add(job: ReservationJob, jobId = job.reservationId) {
    return this.queue.add(PERSIST_JOB, job, { jobId });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }
}
