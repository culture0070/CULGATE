import type {
  CheckoutLineItem,
  CheckoutSession,
  Money,
  ProviderCheckoutCreateInput,
  ProviderCheckoutSession,
} from '@culgate/core';
import { assertValidMoney, UnsupportedOperationError } from '@culgate/core';
import type { AccountManager } from '../account-manager.js';
import { dispatch } from '../dispatch.js';
import {
  assertInputObject,
  fail,
  optionalHttpUrl,
  optionalMetadata,
  optionalString,
  requiredString,
} from '../validation.js';

export interface CheckoutCreateInput<TAccountId extends string = string> {
  /** Application-defined account ID. Required: there is no default account. */
  account: TAccountId;
  /** What the customer is paying for. All items must share one currency. */
  lineItems: CheckoutLineItem[];
  /** Your own identifier for this checkout, e.g. an order number. */
  reference?: string;
  description?: string;
  /**
   * Payment methods to offer, e.g. `['card', 'gcash']`. Omit for the
   * provider's default selection. Check support per provider with
   * `sdk.capabilities.supports({ operation: 'checkout.create', paymentMethod })`.
   */
  paymentMethods?: string[];
  returnUrls?: { success?: string; cancel?: string };
  metadata?: Record<string, unknown>;
  /** Enforcement depends on the provider; see the provider's guide. */
  idempotencyKey?: string;
}

export interface CheckoutRetrieveInput<TAccountId extends string = string> {
  account: TAccountId;
  /** The `id` of a checkout session previously returned for this same account. */
  sessionId: string;
}

const MAX_LINE_ITEMS = 100;

export class CheckoutResource<TAccountId extends string = string> {
  readonly #accounts: AccountManager;

  /** @internal */
  constructor(accounts: AccountManager) {
    this.#accounts = accounts;
  }

  /**
   * Creates a provider-hosted payment page. Send the customer to
   * `session.url`. A created session is not a payment: confirm the outcome
   * with a webhook or `checkout.retrieve`, never from the return URL alone.
   */
  async create(input: CheckoutCreateInput<TAccountId>): Promise<CheckoutSession> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const providerInput = parseCreateInput(input);
    const { currency } = providerInput.total;

    // Every requested method must be supported; report the first that is not.
    for (const paymentMethod of providerInput.paymentMethods ?? []) {
      const result = account.adapter.capabilities.check({
        operation: 'checkout.create',
        currency,
        paymentMethod,
      });
      if (!result.supported) {
        throw new UnsupportedOperationError('checkout.create', result.reason, {
          accountId: account.info.id,
          provider: account.info.provider,
        });
      }
    }
    return dispatch<ProviderCheckoutSession>(
      account,
      { operation: 'checkout.create', currency },
      providerInput,
    );
  }

  /** Fetches the provider's current view of a checkout session. */
  async retrieve(input: CheckoutRetrieveInput<TAccountId>): Promise<CheckoutSession> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const sessionId = requiredString(input.sessionId, 'sessionId', 255);
    return dispatch<ProviderCheckoutSession>(
      account,
      { operation: 'checkout.retrieve' },
      { sessionId },
    );
  }

  /**
   * Stops an open session from accepting payment. Depending on the provider
   * the resulting status is `expired` or `cancelled`.
   */
  async expire(input: CheckoutRetrieveInput<TAccountId>): Promise<CheckoutSession> {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const sessionId = requiredString(input.sessionId, 'sessionId', 255);
    return dispatch<ProviderCheckoutSession>(
      account,
      { operation: 'checkout.expire' },
      { sessionId },
    );
  }
}

function parseCreateInput(input: Record<string, unknown>): ProviderCheckoutCreateInput {
  const { lineItems, paymentMethods, returnUrls } = input;
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    fail('lineItems', 'Expected at least one line item.');
  }
  if (lineItems.length > MAX_LINE_ITEMS) {
    fail('lineItems', `Expected at most ${MAX_LINE_ITEMS} line items.`);
  }

  const items: CheckoutLineItem[] = [];
  let total = 0n;
  let currency: string | undefined;
  lineItems.forEach((raw: unknown, index) => {
    const path = `lineItems.${index}`;
    if (typeof raw !== 'object' || raw === null) fail(path, 'Expected an object.');
    const item = raw as Record<string, unknown>;
    const name = requiredString(item['name'], `${path}.name`, 255);
    const description = optionalString(item['description'], `${path}.description`, 255);
    const { quantity, amount } = item;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) {
      fail(`${path}.quantity`, 'Expected a positive whole number.');
    }
    assertValidMoney(amount, { path: `${path}.amount`, positive: true });
    currency ??= amount.currency;
    if (amount.currency !== currency) {
      fail(`${path}.amount.currency`, 'All line items must use the same currency.');
    }
    total += BigInt(quantity) * BigInt(amount.value);
    items.push({
      name,
      quantity,
      amount: { value: amount.value, currency: amount.currency },
      ...(description !== undefined && { description }),
    });
  });
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('lineItems', 'The total exceeds the safe integer range.');
  }
  const totalMoney: Money = { value: Number(total), currency: currency! };

  const result: ProviderCheckoutCreateInput = { lineItems: items, total: totalMoney };

  const reference = optionalString(input['reference'], 'reference', 255);
  if (reference !== undefined) result.reference = reference;
  const description = optionalString(input['description'], 'description', 1000);
  if (description !== undefined) result.description = description;
  const idempotencyKey = optionalString(input['idempotencyKey'], 'idempotencyKey', 255);
  if (idempotencyKey !== undefined) result.idempotencyKey = idempotencyKey;

  if (paymentMethods !== undefined) {
    if (!Array.isArray(paymentMethods) || paymentMethods.length === 0) {
      fail('paymentMethods', 'Expected a non-empty array, or omit it for the provider default.');
    }
    const methods = paymentMethods.map((method: unknown, index) =>
      requiredString(method, `paymentMethods.${index}`, 64),
    );
    if (new Set(methods).size !== methods.length)
      fail('paymentMethods', 'Must not repeat a method.');
    result.paymentMethods = methods;
  }

  if (returnUrls !== undefined) {
    if (typeof returnUrls !== 'object' || returnUrls === null)
      fail('returnUrls', 'Expected an object.');
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
