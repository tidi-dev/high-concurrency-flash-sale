import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { FlashModule } from './flash/flash.module';
import { WorkerRunner } from './flash/worker.runner';

@Module({ imports: [FlashModule], providers: [WorkerRunner], exports: [WorkerRunner] })
export class WorkerRunnerModule {}

/** The worker process: no HTTP server, just the queue consumer and the expiry sweeper. */
@Module({ imports: [CommonModule, WorkerRunnerModule] })
export class WorkerModule {}
