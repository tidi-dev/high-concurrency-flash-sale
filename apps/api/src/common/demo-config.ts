import type { DemoConfig, NaiveVariant, ReserveStrategy, WorkerIdempotency } from '@flash/shared';

// Demo "knobs" live in the Redis hash `flash:config`, so the API process and the
// worker process see the same values and the dashboard can change them live.

export const DEFAULT_CONFIG: DemoConfig = {
  reserveStrategy: 'lua',
  reservationTtlSec: 30,
  naiveVariant: 'check-then-act',
  naiveDelayMs: 20,
  workerDelayMs: 0,
  workerConcurrency: 16,
  workerIdempotency: 'transactional',
  duplicateDelivery: false,
  crashAfterReservePercent: 0,
};

const STRATEGIES: ReserveStrategy[] = ['lua', 'decr'];
const VARIANTS: NaiveVariant[] = ['check-then-act', 'lost-update', 'atomic'];
const IDEMPOTENCY: WorkerIdempotency[] = ['transactional', 'broken'];

function oneOf<T extends string>(value: string | undefined, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function parseDemoConfig(hash: Record<string, string | undefined>): DemoConfig {
  const d = DEFAULT_CONFIG;
  return {
    reserveStrategy: oneOf(hash.reserveStrategy, STRATEGIES, d.reserveStrategy),
    reservationTtlSec: int(hash.reservationTtlSec, d.reservationTtlSec, 1, 3600),
    naiveVariant: oneOf(hash.naiveVariant, VARIANTS, d.naiveVariant),
    naiveDelayMs: int(hash.naiveDelayMs, d.naiveDelayMs, 0, 5000),
    workerDelayMs: int(hash.workerDelayMs, d.workerDelayMs, 0, 10000),
    workerConcurrency: int(hash.workerConcurrency, d.workerConcurrency, 1, 64),
    workerIdempotency: oneOf(hash.workerIdempotency, IDEMPOTENCY, d.workerIdempotency),
    duplicateDelivery: hash.duplicateDelivery === undefined ? d.duplicateDelivery : hash.duplicateDelivery === 'true',
    crashAfterReservePercent: int(hash.crashAfterReservePercent, d.crashAfterReservePercent, 0, 100),
  };
}

export function serializeDemoConfig(cfg: DemoConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, String(v)]));
}

const NUMBER_RANGES: Partial<Record<keyof DemoConfig, [number, number]>> = {
  reservationTtlSec: [1, 3600],
  naiveDelayMs: [0, 5000],
  workerDelayMs: [0, 10000],
  workerConcurrency: [1, 64],
  crashAfterReservePercent: [0, 100],
};
const ENUMS: Partial<Record<keyof DemoConfig, readonly string[]>> = {
  reserveStrategy: STRATEGIES,
  naiveVariant: VARIANTS,
  workerIdempotency: IDEMPOTENCY,
};

/** Validates a PATCH body. Returns only the valid fields (serialized for Redis) plus human-readable errors. */
export function validateConfigPatch(patch: Record<string, unknown>): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const k = key as keyof DemoConfig;
    if (!(key in DEFAULT_CONFIG)) errors.push(`unknown setting "${key}"`);
    else if (ENUMS[k]) {
      if (typeof value === 'string' && ENUMS[k]!.includes(value)) values[key] = value;
      else errors.push(`${key} must be one of ${ENUMS[k]!.join(', ')}`);
    } else if (NUMBER_RANGES[k]) {
      const [min, max] = NUMBER_RANGES[k]!;
      if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) values[key] = String(value);
      else errors.push(`${key} must be an integer between ${min} and ${max}`);
    } else if (typeof value === 'boolean') values[key] = String(value);
    else errors.push(`${key} must be true or false`);
  }
  return { values, errors };
}
