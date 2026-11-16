import type {
  Money,
  Payment,
  ProviderPayment,
  ProviderPaymentCaptureInput,
  ProviderPaymentCreateInput,
} from '@culgate/core';
import { assertValidMoney } from '@culgate/core';
import type { AccountManager } from '../account-manager.js';
import { dispatch } from '../dispatch.js';
import {
  assertInputObject,
  fail,
  optionalAmount,
  optionalHttpUrl,
  optionalMetadata,
  optionalString,
  requiredString,
} from '../validation.js';

export interface PaymentCreateInput<TAccountId extends string = string> {
  /** Application-defined account ID. Required: there is no default account. */
  account: TAccountId;
  /** Amount in the currency's minor unit. */
  amount: Money;
  /** Your own identifier for this payment, e.g. an order number. */
  reference?: string;
  description?: string;
  paymentMethod?: { type: string };
  returnUrls?: { success?: string; cancel?: string };
  metadata?: Record<string, unknown>;
  /**
   * Reuse the same key when retrying the same logical payment. Enforcement
   * depends on the provider; see the provider's documentation in CulGate.
   */
  idempotencyKey?: string;
}

export interface PaymentRetrieveInput<TAccountId extends string = string> {
  account: TAccountId;
  /** The `id` of a payment previously returned for this same account. */
  paymentId: string;
}

export interface PaymentCancelInput<TAccountId extends string = string> {
  account: TAccountId;
  paymentId: string;
}

export interface PaymentCaptureInput<TAccountId extends string = string> {
  account: TAccountId;
  paymentId: string;
  /** Omit to capture the full authorized amount. */
  amount?: Money;
}

export class PaymentsResource<TAccountId extends string = string> {
  readonly #accounts: AccountManager;

  /** @internal */
  constructor(accounts: AccountManager) {
    this.#accounts = accounts;
  }

  async create(input: PaymentCreateInput<TAccountId>): Promise<Payment> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const providerInput = parseCreateInput(input);
    return dispatch<ProviderPayment>(
      account,
      {
        operation: 'payments.create',
        currency: providerInput.amount.currency,
        ...(providerInput.paymentMethod && { paymentMethod: providerInput.paymentMethod.type }),
      },
      providerInput,
    );
  }

  /** Fetches the provider's current view of a payment. */
  async retrieve(input: PaymentRetrieveInput<TAccountId>): Promise<Payment> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const paymentId = requiredString(input.paymentId, 'paymentId', 255);
    return dispatch<ProviderPayment>(account, { operation: 'payments.retrieve' }, { paymentId });
  }

  async cancel(input: PaymentCancelInput<TAccountId>): Promise<Payment> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const paymentId = requiredString(input.paymentId, 'paymentId', 255);
    return dispatch<ProviderPayment>(account, { operation: 'payments.cancel' }, { paymentId });
  }

  /** Captures an `authorized` payment, fully or (where supported) partially. */
  async capture(input: PaymentCaptureInput<TAccountId>): Promise<Payment> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const providerInput: ProviderPaymentCaptureInput = {
      paymentId: requiredString(input.paymentId, 'paymentId', 255),
    };
    const amount = optionalAmount(input.amount, 'amount');
    if (amount) providerInput.amount = amount;
    return dispatch<ProviderPayment>(
      account,
      { operation: 'payments.capture', ...(amount && { currency: amount.currency }) },
      providerInput,
    );
  }
}

function parseCreateInput(input: Record<string, unknown>): ProviderPaymentCreateInput {
  const { amount, paymentMethod, returnUrls } = input;
  assertValidMoney(amount, { path: 'amount', positive: true });

  const result: ProviderPaymentCreateInput = {
    amount: { value: amount.value, currency: amount.currency },
  };

  const reference = optionalString(input['reference'], 'reference', 255);
  if (reference !== undefined) result.reference = reference;
  const description = optionalString(input['description'], 'description', 1000);
  if (description !== undefined) result.description = description;
  const idempotencyKey = optionalString(input['idempotencyKey'], 'idempotencyKey', 255);
  if (idempotencyKey !== undefined) result.idempotencyKey = idempotencyKey;

  if (paymentMethod !== undefined) {
    if (typeof paymentMethod !== 'object' || paymentMethod === null) {
      fail('paymentMethod', 'Expected an object with a `type`.');
    }
    const type = requiredString(
      (paymentMethod as { type?: unknown }).type,
      'paymentMethod.type',
      64,
    );
    result.paymentMethod = { type };
  }

  if (returnUrls !== undefined) {
    if (typeof returnUrls !== 'object' || returnUrls === null) {
      fail('returnUrls', 'Expected an object.');
    }
    const urls = returnUrls as { success?: unknown; cancel?: unknown };
    const success = optionalHttpUrl(urls.success, 'returnUrls.success');
    const cancel = optionalHttpUrl(urls.cancel, 'returnUrls.cancel');
    result.returnUrls = {
      ...(success !== undefined && { success }),
      ...(cancel !== undefined && { cancel }),
    };
  }

  const metadata = optionalMetadata(input['metadata'], 'metadata');
  if (metadata !== undefined) result.metadata = metadata;

  return result;
}
