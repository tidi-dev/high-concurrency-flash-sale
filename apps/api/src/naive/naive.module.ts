import { Module } from '@nestjs/common';
import { NaiveController } from './naive.controller';
import { NaiveService } from './naive.service';

@Module({ controllers: [NaiveController], providers: [NaiveService], exports: [NaiveService] })
export class NaiveModule {}
