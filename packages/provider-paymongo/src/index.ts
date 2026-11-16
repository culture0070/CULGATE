import type { ProviderDefinition } from '@culgate/core';
import { createPayMongoAdapter } from './adapter.js';
import { PAYMONGO_API_BASE_URL } from './client.js';
import type { PayMongoAccountConfig } from './config.js';
import { parsePayMongoConfig, PAYMONGO_PROVIDER_NAME } from './config.js';
import type { PayMongoWebhookOptions } from './webhooks.js';

export { PAYMONGO_OPERATIONS } from './adapter.js';
export { PAYMONGO_API_BASE_URL } from './client.js';
export { PAYMONGO_PROVIDER_NAME } from './config.js';
export type { PayMongoAccountConfig } from './config.js';
export { CHECKOUT_PAYMENT_METHODS as PAYMONGO_CHECKOUT_PAYMENT_METHODS } from './checkout.js';
export { PAYMONGO_SIGNATURE_HEADER } from './webhooks.js';
export type { PayMongoWebhookOptions } from './webhooks.js';
export { PAYMENT_METHODS as PAYMONGO_PAYMENT_METHODS, REFERENCE_METADATA_KEY } from './mappers.js';

export interface PayMongoProviderOptions {
  /**
   * Overrides the API base URL. For tests against a local mock server only:
   * the account's secret key is sent to this URL.
   */
  baseUrl?: string;
  /** Webhook verification options. */
  webhooks?: PayMongoWebhookOptions;
}

/**
 * PayMongo provider for CulGate.
 *
 * ```ts
 * new PaymentSDK({
 *   providers: [paymongo()],
 *   accounts: {
 *     main: { provider: 'paymongo', secretKey: process.env.PAYMONGO_SECRET_KEY!, environment: 'test' },
 *   },
 * });
 * ```
 */
export function paymongo(
  options: PayMongoProviderOptions = {},
): ProviderDefinition<PayMongoAccountConfig> {
  const baseUrl = options.baseUrl ?? PAYMONGO_API_BASE_URL;
  return {
    name: PAYMONGO_PROVIDER_NAME,
    parseConfig: parsePayMongoConfig,
    createAdapter: (context) =>
      createPayMongoAdapter(context, {
        baseUrl,
        ...(options.webhooks && { webhooks: options.webhooks }),
      }),
  };
}

export { paymongoAccountFromEnv } from './env.js';
export type { PayMongoEnvOptions } from './env.js';
