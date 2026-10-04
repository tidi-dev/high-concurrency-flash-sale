import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { DemoConfig } from '@flash/shared';
import type Redis from 'ioredis';
import { DEFAULT_CONFIG, parseDemoConfig, serializeDemoConfig, validateConfigPatch } from './demo-config';
import { keys } from './keys';
import { REDIS } from './redis';

const CACHE_MS = 250;

/** Reads/writes the live demo knobs in the Redis hash `flash:config` (shared by API and worker). */
@Injectable()
export class DemoConfigService {
  private cached: { value: DemoConfig; at: number } | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async get(): Promise<DemoConfig> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const value = parseDemoConfig(await this.redis.hgetall(keys.config));
    this.cached = { value, at: Date.now() };
    return value;
  }

  /**
   * Writes ONLY the fields in the patch (HSET of those fields), so two dashboards changing
   * different knobs at the same time don't overwrite each other: no lost update here.
   */
  async update(patch: Record<string, unknown>): Promise<DemoConfig> {
    const { values, errors } = validateConfigPatch(patch);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    if (Object.keys(values).length) await this.redis.hset(keys.config, values);
    this.cached = null;
    return this.get();
  }

  async resetToDefaults(): Promise<DemoConfig> {
    await this.redis.del(keys.config);
    await this.redis.hset(keys.config, serializeDemoConfig(DEFAULT_CONFIG));
    this.cached = null;
    return this.get();
  }
}
