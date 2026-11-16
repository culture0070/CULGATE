import { randomUUID } from 'node:crypto';
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
  ProviderError,
  RateLimitError,
  RefundError,
} from '@culgate/core';
import { CHECKOUT_CURRENCIES, CHECKOUT_PAYMENT_METHODS, createXenditCheckout } from './checkout.js';
import { createXenditClient } from './client.js';
import type { XenditAccountConfig } from './config.js';
import {
  GENERATED_REFERENCE_PREFIX,
  invalid,
  mapPaymentRequest,
  mapRefund,
  PAYMENT_METHODS,
  REASON_METADATA_KEY,
  toXenditAmount,
  toXenditMetadata,
} from './mappers.js';
import { paymentRequestSchema, paymentSchema, refundSchema } from './schemas.js';
import { createXenditWebhooks } from './webhooks.js';

const REFUND_REASON_CODES = new Set([
  'FRAUDULENT',
  'DUPLICATE',
  'REQUESTED_BY_CUSTOMER',
  'CANCELLATION',
  'OTHERS',
]);
const MAX_REASON_LENGTH = 500;
const MAX_REFERENCE_LENGTH = 255;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const XENDIT_OPERATIONS = [
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

export interface XenditAdapterOptions {
  baseUrl: string;
}

export function createXenditAdapter(
  context: ProviderAdapterContext<XenditAccountConfig>,
  options: XenditAdapterOptions,
): ProviderAdapter {
  const client = createXenditClient(context, options.baseUrl);
  // Webhooks are available only on accounts configured with a webhook token.
  const { webhookToken } = context.config;
  const operations = XENDIT_OPERATIONS.filter(
    (operation) => webhookToken !== undefined || !operation.startsWith('webhooks.'),
  );

  async function retrieveRequest(paymentId: string) {
    assertResourceId(paymentId, 'paymentId');
    try {
      return await client.send(
        paymentRequestSchema,
        { method: 'GET', path: `/v3/payment_requests/${paymentId}` },
        // Mapped inside `send` so a malformed response is reported as such.
        (data, raw) => ({ data, payment: mapPaymentRequest(data, raw) }),
      );
    } catch (error) {
      throw asPaymentNotFound(error, paymentId);
    }
  }

  /** One Payment Request (`POST /v3/payment_requests`) for a redirect e-wallet. */
  async function createPayment(input: ProviderPaymentCreateInput): Promise<ProviderPayment> {
    const methodType = input.paymentMethod?.type;
    if (methodType === undefined) {
      throw invalid(
        'paymentMethod',
        `Xendit payments require a payment method type: ${Object.keys(PAYMENT_METHODS).join(', ')}.`,
      );
    }
    const channel = Object.hasOwn(PAYMENT_METHODS, methodType)
      ? PAYMENT_METHODS[methodType]
      : undefined;
    if (!channel) throw invalid('paymentMethod.type', 'Not supported by the Xendit adapter.');
    if (input.amount.currency !== channel.currency) {
      throw invalid('amount.currency', `${methodType} payments must be in ${channel.currency}.`);
    }
    const successUrl = input.returnUrls?.success;
    if (successUrl === undefined) {
      throw invalid('returnUrls.success', 'Required: Xendit redirects the customer back to it.');
    }
    const metadata = toXenditMetadata(input.metadata);

    return client.send(
      paymentRequestSchema,
      {
        method: 'POST',
        path: '/v3/payment_requests',
        // Never retried: Xendit documents no idempotency mechanism here.
        body: {
          // Xendit requires a reference; one is generated when the caller has none.
          reference_id: input.reference ?? `${GENERATED_REFERENCE_PREFIX}${randomUUID()}`,
          type: 'PAY',
          country: channel.country,
          currency: channel.currency,
          request_amount: toXenditAmount(input.amount, 'amount.value'),
          capture_method: 'AUTOMATIC',
          channel_code: channel.channelCode,
          channel_properties: {
            success_return_url: successUrl,
            // CulGate has no separate failure URL; the cancel URL is the closest match.
            failure_return_url: input.returnUrls?.cancel ?? successUrl,
          },
          ...(input.description !== undefined && { description: input.description }),
          ...(metadata && { metadata }),
        },
      },
      mapPaymentRequest,
    );
  }

  async function createRefund(input: ProviderRefundCreateInput): Promise<ProviderRefund> {
    const request = await retrieveRequest(input.paymentId);
    // Refunds target the Payment (`py-...`) made against the request.
    const providerPaymentId = request.data.latest_payment_id;
    if (!providerPaymentId) {
      throw new RefundError(
        `Payment "${input.paymentId}" has no completed Xendit payment to refund.`,
        { code: 'payment_not_refundable' },
      );
    }
    if (input.amount && input.amount.currency !== request.data.currency) {
      throw invalid('amount.currency', `Must match the payment currency ${request.data.currency}.`);
    }

    // Xendit requires a reason code. Anything else is sent as OTHERS, with the
    // caller's text preserved in metadata.
    const code = input.reason?.toUpperCase();
    const isCode = code !== undefined && REFUND_REASON_CODES.has(code);
    if (input.reason !== undefined && !isCode && input.reason.length > MAX_REASON_LENGTH) {
      throw invalid('reason', `Must be at most ${MAX_REASON_LENGTH} characters for Xendit.`);
    }
    const reference = input.idempotencyKey ?? `${GENERATED_REFERENCE_PREFIX}${randomUUID()}`;
    if (reference.length > MAX_REFERENCE_LENGTH) {
      throw invalid('idempotencyKey', `Must be at most ${MAX_REFERENCE_LENGTH} characters.`);
    }

    try {
      return await client.send(
        refundSchema,
        {
          method: 'POST',
          path: '/v3/refunds',
          // Never retried: Xendit documents no idempotency mechanism here.
          body: {
            reference_id: reference,
            payment_id: providerPaymentId,
            reason: isCode ? code : 'OTHERS',
            // Omitting the amount requests a full refund.
            ...(input.amount && { amount: toXenditAmount(input.amount, 'amount.value') }),
            ...(input.reason !== undefined &&
              !isCode && { metadata: { [REASON_METADATA_KEY]: input.reason } }),
          },
        },
        (data, raw) => mapRefund(data, input.paymentId, raw),
      );
    } catch (error) {
      throw asRefundError(error);
    }
  }

  async function retrieveRefund(refundId: string): Promise<ProviderRefund> {
    assertResourceId(refundId, 'refundId');
    let refund;
    try {
      refund = await client.send(
        refundSchema,
        { method: 'GET', path: `/v3/refunds/${refundId}` },
        // Mapped inside `send` so a malformed response is reported as such.
        (data, raw) => mapRefund(data, data.payment_id, raw),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new RefundError(`Refund "${refundId}" was not found.`, {
          ...providerFields(error),
          code: 'refund_not_found',
          cause: error,
        });
      }
      throw error;
    }

    // A refund references the Payment (`py-...`). CulGate payment IDs are
    // Payment Request IDs, so resolve the request the payment belongs to.
    const providerPaymentId = refund.paymentId;
    assertResourceId(providerPaymentId, 'payment id');
    const paymentRequestId = await client.send(
      paymentSchema,
      { method: 'GET', path: `/v3/payments/${providerPaymentId}` },
      (data) => data.payment_request_id ?? providerPaymentId,
    );
    return { ...refund, paymentId: paymentRequestId };
  }

  return {
    capabilities: createStaticCapabilities({
      operations,
      currencies: [
        ...new Set([
          ...Object.values(PAYMENT_METHODS).map((channel) => channel.currency),
          ...CHECKOUT_CURRENCIES,
        ]),
      ],
      paymentMethods: {
        'payments.create': Object.keys(PAYMENT_METHODS),
        'checkout.create': Object.keys(CHECKOUT_PAYMENT_METHODS),
      },
    }),
    payments: {
      create: createPayment,
      async retrieve({ paymentId }) {
        return (await retrieveRequest(paymentId)).payment;
      },
      async cancel({ paymentId }) {
        assertResourceId(paymentId, 'paymentId');
        try {
          return await client.send(
            paymentRequestSchema,
            { method: 'POST', path: `/v3/payment_requests/${paymentId}/cancel` },
            mapPaymentRequest,
          );
        } catch (error) {
          throw asPaymentNotFound(error, paymentId);
        }
      },
    },
    refunds: {
      create: createRefund,
      retrieve: ({ refundId }) => retrieveRefund(refundId),
    },
    checkout: createXenditCheckout(client),
    provider: { request: createProviderRequest(client.http) },
    ...(webhookToken !== undefined && { webhooks: createXenditWebhooks(webhookToken) }),
  };
}

/** IDs are interpolated into request paths, so they must be plain tokens. */
function assertResourceId(value: string, path: string): void {
  if (typeof value !== 'string' || !RESOURCE_ID_PATTERN.test(value)) {
    throw invalid(path, 'Not a valid Xendit resource ID.');
  }
}

function isNotFound(error: unknown): error is ProviderError {
  return (
    error instanceof ProviderError &&
    (error.httpStatus === 404 || error.providerCode === 'DATA_NOT_FOUND')
  );
}

function providerFields(error: ProviderError) {
  return {
    ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
    ...(error.providerCode !== undefined && { providerCode: error.providerCode }),
    ...(error.requestId !== undefined && { requestId: error.requestId }),
  };
}

function asPaymentNotFound(error: unknown, paymentId: string): unknown {
  if (!isNotFound(error)) return error;
  return new PaymentNotFoundError(`Payment "${paymentId}" was not found.`, {
    ...providerFields(error),
    cause: error,
  });
}

/** Wraps a Xendit rejection of a refund, leaving auth/rate-limit errors as they are. */
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
