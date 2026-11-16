import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderPayment,
  ProviderPaymentCreateInput,
  ProviderRefund,
  ProviderRefundCreateInput,
} from '@culgate/core';
import {
  AuthenticationError,
  createProviderRequest,
  createStaticCapabilities,
  PaymentNotFoundError,
  PaymentSDKError,
  ProviderError,
  RateLimitError,
  RefundError,
} from '@culgate/core';
import { CHECKOUT_PAYMENT_METHODS, createPayMongoCheckout } from './checkout.js';
import { createPayMongoClient, hasProviderCode } from './client.js';
import type { PayMongoAccountConfig } from './config.js';
import {
  invalid,
  mapPaymentIntent,
  mapRefund,
  PAYMENT_METHODS,
  toPayMongoMetadata,
} from './mappers.js';
import type { PayMongoWebhookOptions } from './webhooks.js';
import { createPayMongoWebhooks } from './webhooks.js';
import {
  paymentIntentResponseSchema,
  paymentMethodResponseSchema,
  paymentResponseSchema,
  refundResponseSchema,
} from './schemas.js';

/** Minimum Payment Intent / refund amount, in centavos. */
const MINIMUM_AMOUNT = 100;
/** PayMongo's `Idempotency-Key` limit. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
/** Suffixes that derive one key per created resource from the caller's key. */
const INTENT_KEY_SUFFIX = ':pi';
const METHOD_KEY_SUFFIX = ':pm';
const REFUND_REASON_CODES = new Set(['duplicate', 'fraudulent', 'requested_by_customer', 'others']);
const MAX_NOTES_LENGTH = 255;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_]{1,128}$/;

export const PAYMONGO_OPERATIONS = [
  'payments.create',
  'payments.retrieve',
  'payments.cancel',
  'refunds.create',
  'refunds.retrieve',
  'checkout.create',
  'checkout.retrieve',
  'checkout.expire',
  'webhooks.verify',
  'webhooks.normalize',
  'provider.request',
] as const;

export interface PayMongoAdapterOptions {
  baseUrl: string;
  webhooks?: PayMongoWebhookOptions;
}

