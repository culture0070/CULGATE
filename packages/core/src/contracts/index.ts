import type { Operation, ProviderCapabilities } from '../capabilities/index.js';
import type { BaseAccountConfig } from '../configuration/index.js';
import { ConfigurationError } from '../errors/index.js';
import type { FetchLike, Logger } from '../http/index.js';
import type { ProviderRequestOperations } from '../http/provider-request.js';
import type { CheckoutLineItem, CheckoutSession } from '../models/checkout.js';
import type { Payment, Refund } from '../models/index.js';
import type { Money } from '../money/index.js';
import type { WebhookOperations } from '../webhooks/index.js';

/**
 * Adapters return models without account ownership fields. The SDK stamps
 * `accountId` and `provider` itself so an adapter cannot mislabel a result.
 */
export type ProviderPayment = Omit<Payment, 'accountId' | 'provider'>;
export type ProviderRefund = Omit<Refund, 'accountId' | 'provider'>;
export type ProviderCheckoutSession = Omit<CheckoutSession, 'accountId' | 'provider'>;

export interface ProviderCheckoutCreateInput {
  /** At least one item, all in the same currency. */
  lineItems: CheckoutLineItem[];
  /** Sum of `quantity x amount` over all items, computed by the SDK. */
  total: Money;
  reference?: string;
  description?: string;
  /** Restricts the methods offered. Omit for the provider's default selection. */
  paymentMethods?: string[];
  returnUrls?: { success?: string; cancel?: string };
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ProviderCheckoutRetrieveInput {
  sessionId: string;
}

export interface ProviderCheckoutExpireInput {
  sessionId: string;
}

export interface CheckoutOperations {
  create(input: ProviderCheckoutCreateInput): Promise<ProviderCheckoutSession>;
  retrieve(input: ProviderCheckoutRetrieveInput): Promise<ProviderCheckoutSession>;
  /** Stops the session from accepting payment. */
  expire(input: ProviderCheckoutExpireInput): Promise<ProviderCheckoutSession>;
}

export interface ProviderPaymentCreateInput {
  amount: Money;
  reference?: string;
  description?: string;
  paymentMethod?: { type: string };
  returnUrls?: { success?: string; cancel?: string };
  metadata?: Record<string, unknown>;
  /** Mapped to the provider's documented idempotency mechanism, if any. */
  idempotencyKey?: string;
}

export interface ProviderPaymentRetrieveInput {
  paymentId: string;
}

export interface ProviderPaymentCancelInput {
  paymentId: string;
}

export interface ProviderPaymentCaptureInput {
  paymentId: string;
  /** Omit to capture the full authorized amount. */
  amount?: Money;
}

export interface ProviderRefundCreateInput {
  paymentId: string;
  /** Omit for a full refund. */
  amount?: Money;
  reason?: string;
  idempotencyKey?: string;
}

export interface ProviderRefundRetrieveInput {
  refundId: string;
}

export interface PaymentOperations {
  create(input: ProviderPaymentCreateInput): Promise<ProviderPayment>;
  retrieve(input: ProviderPaymentRetrieveInput): Promise<ProviderPayment>;
  cancel(input: ProviderPaymentCancelInput): Promise<ProviderPayment>;
  capture(input: ProviderPaymentCaptureInput): Promise<ProviderPayment>;
}

export interface RefundOperations {
  create(input: ProviderRefundCreateInput): Promise<ProviderRefund>;
  retrieve(input: ProviderRefundRetrieveInput): Promise<ProviderRefund>;
}

/**
 * A provider client bound to exactly one account's credentials.
 *
 * `capabilities.operations` is the source of truth for what is supported;
 * every listed operation must have an implementation
 * (see {@link assertAdapterImplementsCapabilities}).
 */
export interface ProviderAdapter {
  readonly capabilities: ProviderCapabilities;
  readonly payments?: Partial<PaymentOperations>;
  readonly refunds?: Partial<RefundOperations>;
  readonly checkout?: Partial<CheckoutOperations>;
  /** Present only when the account is configured to receive webhooks. */
  readonly webhooks?: Partial<WebhookOperations>;
  /** The provider-specific escape hatch: authenticated raw API requests. */
  readonly provider?: Partial<ProviderRequestOperations>;
}

export interface ProviderConfigContext {
  readonly accountId: string;
}

export interface ProviderAdapterContext<TConfig extends BaseAccountConfig> {
  readonly accountId: string;
  readonly config: TConfig;
  /** Application-supplied `fetch`, to be passed to `createHttpClient`. */
  readonly fetch?: FetchLike;
  /** Application-supplied logger, to be passed to `createHttpClient`. */
  readonly logger?: Logger;
}

/**
 * A registrable provider. One definition creates one isolated adapter per
 * configured account.
 */
export interface ProviderDefinition<TConfig extends BaseAccountConfig = BaseAccountConfig> {
  /** Unique provider name; matches the `provider` field of account configs. */
  readonly name: TConfig['provider'];
  /**
   * Validates raw account configuration. Must throw `ConfigurationError`
   * naming the offending key, and must never include a value in the message.
   */
  parseConfig(raw: Readonly<Record<string, unknown>>, context: ProviderConfigContext): TConfig;
  createAdapter(context: ProviderAdapterContext<TConfig>): ProviderAdapter;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape for heterogeneous provider lists
export type AnyProviderDefinition = ProviderDefinition<any>;

/** Extracts the account config type of a provider definition. */
export type AccountConfigOf<TProvider> =
  TProvider extends ProviderDefinition<infer TConfig> ? TConfig : never;

/** Returns the adapter's implementation of `operation`, if it has one. */
export function getOperationHandler(
  adapter: ProviderAdapter,
  operation: Operation,
): ((input: never) => unknown) | undefined {
  const [resource, method] = operation.split('.') as [keyof ProviderAdapter, string];
  const group = adapter[resource] as Record<string, unknown> | undefined;
  if (!group || !Object.hasOwn(group, method)) return undefined;
  const handler = group[method];
  return typeof handler === 'function'
    ? (handler.bind(group) as (input: never) => unknown)
    : undefined;
}

/** Fails fast when an adapter claims an operation it does not implement. */
export function assertAdapterImplementsCapabilities(
  adapter: ProviderAdapter,
  context: { provider: string; accountId: string },
): void {
  for (const operation of adapter.capabilities.operations) {
    if (!getOperationHandler(adapter, operation)) {
      throw new ConfigurationError(
        `Provider "${context.provider}" declares support for "${operation}" but does not implement it.`,
        { code: 'invalid_adapter', ...context },
      );
    }
  }
}
