import type { AccountEnvOptions } from '@culgate/core';
import { createEnvReader, defaultEnv } from '@culgate/core';
import type { PayMongoAccountConfig } from './config.js';
import { PAYMONGO_PROVIDER_NAME } from './config.js';

export interface PayMongoEnvOptions extends AccountEnvOptions {
  /** Explicit values. These take precedence over environment variables. */
  overrides?: Partial<Omit<PayMongoAccountConfig, 'provider'>>;
}

/**
 * Builds a PayMongo account config from environment variables. With the
 * default prefix `PAYMONGO` it reads:
 *
 * - `PAYMONGO_SECRET_KEY` (required)
 * - `PAYMONGO_WEBHOOK_SECRET` (optional)
 * - `PAYMONGO_ENVIRONMENT` (`test` or `live`; inferred from the key prefix when unset)
 * - `PAYMONGO_TIMEOUT_MS` (optional)
 */
export function paymongoAccountFromEnv(options: PayMongoEnvOptions = {}): PayMongoAccountConfig {
  const reader = createEnvReader(options.env ?? defaultEnv(), options.prefix ?? 'PAYMONGO');
  const { overrides = {} } = options;

  const secretKey = overrides.secretKey ?? reader.required('SECRET_KEY');
  const webhookSecret = overrides.webhookSecret ?? reader.optional('WEBHOOK_SECRET');
  const timeoutMs = overrides.timeoutMs ?? reader.integer('TIMEOUT_MS');
  const environment =
    overrides.environment ??
    reader.environment() ??
    // PayMongo documents key prefixes per mode, so the key itself is reliable.
    (secretKey.startsWith('sk_live_')
      ? 'live'
      : secretKey.startsWith('sk_test_')
        ? 'test'
        : undefined);
  if (!environment) {
    throw reader.fail('ENVIRONMENT', 'is required: the mode could not be inferred from the key.');
  }

  return {
    provider: PAYMONGO_PROVIDER_NAME,
    secretKey,
    environment,
    ...(webhookSecret !== undefined && { webhookSecret }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}
