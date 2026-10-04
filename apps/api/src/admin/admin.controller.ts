import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import type { DemoConfig, LoadRunResult, Mode, StorySpeed } from '@flash/shared';
import { DemoConfigService } from '../common/demo-config.service';
import { intInRange } from '../common/http';
import { TelemetryService } from '../common/telemetry.service';
import { ReconcileService } from '../flash/reconcile.service';
import { AdminService, ReseedStrategy } from './admin.service';
import { MAX_USERS, SimulationService } from './simulation.service';
import { StateService } from './state.service';
import { StoryService } from './story.service';

@Controller()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly state: StateService,
    private readonly config: DemoConfigService,
    private readonly simulation: SimulationService,
    private readonly reconciler: ReconcileService,
    private readonly telemetry: TelemetryService,
    private readonly story: StoryService,
  ) {}

  /** Story mode: a tiny slowed-down sale for non-technical viewers. Resets the demo. */
  @Post('story')
  @HttpCode(202)
  startStory(@Body() body: { mode?: unknown; shoppers?: unknown; stock?: unknown; speed?: unknown }) {
    if (body?.mode !== 'naive' && body?.mode !== 'flash') throw new BadRequestException('mode must be "naive" or "flash"');
    const speed = (body.speed ?? 'slow') as StorySpeed;
    if (speed !== 'slow' && speed !== 'very-slow') throw new BadRequestException('speed must be slow | very-slow');
    return this.story.start(body.mode as Mode, intInRange(body.shoppers, 'shoppers', 2, 30, 10), intInRange(body.stock, 'stock', 1, 20, 5), speed);
  }

  @Get('health')
  health() {
    return { ok: true };
  }

  @Get('state')
  snapshot() {
    return this.state.snapshot();
  }

  @Get('events')
  events() {
    return this.telemetry.recentEvents(100);
  }

  @Patch('config')
  async updateConfig(@Body() body: Partial<Record<keyof DemoConfig, unknown>>) {
    const next = await this.config.update(body ?? {});
    await this.telemetry.record({ type: 'CONFIG_CHANGED', mode: 'system', detail: Object.keys(body ?? {}).map((k) => `${k}=${String((next as never)[k])}`).join(', ') });
    return next;
  }

  @Post('reset')
  @HttpCode(200)
  async reset(@Body() body: { initialStock?: unknown; resetConfig?: unknown }) {
    if (this.simulation.running) throw new ConflictException('Wait for the running simulation to finish.');
    await this.admin.reset(intInRange(body?.initialStock, 'initialStock', 1, 1_000_000, 500), { resetConfig: body?.resetConfig === true });
    return this.state.snapshot();
  }

  @Post('simulations')
  @HttpCode(202)
  simulate(@Body() body: { mode?: unknown; users?: unknown; concurrency?: unknown }) {
    if (body?.mode !== 'naive' && body?.mode !== 'flash') throw new BadRequestException('mode must be "naive" or "flash"');
    const users = intInRange(body.users, 'users', 1, MAX_USERS, 1000);
    const concurrency = body.concurrency === undefined ? undefined : intInRange(body.concurrency, 'concurrency', 1, 5000);
    return this.simulation.start(body.mode as Mode, users, concurrency);
  }

  /** The CLI load tester posts its result here so the dashboard can show it. */
  @Post('simulations/report')
  @HttpCode(204)
  async report(@Body() body: LoadRunResult) {
    const valid =
      (body?.mode === 'naive' || body?.mode === 'flash') &&
      typeof body.users === 'number' &&
      typeof body.durationMs === 'number' &&
      typeof body.outcomes === 'object' &&
      body.outcomes !== null &&
      ['avg', 'p50', 'p95', 'p99', 'max', 'count'].every((k) => typeof (body.latency as unknown as Record<string, unknown>)?.[k] === 'number');
    if (!valid) throw new BadRequestException('invalid load-test result');
    await this.simulation.report(body);
  }

  @Post('admin/worker/pause')
  @HttpCode(204)
  pause() {
    return this.admin.pauseWorker();
  }

  @Post('admin/worker/resume')
  @HttpCode(204)
  resume() {
    return this.admin.resumeWorker();
  }

  @Post('admin/duplicate-delivery')
  @HttpCode(200)
  duplicate(@Body() body: { count?: unknown }) {
    return this.admin.duplicateDelivery(intInRange(body?.count, 'count', 1, 1000, 10));
  }

  @Post('admin/redis-crash')
  @HttpCode(200)
  redisCrash(@Body() body: { reseed?: unknown }) {
    const reseed = (body?.reseed ?? 'db') as ReseedStrategy;
    if (!['initial', 'db', 'none'].includes(reseed)) throw new BadRequestException('reseed must be initial | db | none');
    return this.admin.simulateRedisDataLoss(reseed);
  }

  @Post('admin/reconcile')
  @HttpCode(200)
  reconcile(@Body() body: { overwriteStock?: unknown; graceMs?: unknown }) {
    return this.reconciler.reconcile({
      overwriteStock: body?.overwriteStock === true,
      graceMs: body?.graceMs === undefined ? undefined : intInRange(body.graceMs, 'graceMs', 0, 3_600_000),
    });
  }
}
