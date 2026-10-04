import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { CommonModule } from './common/common.module';
import { FlashModule } from './flash/flash.module';
import { NaiveModule } from './naive/naive.module';

/** The HTTP API process. */
@Module({ imports: [CommonModule, FlashModule, NaiveModule, AdminModule] })
export class AppModule {}
