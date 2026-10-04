import { DEFAULT_CONFIG, parseDemoConfig, serializeDemoConfig, validateConfigPatch } from './demo-config';

describe('demo config', () => {
  it('uses defaults for an empty hash', () => {
    expect(parseDemoConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('parses stored string values', () => {
    const cfg = parseDemoConfig({
      reserveStrategy: 'decr',
      reservationTtlSec: '45',
      naiveVariant: 'atomic',
      naiveDelayMs: '5',
      workerDelayMs: '200',
      workerConcurrency: '1',
      workerIdempotency: 'broken',
      duplicateDelivery: 'true',
      crashAfterReservePercent: '10',
    });
    expect(cfg).toEqual({
      reserveStrategy: 'decr',
      reservationTtlSec: 45,
      naiveVariant: 'atomic',
      naiveDelayMs: 5,
      workerDelayMs: 200,
      workerConcurrency: 1,
      workerIdempotency: 'broken',
      duplicateDelivery: true,
      crashAfterReservePercent: 10,
    });
  });

  it('falls back to defaults for invalid enum values and clamps numbers', () => {
    const cfg = parseDemoConfig({
      reserveStrategy: 'magic',
      reservationTtlSec: '-5',
      naiveDelayMs: '99999',
      crashAfterReservePercent: '150',
      workerDelayMs: 'abc',
    });
    expect(cfg.reserveStrategy).toBe(DEFAULT_CONFIG.reserveStrategy);
    expect(cfg.reservationTtlSec).toBe(1);
    expect(cfg.naiveDelayMs).toBe(5000);
    expect(cfg.crashAfterReservePercent).toBe(100);
    expect(cfg.workerDelayMs).toBe(DEFAULT_CONFIG.workerDelayMs);
  });

  it('round-trips through serialize', () => {
    const cfg = { ...DEFAULT_CONFIG, duplicateDelivery: true, naiveDelayMs: 42 };
    expect(parseDemoConfig(serializeDemoConfig(cfg))).toEqual(cfg);
  });
});

describe('validateConfigPatch', () => {
  it('accepts valid fields and returns only those, serialized', () => {
    expect(validateConfigPatch({ reserveStrategy: 'decr', naiveDelayMs: 7, duplicateDelivery: true })).toEqual({
      values: { reserveStrategy: 'decr', naiveDelayMs: '7', duplicateDelivery: 'true' },
      errors: [],
    });
  });

  it('rejects invalid values instead of silently resetting them to defaults', () => {
    const r = validateConfigPatch({ reserveStrategy: 'magic', reservationTtlSec: -5, duplicateDelivery: 'yes', bogus: 1 });
    expect(r.values).toEqual({});
    expect(r.errors).toHaveLength(4);
  });
});
