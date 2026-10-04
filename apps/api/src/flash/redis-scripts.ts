// The Redis side of a reservation.
//
// WHY LUA?
// A single Redis command (DECR, INCR, HSET...) is atomic: Redis runs commands one at a
// time on one thread, so nothing can interleave *inside* a command. A *sequence* of
// commands sent from Node is NOT atomic: other clients' commands can run between them.
//
// When a decision depends on what we read AND must update several keys together
// ("if stock > 0 and this user has nothing reserved: decrement, record the reservation,
// remember the user, mark it pending"), we send the whole thing as a Lua script. Redis
// runs the script start to finish without running anything else in between.
//
// Cost: while a script runs, Redis serves nobody else, so scripts must stay tiny.
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { keys } from '../common/keys';

/** After a reservation reaches a final state we keep its Redis hash for an hour for inspection, then let Redis delete it.
 * TTLs are for garbage collection here, never for business logic. */
const TERMINAL_GC_TTL_SEC = 3600;

// KEYS: 1 stock, 2 reservation hash, 3 user key, 4 pending zset, 5 sale id, 6 waitlist
// ARGV: 1 reservationId, 2 userId, 3 nowMs, 4 expiresAtMs
const RESERVE_LUA = `
local stock = redis.call('GET', KEYS[1])
if not stock then
  return {'NOT_INITIALIZED', -1, '', ''}
end
stock = tonumber(stock)
local existing = redis.call('GET', KEYS[3])
if existing then
  return {'ALREADY_RESERVED', stock, '', existing}
end
if stock <= 0 then
  return {'SOLD_OUT', stock, '', ''}
end
local sale = redis.call('GET', KEYS[5]) or ''
local remaining = redis.call('DECR', KEYS[1])
redis.call('HSET', KEYS[2], 'status', 'RESERVED', 'userId', ARGV[2], 'createdAt', ARGV[3], 'expiresAt', ARGV[4], 'confirmed', '0', 'saleId', sale)
redis.call('SET', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('ZREM', KEYS[6], ARGV[2])
return {'ALLOWED', remaining, sale, ''}
`;

// Worker handshake before writing to PostgreSQL. Once `confirmed=1`, the reconciler may no
// longer release this unit; it re-enqueues the message instead if the job dies.
// The reservation STAYS in `pending` until the DB commit (see clearPending), so a job that
// confirms and then fails for good is still visible to the reconciler.
// KEYS: 1 reservation hash   ARGV: (none)
const CONFIRM_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then
  return 'MISSING'
end
if status == 'ORPHAN_RELEASED' then
  return 'RELEASED'
end
redis.call('HSET', KEYS[1], 'confirmed', '1')
return 'OK'
`;

// The worker could NOT persist (PostgreSQL had no stock, or the message belonged to an old sale).
// No INCR: PostgreSQL never had that unit. Free the user so they can try again, stop tracking it
// as pending, and let the hash expire later. Never creates a hash that doesn't exist.
// KEYS: 1 reservation hash, 2 user key, 3 pending zset   ARGV: 1 reservationId, 2 gc ttl seconds
const MARK_REJECTED_LUA = `
redis.call('ZREM', KEYS[3], ARGV[1])
local status = redis.call('HGET', KEYS[1], 'status')
if not status then
  return 'MISSING'
end
redis.call('HSET', KEYS[1], 'status', 'REJECTED')
if redis.call('GET', KEYS[2]) == ARGV[1] then
  redis.call('DEL', KEYS[2])
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 'REJECTED'
`;

// Shared by both release scripts: a freed unit goes to the FIRST shopper on the waitlist (as a
// brand-new reservation), and only goes back to the public stock if nobody is waiting. Doing this
// inside the same script as the release is what makes it fair: there is no moment where the unit
// sits in the public stock and a random buyer could snipe it.
//
// The next user's key is built inside the script (we only learn who is next while running). Redis
// asks scripts to declare their keys up front; this one is still safe on a Cluster because it
// shares the product's {hash tag}, so it lives on the same slot as every declared key.
const GIVE_BACK_LUA = `
local function giveBack(stockKey, waitKey, saleKey, newResKey, pendingKey, newRid, nowMs, expMs, userPrefix)
  while true do
    local popped = redis.call('ZPOPMIN', waitKey)
    if #popped == 0 then break end
    local nextUser = popped[1]
    local nextUserKey = userPrefix .. nextUser
    if redis.call('EXISTS', nextUserKey) == 0 then
      local sale = redis.call('GET', saleKey) or ''
      redis.call('HSET', newResKey, 'status', 'RESERVED', 'userId', nextUser, 'createdAt', nowMs, 'expiresAt', expMs, 'confirmed', '0', 'saleId', sale, 'via', 'waitlist')
      redis.call('SET', nextUserKey, newRid)
      redis.call('ZADD', pendingKey, nowMs, newRid)
      return nextUser
    end
    -- this shopper already holds a unit (bought normally since joining): skip them
  end
  redis.call('INCR', stockKey)
  return false
