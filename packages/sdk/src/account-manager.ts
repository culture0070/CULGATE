import type {
  AccountInfo,
  AnyProviderDefinition,
  Environment,
  FetchLike,
  Logger,
  ProviderAdapter,
  ProviderRegistry,
} from '@culgate/core';
import {
  assertAdapterImplementsCapabilities,
  ConfigurationError,
  ENVIRONMENTS,
} from '@culgate/core';

import type { ProviderClient } from './resources/provider-client.js';

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** An account bound to its own isolated adapter. Internal to the SDK. */
export interface ResolvedAccount {
  readonly info: AccountInfo;
  readonly adapter: ProviderAdapter;
}

/** Shared runtime services handed to every adapter. */
export interface AdapterRuntime {
  readonly fetch?: FetchLike;
  readonly logger?: Logger;
}

/** Public, read-only view of configured accounts. Never exposes credentials. */
export interface AccountsApi<TAccountId extends string = string> {
  list(): AccountInfo[];
  get(accountId: TAccountId): AccountInfo;
  has(accountId: string): accountId is TAccountId;
  /**
   * Provider-specific client for one account (the escape hatch). Requests
   * made through it are in the provider's own format and are not portable.
   */
  getClient(accountId: TAccountId): ProviderClient;
}

/**
 * Validates account configuration and owns one adapter per account.
 *
 * Raw configuration is handed to the provider and then dropped; this class
 * retains only non-sensitive {@link AccountInfo} plus the adapter.
 */
export class AccountManager {
  readonly #accounts = new Map<string, ResolvedAccount>();

  constructor(registry: ProviderRegistry, accounts: unknown, runtime: AdapterRuntime = {}) {
    if (!isPlainObject(accounts)) {
      throw new ConfigurationError('`accounts` must be an object keyed by account ID.');
    }
    const entries = Object.entries(accounts);
    if (entries.length === 0) {
      throw new ConfigurationError('At least one account must be configured.');
    }
    for (const [accountId, raw] of entries) {
      this.#accounts.set(accountId, createAccount(registry, accountId, raw, runtime));
    }
  }

  /** Resolves an explicitly selected account. There is no default account. */
  resolve(accountId: unknown): ResolvedAccount {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new ConfigurationError(
        'An `account` must be selected explicitly for every operation.',
        { code: 'account_required' },
      );
    }
    const account = this.#accounts.get(accountId);
    if (!account) {
      throw new ConfigurationError(`Account "${accountId}" is not configured.`, {
        code: 'unknown_account',
        accountId,
      });
    }
    return account;
  }

  has(accountId: string): boolean {
    return this.#accounts.has(accountId);
  }

  list(): AccountInfo[] {
    return [...this.#accounts.values()].map((account) => account.info);
  }
}

function createAccount(
  registry: ProviderRegistry,
  accountId: string,
  raw: unknown,
  runtime: AdapterRuntime,
): ResolvedAccount {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new ConfigurationError(
      'Invalid account ID. Use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.',
      { code: 'invalid_account_id' },
    );
  }
  if (!isPlainObject(raw)) {
    throw new ConfigurationError(`Account "${accountId}" config must be an object.`, { accountId });
  }
  const { provider: providerName, environment } = raw;
  if (typeof providerName !== 'string' || providerName.length === 0) {
    throw new ConfigurationError(
      `Account "${accountId}" is missing required config key "provider".`,
      {
        accountId,
      },
    );
  }
  if (!isEnvironment(environment)) {
    throw new ConfigurationError(
      `Account "${accountId}" config key "environment" must be "test" or "live".`,
      { accountId, provider: providerName },
    );
  }

  const provider: AnyProviderDefinition = registry.get(providerName);
  // Shallow frozen copy: later mutation of the caller's object cannot change
  // which credentials or environment this account uses.
  const config = provider.parseConfig(Object.freeze({ ...raw }), { accountId });
  const adapter = provider.createAdapter({ accountId, config, ...runtime });
  assertAdapterImplementsCapabilities(adapter, { provider: providerName, accountId });

  return Object.freeze({
    info: Object.freeze({ id: accountId, provider: providerName, environment }),
    adapter,
  });
}

function isEnvironment(value: unknown): value is Environment {
  return (ENVIRONMENTS as readonly unknown[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
