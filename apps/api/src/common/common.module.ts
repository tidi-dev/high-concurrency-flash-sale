import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { ReservationScripts } from '../flash/redis-scripts';
import { DemoConfigService } from './demo-config.service';
import { PrismaService } from './prisma.service';
import { QueueService } from './queue.service';
import { createRedis, REDIS } from './redis';
import { TelemetryService } from './telemetry.service';

@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: createRedis },
    { provide: ReservationScripts, useFactory: (r: Redis) => new ReservationScripts(r), inject: [REDIS] },
    PrismaService,
    QueueService,
    DemoConfigService,
    TelemetryService,
  ],
  exports: [REDIS, ReservationScripts, PrismaService, QueueService, DemoConfigService, TelemetryService],
})
export class CommonModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
