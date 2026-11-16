# NestJS integration

`@culgate/nestjs` registers one `PaymentSDK` in the NestJS container and adds a small service for
webhook routes. It contains no payment logic.

## Module

```ts
import { Module } from '@nestjs/common';
import { PaymentModule } from '@culgate/nestjs';
import { paymongo } from '@culgate/provider-paymongo';

@Module({
  imports: [
    PaymentModule.forRoot({
      providers: [paymongo()],
      accounts: {
        'paymongo-primary': {
          provider: 'paymongo',
          secretKey: process.env.PAYMONGO_SECRET_KEY!,
          webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET,
          environment: 'test',
        },
      },
    }),
  ],
})
export class AppModule {}
```

With configuration from another provider:

```ts
PaymentModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    providers: [paymongo()],
    accounts: {
      'paymongo-primary': {
        provider: 'paymongo',
        secretKey: config.getOrThrow('PAYMONGO_SECRET_KEY'),
        environment: 'test',
      },
    },
  }),
});
```

Both accept a ready `PaymentSDK` instance instead of options. `forRoot` builds the SDK
immediately, so invalid configuration stops the application at startup. The module is global by
default; pass `{ global: false }` as the second argument (or in the async options) to change that.

## Injection

| Token                    | Use                                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `PaymentSDK` (the class) | `constructor(private readonly payments: PaymentSDK) {}`            |
| `CULGATE_SDK`            | `@Inject(CULGATE_SDK)` or `@InjectPaymentSDK()`, the same instance |
| `PaymentWebhookService`  | Webhook routes                                                     |

Injecting by class needs `emitDecoratorMetadata` (the NestJS default). If your build does not emit
decorator metadata, use `@InjectPaymentSDK()` or `@Inject(PaymentSDK)`.

```ts
@Injectable()
export class OrdersService {
  constructor(private readonly payments: PaymentSDK) {}

  pay(order: Order) {
    return this.payments.payments.create({
      account: 'paymongo-primary',
      amount: { value: order.totalCentavos, currency: 'PHP' },
      paymentMethod: { type: 'gcash' },
      reference: order.id,
      returnUrls: { success: 'https://example.com/orders/return' },
    });
  }
}
```

## Webhooks and the raw body

Signature verification needs the exact bytes the provider sent. Turn on NestJS's raw-body option
when creating the application:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

Then give each account its own route and pass the request to `PaymentWebhookService`:

```ts
import { Controller, Post, Req, Res, type RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PaymentWebhookService } from '@culgate/nestjs';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: PaymentWebhookService) {}

  @Post('paymongo-primary')
  async paymongo(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const result = await this.webhooks.handle('paymongo-primary', req);
    res.status(result.response.status).json(result.response.body);
  }
}
```

Use `@Res()` and send `result.response` yourself, as shown: NestJS would otherwise answer every
`@Post` with `201` and ignore the status the provider needs.

Without `rawBody: true`, `handle` throws a `ConfigurationError` (`raw_body_unavailable`) rather
than verifying a re-serialized body, and no handler runs.

Register event handlers once, for example in a provider's `onModuleInit`:

```ts
this.payments.webhooks.on('payment.succeeded', (event) => this.orders.confirm(event));
```

See the [webhook guide](webhooks.md) for event handling, deduplication, and the event store.

## Module format

The package is ESM. NestJS projects compiled to CommonJS can still load it with `require()` on
Node.js 22.12 or newer.
