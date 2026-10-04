import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { LoadRunResult, Mode, SimulationProgress } from '@flash/shared';
import type Redis from 'ioredis';
import { env } from '../common/env';
import { keys } from '../common/keys';
import { REDIS } from '../common/redis';
import { TelemetryService } from '../common/telemetry.service';
import { runLoad } from '../loadgen/run-load';

export const MAX_USERS = 50_000;
// 100 in-flight connections: enough to show every race, and below the macOS listen backlog (kern.ipc.somaxconn = 128),
// above which connection attempts get dropped and retried after 1s, which pollutes p99 with TCP retries.
export const DEFAULT_CONCURRENCY = 100;

/**
 * Runs a load test from inside the API process against its own HTTP endpoint.
 * (Browsers allow only about 6 connections per host, so the dashboard can't generate this load itself.)
 * Caveat: the load generator shares the API's CPU, so latencies are a bit pessimistic.
 * The CLI (`npm run load:*`) runs it in a separate process.
 */
@Injectable()
export class SimulationService {
  private readonly log = new Logger('Simulation');
  private current: SimulationProgress | null = null;
  baseUrl = `http://127.0.0.1:${env.port}`;

  constructor(
    private readonly telemetry: TelemetryService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  get running(): boolean {
    return !!this.current?.running;
  }

  progress(): SimulationProgress | null {
    return this.current;
  }

  start(mode: Mode, users: number, concurrency?: number): SimulationProgress {
    if (this.running) throw new ConflictException('A simulation is already running.');
    const u = Math.max(1, Math.min(MAX_USERS, Math.floor(users)));
    const c = Math.max(1, Math.min(u, Math.floor(concurrency ?? DEFAULT_CONCURRENCY)));
    const runId = `${mode}-${Date.now().toString(36)}`;
    this.current = { runId, mode, users: u, completed: 0, startedAt: Date.now(), running: true };
    void this.run(mode, u, c, runId);
    return this.current;
  }

  private async run(mode: Mode, users: number, concurrency: number, runId: string): Promise<void> {
    await this.telemetry.record({ type: 'SIMULATION_STARTED', mode, detail: `${users} users, ${concurrency} concurrent connections` });
    try {
      const result = await runLoad({
        baseUrl: this.baseUrl,
        mode,
        users,
        concurrency,
        runId,
        onProgress: (completed) => {
          if (this.current?.runId === runId) this.current.completed = completed;
        },
      });
      await this.report(result);
    } catch (err) {
      this.log.error(`simulation failed: ${(err as Error).message}`);
    } finally {
      if (this.current?.runId === runId) this.current.running = false;
    }
  }

  /** Store a finished run (also used by the CLI to show its results on the dashboard). */
  async report(result: LoadRunResult): Promise<void> {
    await this.redis.set(keys.simLast(result.mode), JSON.stringify(result));
    const outcomes = Object.entries(result.outcomes).map(([k, v]) => `${k}=${v}`).join(' ');
    await this.telemetry.record({
      type: 'SIMULATION_FINISHED',
      mode: result.mode,
      detail: `${result.users} requests in ${result.durationMs}ms (p95 ${result.latency.p95}ms): ${outcomes}`,
    });
  }

  async lastRun(mode: Mode): Promise<LoadRunResult | null> {
    const raw = await this.redis.get(keys.simLast(mode));
    return raw ? (JSON.parse(raw) as LoadRunResult) : null;
  }
}
