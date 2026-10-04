import { Body, Controller, HttpStatus, Post, Res } from '@nestjs/common';
import type { NaiveBuyResponse } from '@flash/shared';
import type { Response } from 'express';
import { optionalString } from '../common/http';
import { NaiveService } from './naive.service';

/** Mode A: INTENTIONALLY UNSAFE (in its default variants). Educational only. */
@Controller('naive')
export class NaiveController {
  constructor(private readonly naive: NaiveService) {}

  @Post('buy')
  async buy(@Body() body: { userId?: unknown }, @Res({ passthrough: true }) res: Response): Promise<NaiveBuyResponse> {
    const out = await this.naive.buy(optionalString(body?.userId, 'userId'));
    res.status(out.status === 'ORDER_CREATED' ? HttpStatus.CREATED : HttpStatus.CONFLICT);
    return out;
  }
}
