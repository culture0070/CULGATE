import type { CapabilityContext } from '@culgate/core';
import { getOperationHandler, PaymentSDKError, UnsupportedOperationError } from '@culgate/core';
import type { ResolvedAccount } from './account-manager.js';

/** Ownership fields the SDK adds to every model an adapter returns. */
export interface AccountOwnership {
  accountId: string;
  provider: string;
}

/**
 * The single path every provider call takes: capability check, the account's
 * own adapter, then ownership stamping.
 *
 * Throws `UnsupportedOperationError` before any provider code runs when the
 * operation is not supported in this context. `accountId` and `provider` are
 * set here, never by the adapter, so a result cannot be mislabeled.
 */
export async function dispatch<TModel extends object>(
  account: ResolvedAccount,
  context: CapabilityContext,
  input: object,
): Promise<TModel & AccountOwnership> {
  const { id: accountId, provider } = account.info;
  const result = account.adapter.capabilities.check(context);
  if (!result.supported) {
    throw new UnsupportedOperationError(context.operation, result.reason, { accountId, provider });
  }
  const handler = getOperationHandler(account.adapter, context.operation);
  if (!handler) {
    throw new UnsupportedOperationError(context.operation, 'the provider does not implement it', {
      accountId,
      provider,
    });
  }
  try {
    const model = (await handler(input as never)) as TModel;
    return { ...model, accountId, provider };
  } catch (error) {
    throw attachAccount(error, accountId, provider);
  }
}

/** Adds account/provider context to SDK errors raised by adapters. */
function attachAccount(error: unknown, accountId: string, provider: string): unknown {
  if (error instanceof PaymentSDKError) {
    const target = error as { accountId?: string; provider?: string };
    target.accountId ??= accountId;
    target.provider ??= provider;
  }
  return error;
}
