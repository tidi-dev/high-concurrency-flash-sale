# Flash-Sale Oversell Demo: Design Spec

Status: written 2026-10-04, before implementation; updated the same day after a code review (see [§14](#14-revisions-after-code-review-2026-10-04)).
Audience: the implementer (me), and you, the learner. The teaching docs in `docs/01..09` expand on it.

## 1. Intent

**What you asked for:** a local, educational demo that shows why a naive PostgreSQL "read stock → check → update" checkout breaks under a flash-sale spike, and how a Redis admission layer plus a queue, reservations with TTLs, and idempotent workers fix it. It also has to show, honestly and by experiment, what Redis atomicity does **not** fix.

**Success criteria:**

- You can run one command, open a dashboard, press "Run Naive Test", and watch PostgreSQL oversell.
- You press "Run Redis Test" and watch admissions stop at exactly the stock, with stock never going below zero (in the default strategy), while the queue drains into PostgreSQL.
- You can break things on purpose (pause the worker, duplicate messages, crash the API between Redis and the queue, lose Redis data) and see which invariant breaks and what repairs it.
- Tests prove the critical invariant under concurrency.
- After reading `docs/`, you can explain *why* each component exists, and give a strong interview answer.

**Assumptions (mine, not stated by you):**

- Single product per mode is enough; one unit per purchase.
- "Concurrent users" in the dashboard means N HTTP requests fired with high concurrency from the API process itself. Browsers cap connections per host at about 6, so the browser cannot generate this load itself.
- Laptop scale: 100 to 10,000 requests per run. A CLI load tool exists for bigger runs.

## 2. Problem analysis (Phase 2 answers)

Short answers. The teaching docs explain each one more slowly.

1. **Naive PG under extreme contention.** Every request needs a DB connection, which is a scarce, pooled resource with typically 10 to 100 per app. 2M requests queue for those connections. Every buyer also targets **one row** (the product), so correct implementations serialize on that row's lock. Throughput collapses to roughly 1 / (lock hold time), latency explodes, timeouts cascade, and the DB, which also serves the rest of the site, goes down with it.
2. **SELECT-then-UPDATE oversells** because "check" and "act" are separate steps. Between my SELECT (stock=1) and my UPDATE, 300 other requests also read stock=1. All of them pass the check. Two flavours:
   - *check-then-act* with `stock = stock - 1`: the stock goes negative (−299).
   - *lost update* with `stock = <value I read> - 1`: the stock looks fine (0), but 300 orders exist. This one is worse because the oversell is hidden.
3. **Correct PG approaches:** a conditional atomic update (`UPDATE product SET stock = stock - 1 WHERE id = $1 AND stock > 0`, then check the row count), `SELECT ... FOR UPDATE` inside a transaction, or SERIALIZABLE isolation with retries. These are all correct, and they all **serialize on one hot row**. Each buyer holds the row lock for the transaction's duration, so throughput is bounded and every request still costs a DB round-trip and a connection. Correct ≠ scalable.
4. **Why Redis as admission layer:** in-memory, about 100k+ simple ops/sec on one core, sub-millisecond, no connection-pool starvation at this scale. It turns away the 99.97% of requests that cannot possibly succeed (2M buyers, 500 units) *before* they touch the DB. Its job is **admission control**, not durable bookkeeping.
5. **Why DECR is atomic:** Redis executes commands one at a time on a single thread (I/O threads in Redis 6+ only parse and write sockets). DECR's read-modify-write happens inside one command, so no other command can interleave. Two clients can never both see "1" and both decrement it to "0".
6. **When Lua is needed:** a single command such as DECR is atomic. A *sequence* of commands is not. You need Lua (or Redis Functions) when the decision depends on a read **and** must update several keys atomically, for example "if stock > 0 and this user has no reservation → decrement, record the reservation, mark the user, add to the pending set". The interview version (`DECR`; if negative `INCR`) is correct for the counter alone, but (a) the stock is visibly negative for a moment, (b) it writes twice on every sold-out request, and (c) a per-user limit or a reservation record can't be added atomically. The demo ships both strategies, switchable.
7. **Why a queue:** it decouples the *rate requests arrive* (spiky, 2M at once) from the *rate the DB can absorb* (steady, a few thousand per second). Only admitted requests (≤ stock) are enqueued. Workers drain at a controlled concurrency. The API responds in milliseconds without waiting on the DB.
8. **Why the DB stays the source of truth:** Redis is (by default) not durable. RDB snapshots lose minutes, AOF `everysec` can lose about 1s, and async replication loses acknowledged writes on failover. Money, orders and legal records need ACID durability, constraints, and audit history. Redis is a **cache of the decision**, and the DB is the **record of the decision**. The worker therefore re-checks stock in PG with a guarded update.
9. **Redis crash:** the stock counter, reservation records and (with BullMQ) **the queue itself** are lost or rolled back. If you re-seed the stock from the *initial* value, Redis re-admits units that are already reserved in PG, and only the DB guard prevents real oversell (those users get REJECTED after being told "reserved"). If you re-seed *from the DB*, you're mostly right, but queued-but-unpersisted reservations are gone: those users were told "reserved" and have nothing.
10. **API crash after Redis reservation, before queue publish:** this is a classic **dual-write** problem. Redis has decremented, no message exists, and the unit is leaked: nobody can buy it, nobody owns it. Plain DECR leaves no trace at all. The Lua strategy records the reservation in a `pending` set atomically with the decrement, so a **reconciler** can find reservations that stayed pending too long with no job, and release them. Production fixes: transactional outbox, making the Redis script itself write the outbox/stream entry (e.g. `XADD` inside the Lua script, so reservation and message are one atomic step), or periodic reconciliation.
11. **Duplicate delivery:** every practical queue is at-least-once: worker crashes after the DB commit but before ack, retries after a timeout, producer retries. Without idempotency you get double orders or double stock decrements. Fix: the reservation ID (generated by the API, carried in the message) is the **primary key**. The worker inserts with `ON CONFLICT DO NOTHING` and performs side effects (stock decrement, order creation) **only if the insert happened, in the same transaction**.
12. **Reservation expiry:** a reservation is a time-boxed hold. Do **not** rely on a Redis key TTL to give stock back: key expiry is silent (nothing INCRs the stock) and keyspace notifications are fire-and-forget. Expiry is driven by the DB (`status = RESERVED AND expires_at < now()`), executed by a sweeper as a **conditional transition** (`UPDATE ... WHERE status = 'RESERVED'`). Only the caller whose update affected one row returns stock. That makes duplicate or concurrent expiry safe. The Redis-side release is a separate idempotent Lua step, tracked with a flag in the DB so a crash between the two steps is retried.
13. **Idempotency** is necessary because retries are the only way to survive failures in distributed systems, and retries create duplicates: client retries, queue redelivery, sweeper re-runs, double-clicks on "Pay". Each operation needs a natural key (reservation ID) and a guarded state transition.
14. **How Redis and PG drift apart:** dual writes with crash windows (API crash, worker crash between DB commit and Redis release), Redis data loss and re-seed, manual edits, bugs in non-idempotent consumers, expiry handled in one store only. Drift shows up as `redisStock − (dbStock − pending − expiredNotYetReleasedToRedis) ≠ 0`.
15. **Production mitigations:** transactional outbox or CDC; Redis persistence (AOF) + replicas + careful failover, or a durable log (Kafka/Redis Streams); idempotency keys everywhere; DB constraints as the final guard; reconciliation jobs with alerts on drift; waiting rooms / rate limits / bot protection at the edge; per-user limits; stock bucketing across shards for hot keys; a local "sold out" flag to skip even Redis; observability on queue lag.

### Oversimplifications in the interview answer that the demo makes observable

| Claim | Reality | How you observe it |
|---|---|---|
| "DECR prevents overselling" | It prevents oversell *of Redis admissions*. Only the DB guard prevents oversell of durable orders. | "Simulate Redis data loss → re-seed from initial" → Redis admits again, worker REJECTS the excess |
| "DECR then INCR if negative" | Correct, but stock is visibly negative for a moment and each sold-out request costs 2 writes | Strategy `decr`: dashboard shows "min Redis stock observed" < 0 and the compensation count |
| "Reserve in Redis, then publish to Kafka" | Dual write. A crash in between leaks stock | "Crash API after reservation" → Redis lower than DB → reconciler releases |
| "Queue → worker writes order" | At-least-once delivery → duplicates | "Duplicate delivery" on, idempotency on/off → conservation invariant holds / breaks |
| "Reservation has a 10-minute TTL" | Redis TTL expiry doesn't return stock | Expiry is DB-driven. Docs explain why `EXPIRE` on the hash isn't enough |
| "Redis handles 2M requests" | One hot key lives on one shard, about 100k ops/s. 2M concurrent connections is an edge/LB problem | Docs: waiting room, bucketing. CLI load test shows the single-node ceiling on a laptop |

## 3. Architecture

```
Browser (dashboard) ──SSE──┐
                           ▼
                    NestJS API (apps/api, role=api)
       Mode A: /api/naive/buy ───────────────► PostgreSQL (Product row)
       Mode B: /api/flash-sale/buy
                │ 1. Lua reserve (atomic)
                ▼
             Redis  ── stock / reservation hash / pending zset / user key
                │ 2. ALLOWED → BullMQ add(jobId = reservationId)   (Redis too)
                ▼
             Worker (same codebase, role=worker, separate process)
                │ 3. Lua confirm (confirmed=1) → PG tx: insert reservation (idempotent),
                │    guarded stock decrement (stock > 0 AND saleId matches), create order PENDING_PAYMENT
                │    → after the commit: ZREM pending (or markRejected for REJECTED / STALE)
                ▼
             PostgreSQL (source of truth)
             Sweeper (in worker, every 1s): expire due reservations → PG tx → Redis release (idempotent)
```

**Process layout:** one NestJS codebase, two entrypoints: `main.ts` (HTTP API + SSE + static dashboard) and `worker.main.ts` (BullMQ worker + expiry sweeper). Running them as separate processes makes the queue boundary real (pausing or slowing the worker doesn't slow the API), while keeping one codebase and one image.

**Queue choice: BullMQ.** It needs no extra infrastructure (it runs on the Redis we already have) and gives job IDs, retries, pause/resume and counts we can show on the dashboard. Kafka would add a broker and topic/partition/consumer-group concepts without changing what the demo teaches. The demo's lessons (at-least-once, idempotency, dual-write) apply to both. `docs/04-queue.md` maps the concepts (job ↔ record, queue ↔ topic, worker concurrency ↔ partitions × consumers, jobId dedupe ↔ idempotent producer (partial), retention ↔ log retention) and covers the big difference: Kafka is a durable replicated log, while BullMQ shares Redis's durability fate, so a Redis crash loses inventory **and** queue together.

**Frontend:** Vite + React + TypeScript, a single page. In dev it's served by Vite with `/api` proxied; in Docker, the API serves the built files.

**Load generation:** a custom Node module (`undici`), shared by the dashboard "Run Test" endpoint and the CLI (`npm run load:*`). It records per-request latency and reports avg/p95/p99. We use a custom tool rather than k6 because it needs no extra install, it can generate unique user IDs, and the dashboard can drive it.

## 4. Data model (Prisma / PostgreSQL)

```
Product      id (text PK), name, initialStock, stock (available units),
             saleId (fencing token of the current sale, default ''), createdAt, updatedAt
Reservation  id (text PK = reservationId from the API, the idempotency key),
             productId, userId, status RESERVED|PAID|EXPIRED|REJECTED, rejectReason?,
             expiresAt, paidAt?, expiredAt?, redisReleasedAt?, createdAt, updatedAt
             index (status, expiresAt), index (productId, status)
Order        id (uuid PK), productId, reservationId? UNIQUE, userId,
             source NAIVE|FLASH, status PENDING_PAYMENT|PAID|CANCELLED, createdAt, updatedAt
```

- `Product.stock` = units neither reserved nor sold. Conservation invariant (Mode B): `stock + count(RESERVED) + count(PAID) = initialStock`.
- `Reservation.id` as the PK, with no generated id, makes duplicate messages collide.
- `Order.reservationId UNIQUE` means at most one order per reservation, even if the "create order" code ran twice.
- `Product.saleId` is a **fencing token**: a new random id on every reset and simulated Redis data loss, mirrored in Redis (`flash:{flash-sneaker}:sale`). Queue messages carry the saleId they were admitted under; the worker's guarded update requires it to match, so a message from an older sale can't write into the current one. (Migration `sale_fencing_token`.)
- `redisReleasedAt` tracks the second half of the expiry dual-write (DB first, Redis second) so the sweeper retries the Redis release after a crash.
- Two product rows: `naive-sneaker` (Mode A) and `flash-sneaker` (Mode B), so the modes never interfere.
- No partial unique index for "one active reservation per user": Prisma can't express it without raw SQL, and the per-user rule is enforced in Redis. Documented as a production gap.

## 5. Redis keys

`{...}` in the key is a **Redis Cluster hash tag**: all keys of one product land on the same slot, which multi-key Lua scripts require.

| Key | Type | Value | TTL | Lifecycle |
|---|---|---|---|---|
| `flash:{flash-sneaker}:stock` | string int | units Redis will still admit | none | seeded on reset, DECR on reserve, INCR on release |
| `flash:{flash-sneaker}:res:<rid>` | hash | status, userId, createdAt, expiresAt, confirmed, saleId | none while RESERVED; 1h after terminal state | created by reserve script; `confirmed=1` by worker; status → EXPIRED / PAID / ORPHAN_RELEASED / REJECTED |
| `flash:{flash-sneaker}:user:<uid>` | string | rid | none | set on reserve (per-user limit, Lua strategy); deleted when the reservation is released or rejected by the worker (only if it still points at that rid) |
| `flash:{flash-sneaker}:pending` | zset | rid → createdAt ms | none | added on reserve; removed only **after** the worker's PG commit (CREATED / DUPLICATE), by `markRejected` (REJECTED / STALE), or on orphan release / expiry release. "Admitted but not yet persisted" |
| `flash:{flash-sneaker}:sale` | string | current sale id (fencing token) | none | new random id on reset and simulated Redis data loss; mirrors `Product.saleId` |
| `flash:config` | hash | demo knobs | none | dashboard writes, api/worker read |
| `flash:metrics`, `naive:metrics` | hash | counters | none | HINCRBY; observability only, not truth |
| `flash:{events}:list` / `flash:{events}:seq` | list / int | last 200 JSON events | none | one Lua script: INCR seq + LPUSH + LTRIM (shared `{events}` hash tag, so it is Cluster-safe) |
| `sim:last:<mode>`, `sim:current` | string JSON | load-run results / progress | none | written by load runner |
| `bull:reservations:*` | BullMQ | queue internals | — | managed by BullMQ |

TTL principle: **TTLs are for garbage collection, never for business logic.**

## 6. Reservation state machine

```
(Redis admission) ──► RESERVED ──pay (before expiresAt)──► PAID          order: PENDING_PAYMENT → PAID
                        │
                        ├──expire (sweeper / forced)────► EXPIRED ──► stock returned (DB tx), then Redis INCR (idempotent)
                        │                                              order → CANCELLED
(worker DB guard fails) └──────────────────────────────► REJECTED     (no order, no stock change; Redis hash → REJECTED, no INCR)
Redis-only: RESERVED ──reconciler (unconfirmed, no job, older than grace)──► ORPHAN_RELEASED (Redis INCR)
Redis-only: RESERVED ──worker, message from an older sale (saleId mismatch, PG tx rolled back)──► REJECTED (no INCR)
```

Every transition is a conditional update (`WHERE status = 'RESERVED'`). Pay and expire racing on the same reservation means exactly one wins (PostgreSQL row lock + re-check under READ COMMITTED).

## 7. Flows

**Reserve (Lua strategy, default)**: one script (5 KEYS: stock, reservation hash, user key, pending, sale) that atomically does: stock missing → `NOT_INITIALIZED`; user already holds one → `ALREADY_RESERVED` (returns the held reservation id); stock ≤ 0 → `SOLD_OUT`; else read the sale id, DECR, HSET reservation (incl. `saleId`), SET user key, ZADD pending → `ALLOWED`. It always returns `{result, remaining, saleId, existingReservationId}`. The API then enqueues `{reservationId, productId, userId, createdAtMs, expiresAtMs, saleId}` with `jobId = reservationId` and answers 202: *"Reserved for 30 seconds. Complete payment before the reservation expires."* `ALREADY_RESERVED` answers `409 { status: 'ALREADY_RESERVED', reservationId: <the one you hold>, ... }`, so a client whose first response was lost can still pay.

**Reserve (decr strategy, the interview version)**: `DECR`; if < 0, `INCR` → SOLD_OUT; else a separate HSET + ZADD (not atomic with the DECR). No per-user limit. Records the min value seen and the compensation count.

**Worker persist**: optional delay (slow-worker knob) → Lua `confirm` (only sets `confirmed=1`, returns OK; `ORPHAN_RELEASED` → returns RELEASED, persist as REJECTED; missing hash → MISSING, proceed and let the DB guard decide; the reservation **stays in `pending`**) → PG transaction:
`createMany(skipDuplicates)` reservation → 0 rows means duplicate (`DUPLICATE_MESSAGE_IGNORED`) → else `updateMany(id, saleId = job.saleId, stock > 0, decrement)` → 0 rows: if the product's saleId differs, throw so the insert rolls back too → `STALE` (`STALE_MESSAGE_DROPPED`); otherwise REJECTED (DB has no stock: drift) → else create order PENDING_PAYMENT (`ORDER_CREATED`).
After the transaction: CREATED / DUPLICATE → `clearPending` (ZREM pending); REJECTED / STALE → Lua `markRejected` (ZREM pending; HSET status=REJECTED only if the hash exists; DEL the user key if it still points at this rid; EXPIRE 1h; **no INCR**, because PG never had that unit).
Retries: BullMQ `attempts: 8`, exponential backoff from 500 ms (0.5 s … 64 s, ≈ 2 min in total).
The **broken** idempotency mode (after the same saleId check) decrements stock *before*, outside the transaction, so duplicates double-decrement even though the rows dedupe. That's the classic "the unique constraint didn't cover the side effect" bug.

**Pay**: PG tx `updateMany(id, RESERVED, expiresAt > now) → PAID`; order → PAID. Then a best-effort Redis `markPaid` (errors swallowed: PG already committed). 0 rows → `PAYMENT_REJECTED` and an explanation: no PG row and Redis hash status RESERVED → `409 NOT_PERSISTED` (retry later); no PG row and another Redis status (ORPHAN_RELEASED, REJECTED, …) → `409 INVALID_STATE`; no row and no hash → `404 NOT_FOUND`; otherwise `409 ALREADY_PAID / EXPIRED / INVALID_STATE` from the row.

**Expire**: PG tx `updateMany(id, RESERVED, [expiresAt < now unless forced]) → EXPIRED`; if 1 row: stock + 1, order → CANCELLED (`RESERVATION_EXPIRED`). Then the Redis `release` script (status RESERVED → EXPIRED, INCR stock, DEL user key, ZREM pending; idempotent) (`STOCK_RELEASED`), then set `redisReleasedAt`. The sweeper also retries rows with `status = EXPIRED AND redisReleasedAt IS NULL`.

**Reconcile**: (1) for `pending` entries older than the grace period (5s) with no live BullMQ job (waiting / active / delayed / prioritized) and no DB row → Lua `releaseOrphan`: not confirmed → release the unit (`ORPHAN_RELEASED`); confirmed (returns `CONFIRMED`) → **re-drive**: re-publish the message built from the Redis hash with job id `<rid>-redrive-<timestamp>` (`REDRIVEN`, metric `redriven`; safe because the worker is idempotent). (2) Report drift = `redisStock − (dbStock − pending − expiredNotYetReleasedToRedis)`. (3) Optionally overwrite the Redis stock from the DB (`dbStock − expiredNotYetReleasedToRedis`), refused unless the queue and `pending` are empty (documented race: only safe while sales are paused). The report includes `orphansReleased`, `skippedInQueue`, `redriven`, drift before/after.

**Reset**: new random saleId → pause the queue, wait up to 10 s for active jobs, obliterate it → wipe keys → PG tx (delete orders and reservations, upsert products with the new saleId; retried on deadlock 40P01) → SET Redis stock and sale key → always resume the queue (`try/finally`). A straggler message from the old sale is fenced out by the saleId. Simulated Redis data loss also rotates the saleId in both stores.

**Naive buy (Mode A)**, variant knob:
- `check-then-act` (default): findUnique → if stock > 0 → sleep(delay) → `stock: {decrement: 1}` → create order. Stock goes negative.
- `lost-update`: same but `stock: read.stock - 1`. Stock looks plausible, orders > initial.
- `atomic`: tx { `updateMany(stock > 0, decrement)`; create order }. Never oversells; shows the latency cost of row contention.
Tracks requests / success / soldOut / errors / dbQueries / the race-window gauge (requests between read and write) and its peak.

## 8. Demo knobs (`flash:config`)

`PATCH /config` validates every field (invalid values → 400) and HSETs **only** the patched fields, so two dashboards changing different knobs don't overwrite each other.

`reserveStrategy` lua|decr · `reservationTtlSec` (30) · `naiveVariant` · `naiveDelayMs` (UI slider 0–100, API accepts 0–5000, default 20) · `workerDelayMs` (slow worker) · `workerConcurrency` (1–64, default 16; "how many clerks", applied live by the worker via BullMQ's runtime `concurrency` setter) · `workerIdempotency` transactional|broken · `duplicateDelivery` (API enqueues every job twice under different job IDs) · `crashAfterReservePercent` (0–100) · worker pause = BullMQ `queue.pause()`.

Failure actions: pause/resume worker · re-enqueue the last N jobs as duplicates · simulate Redis data loss (wipe `flash:*` + obliterate the queue, re-seed from `initial` or `db`) · reconcile · expire due now · pay X% of active reservations · force-expire / pay a specific reservation.

## 9. API (global prefix `/api`)

`GET /state` · `GET /stream` (SSE: `state` every 500ms + new `events`) · `POST /reset {initialStock}` · `PATCH /config` · `POST /simulations {mode, users, concurrency?}` · `POST /naive/buy {userId}` · `POST /flash-sale/buy {userId}` · `GET /flash-sale/reservations?limit` · `GET /flash-sale/reservations/:id` (Redis + DB view) · `POST /flash-sale/reservations/:id/pay|expire|release` · `POST /flash-sale/expire-due` · `POST /flash-sale/pay-random {percent}` · `POST /admin/worker/pause|resume` · `POST /admin/duplicate-delivery {count}` · `POST /admin/redis-crash {reseed}` · `POST /admin/reconcile {overwriteStock?}` · `POST /story {mode, shoppers, stock, speed}` (story mode, see §15)

## 10. Observability

Structured JSON log line per event (`{"ts","event","mode","reservationId","userId",...}`) on stdout, plus LPUSH to `flash:{events}:list` for the dashboard event stream. Events: RESERVATION_ALLOWED, SOLD_OUT, NOT_INITIALIZED, ALREADY_RESERVED, ORDER_QUEUED, ENQUEUE_FAILED (simulated crash), ORDER_CREATED, RESERVATION_REJECTED, STALE_MESSAGE_DROPPED, REDRIVEN, DUPLICATE_MESSAGE_IGNORED, PAYMENT_COMPLETED, PAYMENT_REJECTED, RESERVATION_EXPIRED, STOCK_RELEASED, STOCK_RELEASE_SKIPPED (Redis had no record: Redis may disagree with PG, check drift and rebuild Redis stock from the DB while idle), ORPHAN_RELEASED, NAIVE_STOCK_READ, NAIVE_ORDER_CREATED, NAIVE_SOLD_OUT, WORKER_PICKED, STORY_STARTED, STORY_FINISHED, DEMO_RESET, CONFIG_CHANGED, WORKER_PAUSED, WORKER_RESUMED, REDIS_DATA_LOST, RECONCILED, SIMULATION_STARTED, SIMULATION_FINISHED. RESERVATION_CONFIRMED is only a counter (`confirmed` metric), not an emitted event.

The state snapshot includes the current `saleId`; the SSE stream and the dashboard reset their event list when it changes. The worker pipeline shows "stale (old sale) fenced out" and "re-driven by reconciler" counters when non-zero, and the reconcile toast reports the re-driven count. SSE rather than WebSocket: the data flows one way, the server needs no extra library, and the browser reconnects on its own.

The dashboard separates **counters** (Redis HINCRBY, approximate, can drift) from **facts** (DB counts, Redis stock), and shows an **invariants panel**:
- Mode B: Redis stock ≥ 0 (now; min observed) · RESERVED + PAID ≤ initial · DB stock ≥ 0 · stock + RESERVED + PAID = initial (conservation) · orders(non-cancelled) = RESERVED + PAID · every admitted reservation has a queue message (`pending ≤ waiting + active + delayed`; its detail notes that duplicate delivery doubles the message count and can hide orphans) · drift = 0 when idle (when reconcile alone can't fix it, the detail points to "overwrite Redis stock from DB").
- Mode A: orders ≤ initial (oversold = orders − initial) · stock ≥ 0 · stock + orders = initial.

## 11. Testing strategy

- **Unit (no infra):** state-machine transition table, latency statistics, key builders, config parsing.
- **Script tests (need Redis):** reserve / sold out / per-user / not-initialized; confirm; release idempotency; orphan release refuses confirmed reservations. These run against real Redis, because a Redis mock would test the mock and not the Lua.
- **Integration (Redis + PostgreSQL, Nest app):** successful reservation via HTTP; sold out; **critical invariant** (stock 500, 2,000 concurrent reserves → allowed ≤ 500, Redis stock ≥ 0, after the worker drains: paid + active ≤ 500 and conservation holds) for both strategies; duplicate messages ignored (transactional) and the broken mode shown violating conservation; double concurrent expiry returns stock exactly once; pay vs expire race; crash-after-reserve leaks then reconcile restores; a confirmed reservation whose job died stays pending and is re-driven by reconcile; a message from before a reset is fenced out as STALE; naive check-then-act **demonstrably oversells**; naive atomic never oversells.
- **Story mode:** Shop A (naive, slowed) really oversells (8 orders for 4 units); Shop B really sells exactly the stock; pacing knobs are restored afterwards.
- Tests use database `flashsale_test`, Redis DB 1, and their own queue name.

## 12. Safe enough for this demo vs. needed in production

| Area | Demo | Production |
|---|---|---|
| Redis durability | default persistence, single node | AOF + replicas + tested failover; or treat Redis as rebuildable and re-seed from the DB with sales paused |
| Queue | BullMQ on the same Redis | durable log (Kafka / Redis Streams with AOF) or an outbox table + relay |
| API → queue dual write | reconciler with grace period + confirm handshake; pending cleared only after the DB commit; confirmed-but-dead jobs re-driven | outbox, or one atomic script that reserves and appends to a stream |
| Stale work after reset / rebuild | `saleId` fencing token in the guarded update | same pattern (epochs / fencing tokens) |
| Per-user limit | Redis key only | plus a DB partial unique index; identity/bot checks |
| Hot key | one counter key | stock buckets across shards, local sold-out flag, waiting room |
| Reconciler overwrite | manual button, racy | only under sale pause, with fencing/versioning, plus alerts |
| Auth, payments, fraud | none | obviously |

## 13. Out of scope (YAGNI)

Multiple products in one sale, carts, real payments, auth, Kubernetes, Kafka, event sourcing/CQRS, horizontal scaling of the API, and a dashboard-driven chaos framework beyond the listed buttons.

## 14. Revisions after code review (2026-10-04)

A review of the first implementation found two real gaps and several smaller issues. What changed, and why:

1. **Confirm no longer removes from `pending`.** `CONFIRM_LUA` takes only the reservation hash and only sets `confirmed=1` (returns OK / RELEASED / MISSING). The worker removes the reservation from `pending` after the PG commit (`clearPending` for CREATED / DUPLICATE) or via the new `MARK_REJECTED_LUA` (REJECTED / STALE: ZREM, status REJECTED only if the hash exists, free the user key, EXPIRE 1h, no INCR). *Why:* a job that confirmed and then failed all its retries used to leak a unit that neither the orphan invariant nor the reconciler could see (it only showed up as negative drift).
2. **The reconciler re-drives.** A pending entry past the grace period with no live job and no DB row that the worker *did* confirm is re-published from the Redis hash (`<rid>-redrive-<timestamp>`, event `REDRIVEN`, metric `redriven`, `redriven` in the report) instead of being left alone. *Why:* closes gap 1; safe because the worker is idempotent.
3. **Longer retry budget:** `attempts: 8`, exponential backoff `delay: 500` (≈ 2 min total; was 5 attempts from 200 ms, ≈ 3 s). *Why:* a PostgreSQL restart of a few seconds shouldn't turn jobs into permanent failures.
4. **Fencing token `saleId`.** New `Product.saleId` (migration `sale_fencing_token`) mirrored in `flash:{flash-sneaker}:sale`; rotated on reset and simulated Redis data loss; stored in the reservation hash, carried in the job, and required by the worker's guarded update. Mismatch → transaction rolled back → `STALE` (`STALE_MESSAGE_DROPPED`, metric `staleDropped`). *Why:* a buy in flight during a reset, or a job still running when reset gave up waiting, could write into the fresh sale. This is the general fencing-token pattern (Kafka/ZooKeeper epochs, lease fencing).
5. **`ALREADY_RESERVED` returns the held reservation id** (reserve Lua has 5 KEYS and returns `{result, remaining, saleId, existingReservationId}`). *Why:* response-level idempotency for client retries: a client whose first response was lost can still pay.
6. **Event keys renamed** to `flash:{events}:list` / `flash:{events}:seq`. *Why:* the push-event Lua script touches both keys, so they need a shared hash tag to be Redis-Cluster-safe.
7. **`NOT_INITIALIZED` is its own event** (it was logged as SOLD_OUT); `RESERVATION_CONFIRMED` is a counter only.
8. **Pay:** the Redis `markPaid` step is best-effort after the PG commit; refusals without a DB row distinguish `NOT_PERSISTED` (Redis RESERVED, retry), `INVALID_STATE` (other Redis status) and `404 NOT_FOUND` (no hash). *Why:* a Redis hiccup must not turn a completed payment into a 500, and "retry" is only good advice if a retry can succeed.
9. **Clearer repair hints:** `STOCK_RELEASE_SKIPPED` and the drift invariant now point to "rebuild / overwrite Redis stock from the DB while idle"; the orphan invariant notes that duplicate delivery can hide orphans.
10. **`PATCH /config` validates and writes only the patched fields.** *Why:* invalid values silently reset to defaults, and a full-hash rewrite lost concurrent edits (a lost update, the very bug the demo teaches).
11. **Reset is exception-safe** (queue always resumed in `finally`) and retries on PG deadlock (40P01). **docker-compose:** `api` and `worker` have `restart: unless-stopped` (a dead worker is silent: requests still get 202).
12. **Dashboard:** snapshot includes `saleId`; SSE and the event list reset when the sale changes; the pipeline shows "stale (old sale) fenced out" and "re-driven by reconciler" when non-zero; the reconcile toast reports the re-driven count.

## 15. Story mode (added after user feedback, 2026-10-04)

Feedback: a real run finishes in about a second, too fast to follow, and the Lab dashboard is too technical for non-engineers.

Design: the dashboard has two tabs. **🎬 Story mode** is the default and **🔬 Lab** holds the existing technical dashboard. Story mode runs a *tiny, slowed-down, real* sale through the same code paths (`POST /api/story`, `StoryService`):
- **Shop A** (naive): about 10 shoppers, 5 sneakers, `naiveDelayMs` = 2.5 s (4.5 s at "very slow") between "look at the shelf" and "write the order". Every shopper visibly reads the same stock before anyone writes, then the shelf count goes negative.
- **Shop B** (Redis + queue): shoppers arrive about 350 ms apart, and the worker runs with `workerConcurrency = 1` and `workerDelayMs` = 900 ms. The ticket desk answers instantly while one clerk works through the waiting line.
- Pacing knobs are restored when the story ends. Starting a story resets the demo data.
- The UI animates shopper avatars between zones, driven by per-shopper events (`NAIVE_STOCK_READ`, `NAIVE_ORDER_CREATED`, `RESERVATION_ALLOWED`, `SOLD_OUT`, `ORDER_QUEUED`, `WORKER_PICKED`, `ORDER_CREATED`) streamed over SSE. A narration bar explains each phase in plain language, and a collapsible legend maps the metaphors to the tech: shelf = DB row, ticket desk = Redis, waiting line = queue, clerk = worker, order book = PostgreSQL.
