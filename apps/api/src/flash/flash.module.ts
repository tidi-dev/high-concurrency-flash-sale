import { Module } from '@nestjs/common';
import { FlashController } from './flash.controller';
import { LifecycleService } from './lifecycle.service';
import { PersistenceService } from './persistence.service';
import { ReconcileService } from './reconcile.service';
import { ReservationService } from './reservation.service';
import { WaitlistService } from './waitlist.service';

@Module({
  controllers: [FlashController],
  providers: [ReservationService, PersistenceService, LifecycleService, ReconcileService, WaitlistService],
  exports: [ReservationService, PersistenceService, LifecycleService, ReconcileService, WaitlistService],
})
export class FlashModule {}
