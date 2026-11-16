import type { Money, ProviderRefund, ProviderRefundCreateInput, Refund } from '@culgate/core';
import type { AccountManager } from '../account-manager.js';
import { dispatch } from '../dispatch.js';
import {
  assertInputObject,
  optionalAmount,
  optionalString,
  requiredString,
} from '../validation.js';

export interface RefundCreateInput<TAccountId extends string = string> {
  /** The account that owns the payment. Required: there is no default account. */
  account: TAccountId;
  paymentId: string;
  /** Omit to refund the full remaining amount. */
  amount?: Money;
  reason?: string;
  /** Reuse the same key when retrying the same logical refund. */
  idempotencyKey?: string;
}

export interface RefundRetrieveInput<TAccountId extends string = string> {
  account: TAccountId;
  refundId: string;
}

export class RefundsResource<TAccountId extends string = string> {
  readonly #accounts: AccountManager;

  /** @internal */
  constructor(accounts: AccountManager) {
    this.#accounts = accounts;
  }

  /**
   * Requests a full or partial refund. A returned refund may still be
   * `pending` or `processing`; only `succeeded` means the money was returned.
   */
  async create(input: RefundCreateInput<TAccountId>): Promise<Refund> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const providerInput: ProviderRefundCreateInput = {
      paymentId: requiredString(input.paymentId, 'paymentId', 255),
    };
    const amount = optionalAmount(input.amount, 'amount');
    if (amount) providerInput.amount = amount;
    const reason = optionalString(input.reason, 'reason', 255);
    if (reason !== undefined) providerInput.reason = reason;
    const idempotencyKey = optionalString(input.idempotencyKey, 'idempotencyKey', 255);
    if (idempotencyKey !== undefined) providerInput.idempotencyKey = idempotencyKey;

    return dispatch<ProviderRefund>(
      account,
      { operation: 'refunds.create', ...(amount && { currency: amount.currency }) },
      providerInput,
    );
  }

  async retrieve(input: RefundRetrieveInput<TAccountId>): Promise<Refund> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const refundId = requiredString(input.refundId, 'refundId', 255);
    return dispatch<ProviderRefund>(account, { operation: 'refunds.retrieve' }, { refundId });
  }
}
