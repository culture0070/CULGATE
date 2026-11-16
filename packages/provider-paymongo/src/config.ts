import type { BaseAccountConfig, Environment, ProviderConfigContext } from '@culgate/core';
import { ConfigurationError } from '@culgate/core';

export const PAYMONGO_PROVIDER_NAME = 'paymongo';

export interface PayMongoAccountConfig extends BaseAccountConfig {
  readonly provider: typeof PAYMONGO_PROVIDER_NAME;
  /** Secret API key: `sk_test_...` for `test`, `sk_live_...` for `live`. */
  readonly secretKey: string;
  /**
   * Signing secret (`whsk_...`) of the webhook that delivers to this account.
   * Required to receive webhooks; each PayMongo webhook has its own secret.
   */
  readonly webhookSecret?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  readonly timeoutMs?: number;
}

const KEY_PREFIX: Record<Environment, string> = { test: 'sk_test_', live: 'sk_live_' };

/** Validates raw account config. Error messages name keys, never values. */
export function parsePayMongoConfig(
  raw: Readonly<Record<string, unknown>>,
  { accountId }: ProviderConfigContext,
): PayMongoAccountConfig {
  const fail = (message: string) =>
    new ConfigurationError(`Account "${accountId}": ${message}`, {
      accountId,
      provider: PAYMONGO_PROVIDER_NAME,
    });

  const environment = raw['environment'] as Environment;
  const { secretKey, webhookSecret, timeoutMs } = raw;

  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    throw fail('missing required config key "secretKey".');
  }
  if (secretKey.startsWith('pk_')) {
    throw fail('"secretKey" is a public key. Use the PayMongo secret key (sk_...).');
  }
  if (!secretKey.startsWith(KEY_PREFIX[environment])) {
    throw fail(
      `"secretKey" does not match environment "${environment}" ` +
        `(expected a key starting with "${KEY_PREFIX[environment]}").`,
    );
  }
  if (webhookSecret !== undefined && (typeof webhookSecret !== 'string' || !webhookSecret)) {
    throw fail('"webhookSecret" must be a non-empty string when provided.');
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs))) {
    throw fail('"timeoutMs" must be an integer number of milliseconds.');
  }

  return {
    provider: PAYMONGO_PROVIDER_NAME,
    environment,
    secretKey,
    ...(webhookSecret !== undefined && { webhookSecret }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}