export function createPayMongoAdapter(
  context: ProviderAdapterContext<PayMongoAccountConfig>,
  options: PayMongoAdapterOptions,
): ProviderAdapter {
  const client = createPayMongoClient(context, options.baseUrl);
  // Webhooks are available only on accounts configured with a webhook secret.
  const { webhookSecret } = context.config;
  const operations = PAYMONGO_OPERATIONS.filter(
    (operation) => webhookSecret !== undefined || !operation.startsWith('webhooks.'),
  );

  // PayMongo documents an `Idempotency-Key` header, but its test environment
  // was observed (2026-11-16) to ignore it: the same key created two payment
  // intents and two refunds. The header is still sent, but nothing relies on
  // it, so writes are never retried automatically.
  const idempotency = (key: string | undefined, suffix = '') =>
    key === undefined ? {} : { headers: { 'idempotency-key': key + suffix } };

  async function retrieveIntent(paymentId: string) {
    assertResourceId(paymentId, 'paymentId');
    try {
      return await client.send(paymentIntentResponseSchema, {
        method: 'GET',
        path: `/v1/payment_intents/${paymentId}`,
      });
    } catch (error) {
      throw asPaymentNotFound(error, paymentId);
    }
  }

  /**
   * PayMongo's Payment Intent workflow, run server-side for redirect-based
   * methods: create the intent, create a payment method, attach it. The
   * attach response carries the URL the customer must visit.
   */
  async function createPayment(input: ProviderPaymentCreateInput): Promise<ProviderPayment> {
    const methodType = input.paymentMethod?.type;
    if (methodType === undefined) {
      throw invalid(
        'paymentMethod',
        `PayMongo payments require a payment method type: ${Object.keys(PAYMENT_METHODS).join(', ')}.`,
      );
    }
    const providerType = PAYMENT_METHODS[methodType];
    if (providerType === undefined || !Object.hasOwn(PAYMENT_METHODS, methodType)) {
      throw invalid('paymentMethod.type', 'Not supported by the PayMongo adapter.');
    }
    const returnUrl = input.returnUrls?.success;
    if (returnUrl === undefined) {
      throw invalid('returnUrls.success', 'Required: PayMongo redirects the customer back to it.');
    }
    if (input.amount.value < MINIMUM_AMOUNT) {
      throw invalid('amount.value', `PayMongo requires at least ${MINIMUM_AMOUNT} centavos.`);
    }
    const key = input.idempotencyKey;
    if (key !== undefined && key.length > MAX_IDEMPOTENCY_KEY_LENGTH - INTENT_KEY_SUFFIX.length) {
      throw invalid(
        'idempotencyKey',
        `Must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH - INTENT_KEY_SUFFIX.length} characters for PayMongo.`,
      );
    }
    const metadata = toPayMongoMetadata(input.metadata, input.reference);

    const created = await client.send(paymentIntentResponseSchema, {
      method: 'POST',
      path: '/v1/payment_intents',
      body: {
        data: {
          attributes: {
            amount: input.amount.value,
            currency: input.amount.currency,
            payment_method_allowed: [providerType],
            ...(input.description !== undefined && { description: input.description }),
            ...(metadata && { metadata }),
          },
        },
      },
      ...idempotency(key, INTENT_KEY_SUFFIX),
    });
    const intentId = created.data.data.id;

    // If PayMongo ever answers a repeated key with the original intent and a
    // method is already attached, attaching again would fail: return it as is.
    if (created.data.data.attributes.status !== 'awaiting_payment_method') {
      return mapPaymentIntent(created.data.data, created.raw);
    }

    try {
      assertResourceId(intentId, 'payment intent id');
      const method = await client.send(paymentMethodResponseSchema, {
        method: 'POST',
        path: '/v1/payment_methods',
        body: { data: { attributes: { type: providerType } } },
        ...idempotency(key, METHOD_KEY_SUFFIX),
      });
      // Attach is not a resource creation, so no idempotency key is sent.
      const attached = await client.send(paymentIntentResponseSchema, {
        method: 'POST',
        path: `/v1/payment_intents/${intentId}/attach`,
        body: {
          data: { attributes: { payment_method: method.data.data.id, return_url: returnUrl } },
        },
      });
      return mapPaymentIntent(attached.data.data, attached.raw);
    } catch (error) {
      // The intent exists at PayMongo. Tell the caller which one, so it can be
      // retrieved, retried with the same idempotency key, or cancelled.
      throw withDetails(error, { paymentIntentId: intentId, stage: 'attach_payment_method' });
    }
  }

  async function createRefund(input: ProviderRefundCreateInput): Promise<ProviderRefund> {
    const intent = await retrieveIntent(input.paymentId);
    // Refunds target the Payment (`pay_...`) the intent produced, not the intent.
    const paid = (intent.data.data.attributes.payments ?? []).find(
      (payment) => payment.attributes.status === 'paid',
    );
    if (!paid) {
      throw new RefundError(
        `Payment "${input.paymentId}" has no paid PayMongo payment to refund.`,
        { code: 'payment_not_refundable' },
      );
    }
    assertResourceId(paid.id, 'payment id');

    // PayMongo requires an amount. For a full refund, send what is still
    // refundable: the payment amount less refunds that have not failed.
    const refunded = (paid.attributes.refunds ?? [])
      .filter((refund) => refund.attributes.status !== 'failed')
      .reduce((sum, refund) => sum + (refund.attributes.amount ?? 0), 0);
    const amount =
      input.amount?.value ??
      (typeof paid.attributes.amount === 'number' ? paid.attributes.amount - refunded : undefined);
    if (typeof amount !== 'number') {
      throw invalid('amount', 'Required: PayMongo did not report the payment amount.');
    }
    if (input.amount === undefined && amount <= 0) {
      throw new RefundError(`Payment "${input.paymentId}" has already been fully refunded.`, {
        code: 'payment_not_refundable',
      });
    }
    if (amount < MINIMUM_AMOUNT) {
      throw invalid('amount.value', `PayMongo requires at least ${MINIMUM_AMOUNT} centavos.`);
    }

    // PayMongo requires a reason code. Anything else is sent as `others`, with
    // the caller's text preserved in `notes`.
    const isCode = input.reason !== undefined && REFUND_REASON_CODES.has(input.reason);
    if (input.reason !== undefined && !isCode && input.reason.length > MAX_NOTES_LENGTH) {
      throw invalid('reason', `Must be at most ${MAX_NOTES_LENGTH} characters for PayMongo.`);
    }

    try {
      const refund = await client.send(refundResponseSchema, {
        method: 'POST',
        path: '/v1/refunds',
        body: {
          data: {
            attributes: {
              amount,
              payment_id: paid.id,
              reason: isCode ? input.reason : 'others',
              ...(input.reason !== undefined && !isCode && { notes: input.reason }),
            },
          },
        },
        ...idempotency(input.idempotencyKey),
      });
      return mapRefund(refund.data.data, input.paymentId, refund.raw);
    } catch (error) {
      throw asRefundError(error);
    }
  }

  async function retrieveRefund(refundId: string): Promise<ProviderRefund> {
    assertResourceId(refundId, 'refundId');
    let refund;
    try {
      refund = await client.send(refundResponseSchema, {
        method: 'GET',
        path: `/v1/refunds/${refundId}`,
      });
    } catch (error) {
      if (hasProviderCode(error, 'resource_not_found') || isNotFound(error)) {
        throw new RefundError(`Refund "${refundId}" was not found.`, {
          ...providerFields(error),
          code: 'refund_not_found',
          cause: error,
        });
      }
      throw error;
    }

    // A refund references the Payment (`pay_...`). CulGate payment IDs are
    // Payment Intent IDs, so resolve the intent the payment belongs to.
    const providerPaymentId = refund.data.data.attributes.payment_id;
    assertResourceId(providerPaymentId, 'payment id');
    const payment = await client.send(paymentResponseSchema, {
      method: 'GET',
      path: `/v1/payments/${providerPaymentId}`,
    });
    const paymentId = payment.data.data.attributes.payment_intent_id ?? providerPaymentId;
    return mapRefund(refund.data.data, paymentId, refund.raw);
  }

  return {
    capabilities: createStaticCapabilities({
      operations,
      currencies: ['PHP'],
      paymentMethods: {
        'payments.create': Object.keys(PAYMENT_METHODS),
        'checkout.create': Object.keys(CHECKOUT_PAYMENT_METHODS),
      },
    }),
    payments: {
      create: createPayment,
      async retrieve({ paymentId }) {
        const intent = await retrieveIntent(paymentId);
        return mapPaymentIntent(intent.data.data, intent.raw);
      },
      async cancel({ paymentId }) {
        assertResourceId(paymentId, 'paymentId');
        try {
          const intent = await client.send(paymentIntentResponseSchema, {
            method: 'POST',
            path: `/v1/payment_intents/${paymentId}/cancel`,
          });
          return mapPaymentIntent(intent.data.data, intent.raw);
        } catch (error) {
          throw asPaymentNotFound(error, paymentId);
        }
      },
    },
    refunds: {
      create: createRefund,
      retrieve: ({ refundId }) => retrieveRefund(refundId),
    },
    checkout: createPayMongoCheckout(client),
    provider: { request: createProviderRequest(client.http) },
    ...(webhookSecret !== undefined && {
      webhooks: createPayMongoWebhooks({ ...context.config, webhookSecret }, options.webhooks),
    }),
  };
}

