# Flash-Sale Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable local demo that compares a naive PostgreSQL checkout (it oversells) with a Redis-admission + BullMQ + idempotent-worker architecture (it doesn't), with failure injection and a learning dashboard.

**Architecture:** One NestJS codebase with two processes (API, worker), plus PostgreSQL via Prisma, and Redis for the stock counter, Lua scripts and BullMQ. A Vite/React dashboard streams state over SSE. See the spec.

**Tech Stack:** Node 22, TypeScript 5.9, NestJS 12, Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`), ioredis, BullMQ 6, Jest 30 + ts-jest, React 19 + Vite, Docker Compose (postgres:17, redis:8).

**Spec:** `docs/superpowers/specs/2026-10-04-flash-sale-demo-design.md`

**Execution mode:** Native, meaning the main session implements everything, TDD per task, and a fresh code-review subagent checks the whole tree at the end. The teaching docs are delegated to a subagent once the code is stable. This deviates from the skill template in one way: the steps name files, interfaces and test cases rather than containing complete code, because the same session that wrote the spec also executes the plan.

## Global Constraints

- TypeScript `typescript@~5.9` (ts-jest supports `<7`; TS 7 is the new native compiler and is too new for this toolchain).
- All HTTP routes live under the global prefix `/api`.
- Product IDs: `naive-sneaker` (Mode A), `flash-sneaker` (Mode B). Default initial stock 500. Default TTL 30s.
- Redis key names exactly as in spec §5.
- Integration tests use `flashsale_test`, Redis DB 1, and queue name `reservations-test`.
- Each naive endpoint is marked "INTENTIONALLY UNSAFE" in its code and docs.

## Review Focus

1. Concurrent pay + expire on the same reservation: exactly one wins, and the stock is returned only if expire wins.
2. Expiry run twice (two sweepers, or button + sweeper): stock incremented once, in both the DB and Redis.
3. Duplicate job delivered after the first one completed (BullMQ jobId dedupe no longer applies): no second order, no second decrement.
4. Redis wiped while reservations exist in the DB: the worker's DB guard rejects anything over the DB's stock, so durable oversell never happens.
5. Reset while a load run or worker jobs are in flight: the reset must pause and obliterate the queue first, so stale jobs don't write into the fresh dataset.

## Project structure

```
package.json                 npm workspaces + root scripts
docker-compose.yml           postgres, redis, api, worker
Dockerfile                   one image for api/worker (+ built web)
apps/api/
  prisma/schema.prisma, migrations/
  prisma.config.ts
  src/
    main.ts                  HTTP API entry (role=api)
    worker.main.ts           worker entry (role=worker)
    app.module.ts / worker.module.ts
    common/  config.ts (env), demo-config.service.ts (flash:config), keys.ts, events.service.ts, metrics.service.ts, prisma.service.ts, redis.provider.ts, queue.ts
    flash/   redis-scripts.ts (Lua), reservation.service.ts (Redis side), flash.controller.ts,
             persistence.service.ts (worker DB logic), lifecycle.service.ts (pay/expire/sweep),
             reservation-state.ts (pure state machine), reconcile.service.ts, worker.processor.ts
    naive/   naive.service.ts, naive.controller.ts
    admin/   admin.controller.ts, state.service.ts (snapshot), stream.controller.ts (SSE), simulation.service.ts
    loadgen/ run-load.ts, stats.ts
  scripts/   load.ts (CLI), reset.ts
  test/      jest setup, *.int-spec.ts
