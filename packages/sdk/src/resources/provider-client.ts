import type { ProviderRequestInput, ProviderResponse } from '@culgate/core';
import { PaymentSDKError, UnsupportedOperationError } from '@culgate/core';
import type { ResolvedAccount } from '../account-manager.js';

/**
 * Provider-specific access for one account.
 *
 * This is an escape hatch: requests and responses are in the provider's own
 * format, are not validated or normalized, and are not portable to another
 * provider. Prefer the unified resources (`sdk.payments`, `sdk.refunds`, ...)
 * whenever they cover what you need.
 */
export interface ProviderClient {
  readonly accountId: string;
  readonly provider: string;
  /**
   * Sends an authenticated request to the account's provider API. The host
   * and credentials are fixed by the account and cannot be overridden;
   * redirects are refused; writes are never retried.
   */
  providerRequest<T = unknown>(input: ProviderRequestInput): Promise<ProviderResponse<T>>;
}

export function createProviderClient(account: ResolvedAccount): ProviderClient {
  const { id: accountId, provider } = account.info;
  return Object.freeze({
    accountId,
    provider,
    async providerRequest<T>(input: ProviderRequestInput): Promise<ProviderResponse<T>> {
      const operation = 'provider.request';
      const result = account.adapter.capabilities.check({ operation });
      const request = account.adapter.provider?.request;
      if (!result.supported || !request) {
        throw new UnsupportedOperationError(
          operation,
          result.supported ? 'the provider does not implement it' : result.reason,
          { accountId, provider },
        );
      }
      try {
        return (await request.call(account.adapter.provider, input)) as ProviderResponse<T>;
      } catch (error) {
        if (error instanceof PaymentSDKError) {
          const target = error as { accountId?: string; provider?: string };
          target.accountId ??= accountId;
          target.provider ??= provider;
        }
        throw error;
      }
    },
  });
}