end
`;

// Give a unit back. Idempotent: only a reservation still in RESERVED can be released,
// and releasing flips it out of RESERVED in the same atomic step.
// KEYS: 1 stock, 2 reservation hash, 3 user key, 4 pending zset, 5 waitlist, 6 sale id, 7 hand-off reservation hash
// ARGV: 1 reservationId, 2 new status, 3 gc ttl seconds, 4 hand-off reservationId, 5 nowMs, 6 hand-off expiresAtMs, 7 user key prefix
const RELEASE_LUA =
  GIVE_BACK_LUA +
  `
local status = redis.call('HGET', KEYS[2], 'status')
if not status then
  return 'MISSING'
end
if status ~= 'RESERVED' then
  return 'NOT_RESERVED:' .. status
end
redis.call('HSET', KEYS[2], 'status', ARGV[2])
if redis.call('GET', KEYS[3]) == ARGV[1] then
  redis.call('DEL', KEYS[3])
end
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local handedTo = giveBack(KEYS[1], KEYS[5], KEYS[6], KEYS[7], KEYS[4], ARGV[4], ARGV[5], ARGV[6], ARGV[7])
if handedTo then
  return 'HANDED_OFF:' .. handedTo
end
return 'RELEASED'
`;

// Reconciler: release a reservation that Redis admitted but that never reached the
// worker (e.g. the API crashed before publishing to the queue).
// KEYS: same as RELEASE_LUA
// ARGV: 1 reservationId, 2 cutoff createdAt ms, 3 gc ttl seconds, 4-7 same as RELEASE_LUA
const RELEASE_ORPHAN_LUA =
  GIVE_BACK_LUA +
  `
local h = redis.call('HMGET', KEYS[2], 'status', 'confirmed', 'createdAt')
local status, confirmed, createdAt = h[1], h[2], h[3]
if not status then
  redis.call('ZREM', KEYS[4], ARGV[1])
  return 'MISSING'
end
if status ~= 'RESERVED' then
  return 'NOT_RESERVED:' .. status
end
if confirmed == '1' then
  return 'CONFIRMED'
end
if tonumber(createdAt) > tonumber(ARGV[2]) then
  return 'TOO_YOUNG'
end
redis.call('HSET', KEYS[2], 'status', 'ORPHAN_RELEASED')
if redis.call('GET', KEYS[3]) == ARGV[1] then
  redis.call('DEL', KEYS[3])
end
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local handedTo = giveBack(KEYS[1], KEYS[5], KEYS[6], KEYS[7], KEYS[4], ARGV[4], ARGV[5], ARGV[6], ARGV[7])
if handedTo then
  return 'HANDED_OFF:' .. handedTo
end
return 'RELEASED'
`;

// Join the waitlist (only makes sense when sold out, and not while already holding a unit).
// KEYS: 1 stock, 2 user key, 3 waitlist   ARGV: 1 userId, 2 nowMs
const JOIN_WAITLIST_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return {'ALREADY_RESERVED', 0}
end
local stock = redis.call('GET', KEYS[1])
if not stock then
  return {'NOT_INITIALIZED', 0}
end
if tonumber(stock) > 0 then
  return {'STOCK_AVAILABLE', 0}
end
redis.call('ZADD', KEYS[3], 'NX', ARGV[2], ARGV[1])
return {'WAITING', redis.call('ZRANK', KEYS[3], ARGV[1]) + 1}
`;

// KEYS: 1 reservation hash   ARGV: 1 gc ttl seconds
const MARK_PAID_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then
  return 'MISSING'
end
if status ~= 'RESERVED' then
  return 'NOT_RESERVED:' .. status
