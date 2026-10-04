// Type-only contracts shared by the API (apps/api) and the dashboard (apps/web).
// This package has no runtime code: both sides use `import type`.

export type Mode = 'naive' | 'flash';

/** `lua` = check-and-reserve script (never goes negative). `decr` = the classic interview answer: DECR, INCR back if negative. */
export type ReserveStrategy = 'lua' | 'decr';

/**
 * Mode A variants:
 *  - check-then-act: SELECT, check, `stock = stock - 1` (INTENTIONALLY UNSAFE, stock goes negative)
 *  - lost-update:    SELECT, check, `stock = <value read> - 1` (INTENTIONALLY UNSAFE, oversell is hidden)
 *  - atomic:         conditional `UPDATE ... WHERE stock > 0` in a transaction (safe, but serializes on one row)
 */
export type NaiveVariant = 'check-then-act' | 'lost-update' | 'atomic';

/** `transactional` = side effects only if the idempotent insert happened, in one transaction. `broken` = side effect outside the guard. */
export type WorkerIdempotency = 'transactional' | 'broken';

export interface DemoConfig {
  reserveStrategy: ReserveStrategy;
  reservationTtlSec: number;
  naiveVariant: NaiveVariant;
  naiveDelayMs: number;
  workerDelayMs: number;
  /** How many jobs one worker process handles in parallel ("how many clerks"). */
  workerConcurrency: number;
  workerIdempotency: WorkerIdempotency;
  /** API enqueues every reservation twice (simulates at-least-once redelivery). */
  duplicateDelivery: boolean;
  /** Percentage of admitted requests where the API "crashes" after the Redis reservation but before publishing to the queue. */
  crashAfterReservePercent: number;
}

export type EventType =
  | 'RESERVATION_ALLOWED'
  | 'SOLD_OUT'
  | 'NOT_INITIALIZED'
  | 'ALREADY_RESERVED'
  | 'ORDER_QUEUED'
  | 'ENQUEUE_FAILED'
  | 'RESERVATION_CONFIRMED'
  | 'ORDER_CREATED'
  | 'RESERVATION_REJECTED'
  | 'STALE_MESSAGE_DROPPED'
  | 'REDRIVEN'
  | 'DUPLICATE_MESSAGE_IGNORED'
  | 'PAYMENT_COMPLETED'
  | 'PAYMENT_REJECTED'
  | 'RESERVATION_EXPIRED'
  | 'STOCK_RELEASED'
  | 'STOCK_RELEASE_SKIPPED'
  | 'ORPHAN_RELEASED'
  | 'NAIVE_STOCK_READ'
  | 'NAIVE_ORDER_CREATED'
  | 'WORKER_PICKED'
  | 'STORY_STARTED'
  | 'STORY_FINISHED'
  | 'NAIVE_SOLD_OUT'
  | 'DEMO_RESET'
  | 'CONFIG_CHANGED'
  | 'WORKER_PAUSED'
  | 'WORKER_RESUMED'
  | 'REDIS_DATA_LOST'
  | 'RECONCILED'
  | 'SIMULATION_STARTED'
  | 'SIMULATION_FINISHED';

export interface DemoEvent {
  seq: number;
  ts: number;
  type: EventType;
  mode: Mode | 'system';
  reservationId?: string;
  userId?: string;
  detail?: string;
}

export interface LatencyStats {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface LoadRunResult {
  runId: string;
  mode: Mode;
  users: number;
  concurrency: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  throughputRps: number;
  /** Response outcome -> count, e.g. { RESERVED: 500, SOLD_OUT: 9500 }. */
  outcomes: Record<string, number>;
  errors: number;
  latency: LatencyStats;
}

export interface SimulationProgress {
  runId: string;
  mode: Mode;
  users: number;
  completed: number;
  startedAt: number;
  running: boolean;
}

export interface Invariant {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface NaiveMetrics {
  requests: number;
  success: number;
  soldOut: number;
  errors: number;
  dbQueries: number;
  /** Requests currently between "read stock" and "write stock": the race window. */
  raceWindow: number;
  raceWindowPeak: number;
}

export interface NaiveState {
  product: { id: string; name: string; initialStock: number; stock: number } | null;
  orders: number;
  oversold: number;
  metrics: NaiveMetrics;
  lastRun: LoadRunResult | null;
  invariants: Invariant[];
}

export interface FlashMetrics {
  requests: number;
  allowed: number;
  soldOut: number;
  alreadyReserved: number;
  errors: number;
  queued: number;
  enqueueFailed: number;
  /** decr strategy: how many times DECR went negative and had to be INCR'd back. */
  compensations: number;
  confirmed: number;
  persisted: number;
  duplicatesIgnored: number;
  rejected: number;
  /** Messages from an older sale fenced out by the saleId check. */
  staleDropped: number;
  /** Messages re-enqueued by the reconciler after their job died post-confirm. */
  redriven: number;
  paid: number;
  expired: number;
  released: number;
  orphansReleased: number;
}

export interface FlashState {
  product: { id: string; name: string; initialStock: number; dbStock: number } | null;
  redis: {
    stock: number | null;
    /** Admitted by Redis but not yet confirmed by the worker. */
    pending: number;
    /** Lowest value DECR ever returned (decr strategy shows negatives here). */
    minObservedStock: number | null;
  };
  db: {
    reserved: number;
    paid: number;
    expired: number;
    rejected: number;
    ordersTotal: number;
    ordersPending: number;
    ordersPaid: number;
    ordersCancelled: number;
    expiredNotReleasedToRedis: number;
  };
  queue: { waiting: number; active: number; delayed: number; completed: number; failed: number; paused: boolean };
  metrics: FlashMetrics;
  /** redisStock - (dbStock - pending). 0 means Redis and PostgreSQL agree. */
  drift: number | null;
  lastRun: LoadRunResult | null;
  invariants: Invariant[];
}

export interface StateSnapshot {
  ts: number;
  /** Current sale id (changes on reset / simulated Redis data loss). */
  saleId: string;
  config: DemoConfig;
  naive: NaiveState;
  flash: FlashState;
  simulation: SimulationProgress | null;
}

export type BuyStatus = 'RESERVED' | 'SOLD_OUT' | 'ALREADY_RESERVED' | 'NOT_INITIALIZED' | 'SIMULATED_CRASH';

export interface BuyResponse {
  status: BuyStatus;
  reservationId?: string;
  expiresAt?: number;
  message: string;
}

export interface NaiveBuyResponse {
  status: 'ORDER_CREATED' | 'SOLD_OUT';
  orderId?: string;
  stockRead?: number;
  message: string;
}

export interface ReservationView {
  id: string;
  userId: string | null;
  /** DB status if persisted, else the Redis status. */
  status: string;
  persisted: boolean;
  expiresAt: number | null;
  createdAt: number | null;
  paidAt: number | null;
  redis: Record<string, string> | null;
  order: { id: string; status: string } | null;
}

export type StorySpeed = 'slow' | 'very-slow';

export interface StoryRun {
  runId: string;
  mode: Mode;
  stock: number;
  /** userIds of the shoppers, in arrival order. Events for them carry these userIds. */
  shoppers: string[];
  startedAt: number;
}
