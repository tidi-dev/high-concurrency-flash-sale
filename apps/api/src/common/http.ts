import { BadRequestException } from '@nestjs/common';

/** Minimal input validation (kept dependency-free on purpose). */
export function optionalString(v: unknown, name: string, max = 200): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`${name} must be a string of at most ${max} characters`);
  return v;
}

export function intInRange(v: unknown, name: string, min: number, max: number, fallback?: number): number {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  return n;
}
