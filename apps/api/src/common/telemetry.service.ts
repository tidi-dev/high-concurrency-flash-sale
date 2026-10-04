import { Inject, Injectable } from '@nestjs/common';
import type { DemoEvent, EventType, Mode } from '@flash/shared';
import type Redis from 'ioredis';
import { env } from './env';
import { keys } from './keys';
import { REDIS } from './redis';

const MAX_EVENTS = 200;

// High-volume events that are left out of stdout unless LOG_EVENTS=all.
const NOISY: EventType[] = ['SOLD_OUT', 'NAIVE_SOLD_OUT', 'ALREADY_RESERVED', 'NAIVE_STOCK_READ', 'WORKER_PICKED'];

// Assigns a sequence number and appends to a capped list in a single round-trip.
// KEYS: 1 seq, 2 list   ARGV: 1 json-without-seq (a JSON object string), 2 max
const PUSH_EVENT_LUA = `
local seq = redis.call('INCR', KEYS[1])
local json = '{"seq":' .. seq .. ',' .. string.sub(ARGV[1], 2)
redis.call('LPUSH', KEYS[2], json)
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[2]) - 1)
return seq
`;

// Gauge with high-water mark, used for the naive "race window".
// KEYS: 1 hash   ARGV: 1 field, 2 delta
const GAUGE_LUA = `
local v = redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
local peak = tonumber(redis.call('HGET', KEYS[1], ARGV[1] .. 'Peak') or '0')
if v > peak then redis.call('HSET', KEYS[1], ARGV[1] .. 'Peak', v) end
return v
`;

type Redisx = Redis & {
  flashPushEvent(seqKey: string, listKey: string, json: string, max: number): Promise<number>;
  flashGauge(hash: string, field: string, delta: number): Promise<number>;
};

export interface EventInput {
  type: EventType;
  mode: Mode | 'system';
  reservationId?: string;
  userId?: string;
  detail?: string;
}

/**
 * Observability: structured JSON logs on stdout, a capped event list for the dashboard,
 * and counters. Counters are *observations*, not facts: they live in Redis next to the data
 * they describe, but they're not updated atomically with it. The dashboard's "facts" come
 * from PostgreSQL rows and the Redis stock itself.
 */
@Injectable()
export class TelemetryService {
  private readonly r: Redisx;

  constructor(@Inject(REDIS) redis: Redis) {
    if (!('flashPushEvent' in redis)) redis.defineCommand('flashPushEvent', { numberOfKeys: 2, lua: PUSH_EVENT_LUA });
    if (!('flashGauge' in redis)) redis.defineCommand('flashGauge', { numberOfKeys: 1, lua: GAUGE_LUA });
    this.r = redis as Redisx;
  }

  /** Records an event and/or increments counters, in one pipeline (one network round-trip). */
  async record(event: EventInput | null, counters?: { hash: string; incr: Record<string, number> }): Promise<void> {
    const pipe = this.r.pipeline() as ReturnType<Redis['pipeline']> & {
      flashPushEvent(a: string, b: string, c: string, d: number): unknown;
    };
    if (event) {
      const body: Omit<DemoEvent, 'seq'> = { ts: Date.now(), ...event };
      pipe.flashPushEvent(keys.eventsSeq, keys.events, JSON.stringify(body), MAX_EVENTS);
      this.log(body);
    }
    if (counters) for (const [field, by] of Object.entries(counters.incr)) pipe.hincrby(counters.hash, field, by);
    await pipe.exec();
  }

  gauge(hash: string, field: string, delta: number): Promise<number> {
    return this.r.flashGauge(hash, field, delta);
  }

  async recentEvents(limit = 50): Promise<DemoEvent[]> {
    const raw = await this.r.lrange(keys.events, 0, limit - 1);
    return raw.map((s) => JSON.parse(s) as DemoEvent);
  }

  private log(body: Omit<DemoEvent, 'seq'>): void {
    if (env.logEvents === 'off') return;
    if (env.logEvents !== 'all' && NOISY.includes(body.type)) return;
    const { type, ts, ...rest } = body;
    process.stdout.write(JSON.stringify({ ts: new Date(ts).toISOString(), event: type, ...rest }) + '\n');
  }
}
