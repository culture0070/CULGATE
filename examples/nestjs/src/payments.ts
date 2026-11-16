import { mockProvider } from '@culgate/core/testing';
import { InMemoryWebhookEventStore } from '@culgate/sdk';

// The in-memory mock provider, so the example needs no credentials.
// For a real gateway:
//
//   import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
//   providers: [paymongo()],
//   accounts: { primary: paymongoAccountFromEnv() },
export const mock = mockProvider();

export const paymentOptions = {
  providers: [mock],
  accounts: {
    primary: {
      provider: 'mock',
      secretKey: 'mock-secret-primary',
      webhookSecret: 'mock-webhook-secret-primary',
      environment: 'test',
    },
  } as const,
  // Development only. In production, implement WebhookEventStore on your database.
  webhooks: { eventStore: new InMemoryWebhookEventStore() },
};