/** IDs are interpolated into request paths, so they must be plain tokens. */
function assertResourceId(value: string, path: string): void {
  if (typeof value !== 'string' || !RESOURCE_ID_PATTERN.test(value)) {
    throw invalid(path, 'Not a valid PayMongo resource ID.');
  }
}

function isNotFound(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.httpStatus === 404;
}

function providerFields(error: ProviderError) {
  return {
    ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
    ...(error.providerCode !== undefined && { providerCode: error.providerCode }),
    ...(error.requestId !== undefined && { requestId: error.requestId }),
    ...(error.details !== undefined && { details: error.details }),
  };
}

function asPaymentNotFound(error: unknown, paymentId: string): unknown {
  if (hasProviderCode(error, 'resource_not_found') || isNotFound(error)) {
    return new PaymentNotFoundError(`Payment "${paymentId}" was not found.`, {
      ...providerFields(error),
      cause: error,
    });
  }
  return error;
}

/** Wraps a PayMongo rejection of a refund, leaving auth/rate-limit errors as they are. */
function asRefundError(error: unknown): unknown {
  const rejected =
    error instanceof ProviderError &&
    !(error instanceof AuthenticationError) &&
    !(error instanceof RateLimitError) &&
    error.providerCode !== undefined;
  if (!rejected) return error;
  return new RefundError(error.message, {
    ...providerFields(error),
    retryable: error.retryable,
    cause: error,
  });
}

function withDetails(error: unknown, details: Record<string, unknown>): unknown {
  if (error instanceof PaymentSDKError) {
    (error as { details?: Record<string, unknown> }).details = { ...error.details, ...details };
  }
  return error;
}