apps/web/    Vite React dashboard
packages/shared/  types-only contracts (StateSnapshot, DemoConfig, events)
docs/        01..09 teaching docs, superpowers/ spec + plan + setup notes
```

## Tasks

### Task 1: Workspace + infra
- [ ] Root `package.json` (workspaces `apps/*`, `packages/*`), `docker-compose.yml` with postgres + redis (healthchecks), `.env.example`.
- [ ] `apps/api` Nest skeleton, `tsconfig`, jest config with two projects (`unit`: `src/**/*.spec.ts`, `integration`: `test/**/*.int-spec.ts`, runInBand).
- [ ] Prisma schema (spec §4), `prisma.config.ts`, first migration. Verify: `docker compose up -d postgres redis && npm run db:migrate` exits 0.

### Task 2: Pure units (TDD)
- [ ] `reservation-state.ts`: `canTransition(from, to)` and the transition table. Tests: every allowed/forbidden pair.
- [ ] `loadgen/stats.ts`: `summarize(latenciesMs[]) → {count, avg, p50, p95, p99, max}`. Tests: empty, single value, known percentiles.
- [ ] `keys.ts`: key builders. Test: hash-tag format.
- [ ] `demo-config`: `parseDemoConfig(hash) → DemoConfig` with defaults and clamping. Tests.

### Task 3: Redis scripts (TDD against real Redis)
- [ ] `redis-scripts.ts`: `reserve`, `confirm`, `release`, `releaseOrphan`, defined via `defineCommand`.
- [ ] Tests in `src/flash/redis-scripts.spec.ts` (need Redis): allowed + all keys written; sold out leaves stock at 0; already reserved; not initialized; 1,000 parallel reserves against stock 100 → exactly 100 allowed, stock 0; release twice → INCR once; release after PAID → no-op; releaseOrphan refuses confirmed; confirm after orphan release → `RELEASED`.

### Task 4: Mode B request path
- [ ] `ReservationService.reserve(userId)` covering both strategies, metrics/events, enqueue with `jobId = rid`, duplicateDelivery, crashAfterReservePercent.
- [ ] `POST /api/flash-sale/buy` → 202 RESERVED / 409 SOLD_OUT / 409 ALREADY_RESERVED / 500 SIMULATED_CRASH.
- [ ] Integration tests: successful reservation (202 + Redis hash + job exists); sold out (stock 1, two buys).

### Task 5: Worker persistence (idempotent)
- [ ] `PersistenceService.persist(job)` (spec §7) with transactional and broken modes; `worker.processor.ts` wiring; slow-worker delay.
- [ ] Integration tests: persist creates reservation + order and decrements stock; the same message twice → one row, one decrement, a DUPLICATE event; broken mode twice → stock double-decremented (conservation violated, and the test asserts that this happens); DB stock 0 → REJECTED.

### Task 6: Lifecycle (pay / expire / sweep / release)
- [ ] `LifecycleService.pay`, `.expire(id, {force})`, `.sweep()`, `.releaseToRedis(id)`; endpoints.
- [ ] Integration tests: expiry restores stock (DB + Redis); two concurrent expires → +1 once; pay vs expire race 20× → exactly one winner each time and conservation holds; pay after expiry → 409; pay before persisted → 409 NOT_PERSISTED.

### Task 7: Critical invariant
- [ ] `test/invariant.int-spec.ts`: stock 500, N = 2,000 concurrent `reserve()` for each strategy → allowed ≤ 500 (exactly 500), final Redis stock ≥ 0 (= 0), drain the worker, pay a random subset → paid + RESERVED ≤ 500, conservation holds, orders unique per reservation.

### Task 8: Mode A naive
- [ ] `NaiveService.buy` with 3 variants, race-window gauge, dbQueries counter; endpoint.
- [ ] Integration tests: check-then-act with stock 50, 300 concurrent, delay 20ms → orders > 50 and stock < 0 (the test asserts the bug); lost-update → orders > 50, stock ≥ 0, stock + orders ≠ initial; atomic → orders = 50 exactly, stock 0.

### Task 9: Admin, state, SSE, simulation, reconcile, Redis crash
- [ ] `StateService.snapshot()`, SSE stream, reset (pause queue → obliterate → wipe keys → truncate tables → seed → resume), config PATCH, simulations via loadgen, duplicate delivery, Redis crash + reseed, reconcile.
- [ ] Integration tests: crash-after-reserve 100% → Redis 499 / DB 500 / pending 1 → reconcile (grace 0 in test) → Redis 500; Redis crash reseed `initial` with 10 persisted → 20 more admitted on stock 20 → worker rejects 10 → DB never negative.

### Task 10: Load CLI + scripts
- [ ] `scripts/load.ts --mode naive|flash --users --concurrency --url`, `scripts/reset.ts`. Root scripts `load:naive`, `load:redis`, `reset`.
- [ ] Verify against the running dev stack.

### Task 11: Dashboard
- [ ] Vite React app: controls, product/stock cards, pipelines (A and B) with live counters, metrics grid, latency, invariants panel, failure lab, try-it-yourself reservation, recent reservations, event stream.
- [ ] Verify in a browser: naive run shows oversell; redis run shows 500 allowed.

### Task 12: Docker all-in-one
- [ ] `Dockerfile`, compose `api` + `worker` services, API serves `web/dist`. Verify `docker compose up --build` and a load run.

### Task 13: Docs + README
- [ ] `docs/01..09`, README sections per prompt Phase 14, `docs/superpowers/SETUP.md`.

### Task 14: Final verification + review
- [ ] Fresh `npm test`, `npm run test:integration`, load runs. Code-review subagent; fix findings; final report.
