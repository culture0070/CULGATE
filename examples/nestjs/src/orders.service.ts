import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PaymentSDK } from '@culgate/nestjs';

@Injectable()
export class OrdersService implements OnModuleInit {
  /** Orders this demo "fulfilled", keyed by payment ID. */
  readonly fulfilled = new Map<string, string | undefined>();

  // Injected by class; PaymentModule registers the SDK under this token.
  constructor(private readonly sdk: PaymentSDK) {}

  onModuleInit(): void {
    // Register webhook handlers once. Handlers must be idempotent.
    this.sdk.webhooks.on('payment.succeeded', async (event) => {
      // Treat the event as a signal, then read the truth from the provider.
      const payment = await this.sdk.payments.retrieve({
        account: event.accountId,
        paymentId: event.resourceId!,
      });
      if (payment.status === 'succeeded') this.fulfilled.set(payment.id, payment.reference);
    });
  }

  async pay(orderId: string, amount: number) {
    const payment = await this.sdk.payments.create({
      account: 'primary',
      amount: { value: amount, currency: 'PHP' },
      reference: orderId,
      returnUrls: { success: 'https://example.com/return' },
      idempotencyKey: `${orderId}-payment`,
    });
    // Do not return `payment.raw` to clients; it is the provider's full payload.
    return { id: payment.id, status: payment.status, checkoutUrl: payment.checkoutUrl };
  }
}
