import type { AccountEnvOptions } from '@culgate/core';
import { createEnvReader, defaultEnv } from '@culgate/core';
import type { XenditAccountConfig } from './config.js';
import { XENDIT_PROVIDER_NAME } from './config.js';

export interface XenditEnvOptions extends AccountEnvOptions {
  /** Explicit values. These take precedence over environment variables. */
  overrides?: Partial<Omit<XenditAccountConfig, 'provider'>>;
}

/**
 * Builds a Xendit account config from environment variables. With the
 * default prefix `XENDIT` it reads:
 *
 * - `XENDIT_SECRET_KEY` (required)
 * - `XENDIT_ENVIRONMENT` (required: `test` or `live`. Xendit documents no key
 *   prefix per mode, so it cannot be inferred from the key.)
 * - `XENDIT_WEBHOOK_TOKEN` (optional)
 * - `XENDIT_TIMEOUT_MS` (optional)
 */
export function xenditAccountFromEnv(options: XenditEnvOptions = {}): XenditAccountConfig {
  const reader = createEnvReader(options.env ?? defaultEnv(), options.prefix ?? 'XENDIT');
  const { overrides = {} } = options;

  const secretKey = overrides.secretKey ?? reader.required('SECRET_KEY');
  const environment = overrides.environment ?? reader.environment();
  if (!environment) throw reader.fail('ENVIRONMENT', 'is required but not set.');
  const webhookToken = overrides.webhookToken ?? reader.optional('WEBHOOK_TOKEN');
  const timeoutMs = overrides.timeoutMs ?? reader.integer('TIMEOUT_MS');

  return {
    provider: XENDIT_PROVIDER_NAME,
    secretKey,
    environment,
    ...(webhookToken !== undefined && { webhookToken }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}
