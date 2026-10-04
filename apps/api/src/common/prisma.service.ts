import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { env } from './env';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    // Prisma 7 talks to PostgreSQL through the `pg` driver. `max` is the connection pool size:
    // the number of queries this process can run *at the same time*. Every naive buy needs one
    // of these, which is the first bottleneck you hit under a spike.
    super({ adapter: new PrismaPg({ connectionString: env.databaseUrl, max: env.dbPoolSize }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
