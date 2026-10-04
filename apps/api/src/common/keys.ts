// Every Redis key the demo uses, in one place so you can find them with redis-cli.
//
// The `{productId}` braces are a Redis Cluster *hash tag*: Cluster hashes only the
// part inside {...}, so all keys of one product land on the same slot. Multi-key Lua
// scripts require that. On a single Redis node the braces are just characters.
export const PRODUCTS = {
  naive: { id: 'naive-sneaker', name: 'Limited Sneaker (Mode A: naive PostgreSQL)' },
  flash: { id: 'flash-sneaker', name: 'Limited Sneaker (Mode B: Redis reservation)' },
} as const;

export const keys = {
  /** string int: units Redis will still admit. */
  stock: (productId: string) => `flash:{${productId}}:stock`,
  /** hash: status, userId, createdAt, expiresAt, confirmed. */
  reservation: (productId: string, reservationId: string) => `flash:{${productId}}:res:${reservationId}`,
  /** string: the reservation id this user holds (one unit per user). */
  user: (productId: string, userId: string) => `flash:{${productId}}:user:${userId}`,
  /** zset: reservationId -> createdAt ms. Admitted by Redis, not yet confirmed by the worker. */
  pending: (productId: string) => `flash:{${productId}}:pending`,
  /** string: id of the current sale (fencing token, mirrors Product.saleId in PostgreSQL). */
  sale: (productId: string) => `flash:{${productId}}:sale`,
  productPattern: (productId: string) => `flash:{${productId}}:*`,

  config: 'flash:config',
  flashMetrics: 'flash:metrics',
  naiveMetrics: 'naive:metrics',
  // Both event keys share the {events} hash tag because one Lua script touches both.
  events: 'flash:{events}:list',
  eventsSeq: 'flash:{events}:seq',
  simCurrent: 'sim:current',
  simLast: (mode: 'naive' | 'flash') => `sim:last:${mode}`,
};