end
redis.call('HSET', KEYS[1], 'status', 'PAID')
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 'PAID'
`;

// Keep the lowest value ever returned by DECR (decr strategy), so the dashboard can show
// that the "interview answer" lets the counter go negative for a moment.
// KEYS: 1 metrics hash   ARGV: 1 observed value
const RECORD_MIN_LUA = `
local cur = redis.call('HGET', KEYS[1], 'minObservedStock')
if (not cur) or tonumber(ARGV[1]) < tonumber(cur) then
  redis.call('HSET', KEYS[1], 'minObservedStock', ARGV[1])
end
return 1
`;

export type ReserveResult = 'ALLOWED' | 'SOLD_OUT' | 'ALREADY_RESERVED' | 'NOT_INITIALIZED';

export type JoinResult = 'WAITING' | 'STOCK_AVAILABLE' | 'ALREADY_RESERVED' | 'NOT_INITIALIZED';

/** The reservation a freed unit becomes if someone is on the waitlist (id and times chosen by the caller). */
export interface Handoff {
  reservationId: string;
  nowMs: number;
  expiresAtMs: number;
}

const defaultHandoff = (ttlMs = 30_000): Handoff => {
  const nowMs = Date.now();
  return { reservationId: randomUUID(), nowMs, expiresAtMs: nowMs + ttlMs };
};

export interface ReserveOutput {
  result: ReserveResult;
  remaining: number;
  /** The sale (fencing token) this admission belongs to. Only for ALLOWED. */
  saleId?: string;
  /** Only for ALREADY_RESERVED: the reservation this user already holds. */
  existingReservationId?: string;
}

export interface ReserveInput {
  productId: string;
  reservationId: string;
  userId: string;
  nowMs: number;
  expiresAtMs: number;
}

interface ScriptCommands {
  flashReserve(k1: string, k2: string, k3: string, k4: string, k5: string, k6: string, ...argv: (string | number)[]): Promise<[string, number, string, string]>;
  flashConfirm(k1: string): Promise<string>;
  flashMarkRejected(k1: string, k2: string, k3: string, rid: string, ttl: number): Promise<string>;
  flashRelease(...keysThenArgv: (string | number)[]): Promise<string>;
  flashReleaseOrphan(...keysThenArgv: (string | number)[]): Promise<string>;
  flashJoinWaitlist(k1: string, k2: string, k3: string, userId: string, nowMs: number): Promise<[string, number]>;
  flashMarkPaid(k1: string, ttl: number): Promise<string>;
  flashRecordMin(k1: string, value: number): Promise<number>;
}

export class ReservationScripts {
  private readonly r: Redis & ScriptCommands;

  constructor(redis: Redis) {
    // defineCommand loads the script once (EVALSHA) and exposes it as a method.
    const defs: [keyof ScriptCommands, number, string][] = [
      ['flashReserve', 6, RESERVE_LUA],
      ['flashConfirm', 1, CONFIRM_LUA],
      ['flashMarkRejected', 3, MARK_REJECTED_LUA],
      ['flashRelease', 7, RELEASE_LUA],
      ['flashReleaseOrphan', 7, RELEASE_ORPHAN_LUA],
      ['flashJoinWaitlist', 3, JOIN_WAITLIST_LUA],
      ['flashMarkPaid', 1, MARK_PAID_LUA],
      ['flashRecordMin', 1, RECORD_MIN_LUA],
    ];
    for (const [name, numberOfKeys, lua] of defs) {
      if (!(name in redis)) redis.defineCommand(name, { numberOfKeys, lua });
    }
    this.r = redis as Redis & ScriptCommands;
  }

  /** Strategy `lua`: check-and-reserve in one atomic script. Stock never goes below 0. */
  async reserve(i: ReserveInput): Promise<ReserveOutput> {
    const [result, remaining, saleId, existing] = await this.r.flashReserve(
      keys.stock(i.productId),
      keys.reservation(i.productId, i.reservationId),
      keys.user(i.productId, i.userId),
      keys.pending(i.productId),
      keys.sale(i.productId),
      keys.waitlist(i.productId),
      i.reservationId,
      i.userId,
      i.nowMs,
      i.expiresAtMs,
    );
    const out: ReserveOutput = { result: result as ReserveResult, remaining: Number(remaining) };
    if (result === 'ALLOWED') out.saleId = saleId;
    if (result === 'ALREADY_RESERVED') out.existingReservationId = existing;
    return out;
  }

  /**
   * Strategy `decr`: the classic interview answer.
   *
   *   stock = DECR key; if stock < 0 { INCR key; SOLD_OUT }
   *
   * Correct for the counter: every DECR is atomic, so at most `stock` callers ever see a value >= 0.
   * Caveats you can observe: (1) the counter is briefly negative, (2) every sold-out request
   * costs two writes, (3) recording the reservation is a *separate* step (a crash in between
   * leaves a decremented counter with no record), (4) DECR on a missing key silently creates it
   * at -1, and (5) no per-user limit, because that check can't be combined atomically without Lua.
   */
  async reserveWithDecr(
    i: ReserveInput,
  ): Promise<{ result: 'ALLOWED' | 'SOLD_OUT'; remaining: number; observed: number; compensated: boolean; saleId?: string }> {
    const stockKey = keys.stock(i.productId);
    const observed = await this.r.decr(stockKey);
    if (observed < 0) {
      await this.r.incr(stockKey);
      return { result: 'SOLD_OUT', remaining: 0, observed, compensated: true };
    }
    const saleId = (await this.r.get(keys.sale(i.productId))) ?? '';
    await this.r
      .multi()
      .hset(keys.reservation(i.productId, i.reservationId), {
        status: 'RESERVED',
        userId: i.userId,
        createdAt: i.nowMs,
        expiresAt: i.expiresAtMs,
        confirmed: '0',
        saleId,
      })
      .zadd(keys.pending(i.productId), i.nowMs, i.reservationId)
      .exec();
    return { result: 'ALLOWED', remaining: observed, observed, compensated: false, saleId };
  }

  confirm(productId: string, reservationId: string): Promise<'OK' | 'RELEASED' | 'MISSING'> {
    return this.r.flashConfirm(keys.reservation(productId, reservationId)) as Promise<'OK' | 'RELEASED' | 'MISSING'>;
  }

  /** Called after the worker's PostgreSQL commit: the reservation is no longer "admitted but not persisted". */
  clearPending(productId: string, reservationId: string): Promise<number> {
    return this.r.zrem(keys.pending(productId), reservationId);
  }

  markRejected(productId: string, reservationId: string, userId: string): Promise<string> {
    return this.r.flashMarkRejected(
      keys.reservation(productId, reservationId),
      keys.user(productId, userId),
      keys.pending(productId),
      reservationId,
      TERMINAL_GC_TTL_SEC,
    );
  }

  /**
   * Returns 'RELEASED' (unit back in public stock) or 'HANDED_OFF:<userId>' (unit given to the first
   * shopper on the waitlist as reservation `handoff.reservationId`) only for the one call that actually
   * freed the unit; anything else means there was nothing to free.
   */
  release(productId: string, reservationId: string, userId: string, newStatus: 'EXPIRED', handoff: Handoff = defaultHandoff()): Promise<string> {
    return this.r.flashRelease(
      ...this.releaseKeys(productId, reservationId, userId, handoff),
      reservationId,
      newStatus,
      TERMINAL_GC_TTL_SEC,
      handoff.reservationId,
      handoff.nowMs,
      handoff.expiresAtMs,
      keys.userPrefix(productId),
    );
  }

  releaseOrphan(productId: string, reservationId: string, userId: string, cutoffMs: number, handoff: Handoff = defaultHandoff()): Promise<string> {
    return this.r.flashReleaseOrphan(
      ...this.releaseKeys(productId, reservationId, userId, handoff),
      reservationId,
      cutoffMs,
      TERMINAL_GC_TTL_SEC,
      handoff.reservationId,
      handoff.nowMs,
      handoff.expiresAtMs,
      keys.userPrefix(productId),
    );
  }

  private releaseKeys(productId: string, reservationId: string, userId: string, handoff: Handoff): string[] {
    return [
      keys.stock(productId),
      keys.reservation(productId, reservationId),
      keys.user(productId, userId),
      keys.pending(productId),
      keys.waitlist(productId),
      keys.sale(productId),
      keys.reservation(productId, handoff.reservationId),
    ];
  }

  async joinWaitlist(productId: string, userId: string, nowMs: number): Promise<{ result: JoinResult; position: number }> {
    const [result, position] = await this.r.flashJoinWaitlist(keys.stock(productId), keys.user(productId, userId), keys.waitlist(productId), userId, nowMs);
    return { result: result as JoinResult, position: Number(position) };
  }

  markPaid(productId: string, reservationId: string): Promise<string> {
    return this.r.flashMarkPaid(keys.reservation(productId, reservationId), TERMINAL_GC_TTL_SEC);
  }

  recordMinObserved(value: number): Promise<number> {
    return this.r.flashRecordMin(keys.flashMetrics, value);
  }
}
