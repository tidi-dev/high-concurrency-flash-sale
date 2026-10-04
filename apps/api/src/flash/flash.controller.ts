import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { BuyResponse } from '@flash/shared';
import type { Response } from 'express';
import { intInRange, optionalString } from '../common/http';
import { LifecycleService, PayCode } from './lifecycle.service';
import { ReservationService, SimulatedCrashError } from './reservation.service';

const BUY_STATUS: Record<BuyResponse['status'], number> = {
  RESERVED: HttpStatus.ACCEPTED, // 202: accepted, processing continues asynchronously
  SOLD_OUT: HttpStatus.CONFLICT,
  ALREADY_RESERVED: HttpStatus.CONFLICT,
  NOT_INITIALIZED: HttpStatus.SERVICE_UNAVAILABLE,
  SIMULATED_CRASH: HttpStatus.INTERNAL_SERVER_ERROR,
};

const PAY_STATUS: Record<PayCode, number> = {
  PAID: HttpStatus.OK,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  NOT_PERSISTED: HttpStatus.CONFLICT,
  EXPIRED: HttpStatus.CONFLICT,
  ALREADY_PAID: HttpStatus.CONFLICT,
  INVALID_STATE: HttpStatus.CONFLICT,
};

/** Mode B: Redis reservation + queue + worker. */
@Controller('flash-sale')
export class FlashController {
  constructor(
    private readonly reservations: ReservationService,
    private readonly lifecycle: LifecycleService,
  ) {}

  @Post('buy')
  async buy(@Body() body: { userId?: unknown }, @Res({ passthrough: true }) res: Response): Promise<BuyResponse> {
    let out: BuyResponse;
    try {
      out = await this.reservations.reserve(optionalString(body?.userId, 'userId'));
    } catch (err) {
      if (!(err instanceof SimulatedCrashError)) throw err;
      out = { status: 'SIMULATED_CRASH', reservationId: err.reservationId, message: err.message };
    }
    res.status(BUY_STATUS[out.status]);
    return out;
  }

  @Get('reservations')
  recent(@Query('limit') limit?: string) {
    return this.lifecycle.recent(intInRange(limit, 'limit', 1, 200, 20));
  }

  @Get('reservations/:id')
  async view(@Param('id') id: string) {
    const v = await this.lifecycle.view(id);
    if (!v) throw new NotFoundException('Unknown reservation');
    return v;
  }

  @Post('reservations/:id/pay')
  async pay(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const out = await this.lifecycle.pay(id);
    res.status(PAY_STATUS[out.code]);
    return out;
  }

  /** Demo action: expire now, regardless of expiresAt. */
  @Post('reservations/:id/expire')
  @HttpCode(200)
  expire(@Param('id') id: string) {
    return this.lifecycle.expire(id, { force: true });
  }

  /** Re-run the Redis half of expiry (idempotent). */
  @Post('reservations/:id/release')
  @HttpCode(200)
  async release(@Param('id') id: string) {
    return { outcome: await this.lifecycle.releaseToRedis(id) };
  }

  @Post('expire-due')
  @HttpCode(200)
  sweep() {
    return this.lifecycle.sweep();
  }

  @Post('pay-random')
  @HttpCode(200)
  payRandom(@Body() body: { percent?: unknown }) {
    return this.lifecycle.payRandom(intInRange(body?.percent, 'percent', 0, 100, 50));
  }
}
