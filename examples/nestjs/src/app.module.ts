import {
  Body,
  Controller,
  Module,
  Param,
  Post,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { PaymentModule, PaymentWebhookService } from '@culgate/nestjs';
import type { Request, Response } from 'express';
import { OrdersService } from './orders.service.js';
import { paymentOptions } from './payments.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post(':orderId/pay')
  pay(@Param('orderId') orderId: string, @Body() body: { amount: number }) {
    return this.orders.pay(orderId, body.amount);
  }
}

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  // One route per account. `req.rawBody` exists because the application is
  // created with `{ rawBody: true }` in main.ts.
  @Post('primary')
  async primary(@Req() request: RawBodyRequest<Request>, @Res() response: Response) {
    const result = await this.webhooks.handle('primary', request);
    // Send the status the provider needs; NestJS would otherwise answer 201.
    response.status(result.response.status).json(result.response.body);
  }
}

@Module({
  imports: [PaymentModule.forRoot(paymentOptions)],
  controllers: [OrdersController, WebhooksController],
  providers: [OrdersService],
})
export class AppModule {}
