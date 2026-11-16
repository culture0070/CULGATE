// An Express app with a payment route and one webhook route per account.
//
// Runs against the in-memory mock provider. For a real gateway:
//
//   import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
//   providers: [paymongo()],
//   accounts: { 'paymongo-primary': paymongoAccountFromEnv() },
//   // needs PAYMONGO_SECRET_KEY and PAYMONGO_WEBHOOK_SECRET

import express from 'express';
import { InMemoryWebhookEventStore, PaymentSDK, PaymentSDKError } from '@culgate/sdk';
import { paymentWebhook } from '@culgate/express';
import { mockProvider } from '@culgate/core/testing';

export const mock = mockProvider();

export const sdk = new PaymentSDK({
  providers: [mock],
  accounts: {
    primary: {
      provider: 'mock',
      secretKey: 'mock-secret-primary',
      webhookSecret: 'mock-webhook-secret-primary',
      environment: 'test',
    },
  },
  // Development only. In production, implement WebhookEventStore on your database.
  webhooks: { eventStore: new InMemoryWebhookEventStore() },
});

/** Orders this demo "fulfilled", keyed by payment ID. */
export const fulfilled = new Map();

// Register webhook handlers once, at startup. Handlers must be idempotent.
sdk.webhooks.on('payment.succeeded', async (event) => {
  // Treat the event as a signal, then read the truth from the provider.
  const payment = await sdk.payments.retrieve({
    account: event.accountId,
    paymentId: event.resourceId,
  });
  if (payment.status === 'succeeded') fulfilled.set(payment.id, payment.reference);
});

export const app = express();

// Webhook routes go BEFORE express.json(), so the raw body is still available
// for signature verification. One route per account.
app.post(
  '/webhooks/primary',
  paymentWebhook(sdk, {
    account: 'primary',
    onResult: (result) => console.log(`webhook: ${result.status}`),
  }),
);

app.use(express.json());

app.post('/orders/:orderId/pay', async (req, res, next) => {
  try {
    const payment = await sdk.payments.create({
      account: 'primary',
      amount: { value: req.body.amount, currency: 'PHP' },
      reference: req.params.orderId,
      returnUrls: { success: 'https://example.com/return' },
      idempotencyKey: `${req.params.orderId}-payment`,
    });
    // Do not send `payment.raw` to the browser; it is the provider's full payload.
    res
      .status(201)
      .json({ id: payment.id, status: payment.status, checkoutUrl: payment.checkoutUrl });
  } catch (error) {
    next(error);
  }
});

// CulGate errors serialize safely: no stack, no cause, no credentials.
app.use((error, _req, res, _next) => {
  if (error instanceof PaymentSDKError) {
    const status = error.name === 'ValidationError' ? 400 : 502;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: 'internal_error' });
});
