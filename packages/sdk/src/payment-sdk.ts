import type {
  AccountConfigOf,
  AccountInfo,
  AnyProviderDefinition,
  FetchLike,
  Logger,
} from '@culgate/core';
import { ConfigurationError, ProviderRegistry } from '@culgate/core';
import type { AccountsApi } from './account-manager.js';
import { AccountManager } from './account-manager.js';
import { CapabilitiesResource } from './resources/capabilities.js';
import { CheckoutResource } from './resources/checkout.js';
import { PaymentsResource } from './resources/payments.js';
import { createProviderClient } from './resources/provider-client.js';
import { RefundsResource } from './resources/refunds.js';
import type { WebhookOptions } from './resources/webhooks.js';
import { WebhooksResource } from './resources/webhooks.js';

export interface PaymentSDKOptions<
  TAccountId extends string = string,
  TProviders extends readonly AnyProviderDefinition[] = readonly AnyProviderDefinition[],
> {
  /**
   * Providers this SDK instance can use, e.g. `[paymongo(), xendit()]`.
   * Registration is explicit so unused providers are never bundled or loaded.
   */
  providers: TProviders;
  /** Merchant accounts keyed by an application-defined account ID. */
  accounts: { readonly [K in TAccountId]: AccountConfigOf<TProviders[number]> };
  /**
   * Receives non-sensitive diagnostics (method, path, status, timing) from
   * provider HTTP calls. Never receives headers, credentials, or bodies.
   */
  logger?: Logger;
  /** Custom `fetch` for provider HTTP calls. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Webhook deduplication store and limits. */
  webhooks?: WebhookOptions;
}

/**
 * CulGate entry point. Stateless: holds configuration and provider adapters,
 * never payment data. Every operation selects an account explicitly.
 */
export class PaymentSDK<
  TAccountId extends string = string,
  TProviders extends readonly AnyProviderDefinition[] = readonly AnyProviderDefinition[],
> {
  readonly #manager: AccountManager;

  readonly payments: PaymentsResource<TAccountId>;
  readonly refunds: RefundsResource<TAccountId>;
  /** Provider-hosted payment pages. */
  readonly checkout: CheckoutResource<TAccountId>;
  readonly webhooks: WebhooksResource<TAccountId>;
  readonly capabilities: CapabilitiesResource<TAccountId>;
  /** Read-only, credential-free view of the configured accounts. */
  readonly accounts: AccountsApi<TAccountId>;

  constructor(options: PaymentSDKOptions<TAccountId, TProviders>) {
    if (typeof options !== 'object' || options === null) {
      throw new ConfigurationError('PaymentSDK options must be an object.');
    }
    if (!Array.isArray(options.providers) || options.providers.length === 0) {
      throw new ConfigurationError(
        '`providers` must be a non-empty array of provider definitions.',
      );
    }
    const manager = new AccountManager(new ProviderRegistry(options.providers), options.accounts, {
      ...(options.logger && { logger: options.logger }),
      ...(options.fetch && { fetch: options.fetch }),
    });
    this.#manager = manager;
    this.payments = new PaymentsResource(manager);
    this.refunds = new RefundsResource(manager);
    this.checkout = new CheckoutResource(manager);
    this.webhooks = new WebhooksResource(manager, options.webhooks, options.logger);
    this.capabilities = new CapabilitiesResource(manager);
    this.accounts = Object.freeze({
      list: () => manager.list(),
      get: (accountId: TAccountId) => manager.resolve(accountId).info,
      has: (accountId: string): accountId is TAccountId => manager.has(accountId),
      getClient: (accountId: TAccountId) => createProviderClient(manager.resolve(accountId)),
    });
  }

  /** Credential-free summary; this is all `JSON.stringify(sdk)` reveals. */
  toJSON(): { accounts: AccountInfo[] } {
    return { accounts: this.#manager.list() };
  }
}
