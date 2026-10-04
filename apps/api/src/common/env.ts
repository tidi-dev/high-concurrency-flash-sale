// Process-level settings (from environment variables). Demo knobs that change at
// runtime live in Redis instead. See demo-config.ts.
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://flashsale:flashsale@localhost:5432/flashsale',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  port: Number(process.env.PORT ?? 3000),
  queueName: process.env.QUEUE_NAME ?? 'reservations',
  /** How often the worker's sweeper looks for expired reservations. */
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 1000),
  /** A pending reservation older than this with no queue job is considered orphaned. */
  orphanGraceMs: Number(process.env.ORPHAN_GRACE_MS ?? 5000),
  /** PostgreSQL pool size per process. */
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 20),
  /** `all` | `important` | `off`. Controls the JSON event log on stdout. */
  logEvents: process.env.LOG_EVENTS ?? 'important',
  webDist: process.env.WEB_DIST,
};
