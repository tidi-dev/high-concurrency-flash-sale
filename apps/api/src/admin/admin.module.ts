import { Module } from '@nestjs/common';
import { FlashModule } from '../flash/flash.module';
import { NaiveModule } from '../naive/naive.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SimulationService } from './simulation.service';
import { StateService } from './state.service';
import { StoryService } from './story.service';
import { StreamController } from './stream.controller';

@Module({
  imports: [FlashModule, NaiveModule],
  controllers: [AdminController, StreamController],
  providers: [AdminService, StateService, SimulationService, StoryService],
  exports: [AdminService, StateService, SimulationService],
})
export class AdminModule {}
