import { Module } from '@nestjs/common';
import { FlashController } from './flash.controller';
import { LifecycleService } from './lifecycle.service';
import { PersistenceService } from './persistence.service';
import { ReconcileService } from './reconcile.service';
import { ReservationService } from './reservation.service';

@Module({
  controllers: [FlashController],
  providers: [ReservationService, PersistenceService, LifecycleService, ReconcileService],
  exports: [ReservationService, PersistenceService, LifecycleService, ReconcileService],
})
export class FlashModule {}
