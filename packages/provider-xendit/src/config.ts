import type { BaseAccountConfig, ProviderConfigContext } from '@culgate/core';
import { ConfigurationError, ENVIRONMENTS } from '@culgate/core';

export const XENDIT_PROVIDER_NAME = 'xendit';

export interface XenditAccountConfig extends BaseAccountConfig {
  readonly provider: typeof XENDIT_PROVIDER_NAME;
  /**
   * Secret API key. Xendit issues separate keys for test and live mode; the
   * key alone decides the mode, so make sure it matches `environment`.
   */
  readonly secretKey: string;
  /**
   * The account's webhook verification token from the Xendit dashboard.
   * Required to receive webhooks.
   */
  readonly webhookToken?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  readonly timeoutMs?: number;
}

/** Validates raw account config. Error messages name keys, never values. */
export function parseXenditConfig(
  raw: Readonly<Record<string, unknown>>,
  { accountId }: ProviderConfigContext,
): XenditAccountConfig {
  const fail = (message: string) =>
    new ConfigurationError(`Account "${accountId}": ${message}`, {
      accountId,
      provider: XENDIT_PROVIDER_NAME,
    });

  const { secretKey, webhookToken, timeoutMs } = raw;
  const environment = ENVIRONMENTS.find((candidate) => candidate === raw['environment']);
  if (!environment) throw fail('"environment" must be "test" or "live".');

  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    throw fail('missing required config key "secretKey".');
  }
  if (webhookToken !== undefined && (typeof webhookToken !== 'string' || !webhookToken)) {
    throw fail('"webhookToken" must be a non-empty string when provided.');
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs))) {
    throw fail('"timeoutMs" must be an integer number of milliseconds.');
  }

  return {
    provider: XENDIT_PROVIDER_NAME,
    environment,
    secretKey,
    ...(webhookToken !== undefined && { webhookToken }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}
