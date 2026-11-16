import type { CapabilityContext, CapabilityResult, Operation } from '@culgate/core';
import { isOperation } from '@culgate/core';
import type { AccountManager } from '../account-manager.js';
import { fail } from '../validation.js';

export interface CapabilityQuery<TAccountId extends string = string> extends CapabilityContext {
  account: TAccountId;
}

export class CapabilitiesResource<TAccountId extends string = string> {
  readonly #accounts: AccountManager;

  /** @internal */
  constructor(accounts: AccountManager) {
    this.#accounts = accounts;
  }

  /** Whether the operation is supported for this account in this context. */
  supports(query: CapabilityQuery<TAccountId>): boolean {
    return this.check(query).supported;
  }

  /** Like {@link supports}, but explains why when unsupported. */
  check(query: CapabilityQuery<TAccountId>): CapabilityResult {
    const { account, ...context } = query;
    if (!isOperation(context.operation)) fail('operation', 'Unknown operation.');
    return this.#accounts.resolve(account).adapter.capabilities.check(context);
  }

  /** Operations the account supports in at least some context. */
  operations(account: TAccountId): Operation[] {
    return [...this.#accounts.resolve(account).adapter.capabilities.operations];
  }
}
