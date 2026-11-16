import type { ProviderDefinition } from '@culgate/core';
import { createXenditAdapter } from './adapter.js';
import { XENDIT_API_BASE_URL } from './client.js';
import type { XenditAccountConfig } from './config.js';
import { parseXenditConfig, XENDIT_PROVIDER_NAME } from './config.js';

export { XENDIT_OPERATIONS } from './adapter.js';
export { XENDIT_API_BASE_URL, XENDIT_API_VERSION } from './client.js';
export { XENDIT_PROVIDER_NAME } from './config.js';
export type { XenditAccountConfig } from './config.js';
export { PAYMENT_METHODS as XENDIT_PAYMENT_METHODS } from './mappers.js';
export { CHECKOUT_PAYMENT_METHODS as XENDIT_CHECKOUT_PAYMENT_METHODS } from './checkout.js';
export { XENDIT_CALLBACK_TOKEN_HEADER } from './webhooks.js';

export interface XenditProviderOptions {
  /**
   * Overrides the API base URL. For tests against a local mock server only:
   * the account's secret key is sent to this URL.
   */
  baseUrl?: string;
}

/**
 * Xendit provider for CulGate (Payments API v3).
 *
 * ```ts
 * new PaymentSDK({
 *   providers: [xendit()],
 *   accounts: {
 *     main: { provider: 'xendit', secretKey: process.env.XENDIT_SECRET_KEY!, environment: 'test' },
 *   },
 * });
 * ```
 */
export function xendit(
  options: XenditProviderOptions = {},
): ProviderDefinition<XenditAccountConfig> {
  const baseUrl = options.baseUrl ?? XENDIT_API_BASE_URL;
  return {
    name: XENDIT_PROVIDER_NAME,
    parseConfig: parseXenditConfig,
    createAdapter: (context) => createXenditAdapter(context, { baseUrl }),
  };
}

export { xenditAccountFromEnv } from './env.js';
export type { XenditEnvOptions } from './env.js';
