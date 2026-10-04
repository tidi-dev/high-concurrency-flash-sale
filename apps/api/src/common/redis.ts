import Redis from 'ioredis';
import { env } from './env';

/** Injection token for the shared command connection. */
export const REDIS = Symbol('REDIS');

export function createRedis(): Redis {
  return new Redis(env.redisUrl, { lazyConnect: false });
}

/** BullMQ needs its own connection settings: workers use blocking commands and must retry forever. */
export function createBullConnection(): Redis {
  return new Redis(env.redisUrl, { maxRetriesPerRequest: null });
}
