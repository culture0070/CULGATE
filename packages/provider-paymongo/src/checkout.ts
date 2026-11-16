import type {
  CheckoutOperations,
  CheckoutSessionStatus,
  ProviderCheckoutCreateInput,
  ProviderCheckoutSession,
} from '@culgate/core';
import { ProviderError } from '@culgate/core';
import { z } from 'zod';
import type { PayMongoClient } from './client.js';
import { hasProviderCode } from './client.js';
import { invalid, toPayMongoMetadata } from './mappers.js';

/**
 * CulGate payment method -> Checkout Session `payment_method_types` value.
 *
 * PayMongo does not validate this list (the sandbox accepts any string), so a
 * wrong value would silently offer nothing. Every value here is a payment
 * method name PayMongo's Payment Intent API accepts.
 */
export const CHECKOUT_PAYMENT_METHODS: Readonly<Record<string, string>> = Object.freeze({
  card: 'card',
  gcash: 'gcash',
  maya: 'paymaya',
  grabpay: 'grab_pay',
  shopeepay: 'shopee_pay',
  billease: 'billease',
  qrph: 'qrph',
});

/** Offered when the caller chooses none: the set in PayMongo's hosted-checkout guide. */
const DEFAULT_CHECKOUT_METHODS = ['card', 'gcash', 'qrph'];

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_]{1,128}$/;
const timestamp = z.number().nullish();

/** `POST /v2/checkout_sessions` returns only these attributes. */
const createResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({ checkout_url: z.string(), created_at: timestamp }),
  }),
});

const sessionResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({
      status: z.string().nullish(),
      checkout_url: z.string().nullish(),
      reference_number: z.string().nullish(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
      line_items: z
        .array(
          z.object({
            amount: z.number().int().nullish(),
            quantity: z.number().int().nullish(),
            currency: z.string().nullish(),
          }),
        )
        .nullish(),
      payments: z
        .array(
          z.object({
            id: z.string(),
            attributes: z
              .object({ status: z.string().nullish(), payment_intent_id: z.string().nullish() })
              .default({}),
          }),
        )
        .nullish(),
      payment_intent: z.object({ id: z.string() }).nullish(),
      created_at: timestamp,
    }),
  }),
});

type SessionResponse = z.infer<typeof sessionResponseSchema>['data'];

/**
 * A PayMongo session is only ever `active` or `expired`; whether it was paid
 * is told by its payments. At most one payment per session is `paid`.
 */
function mapSession(session: SessionResponse, raw: unknown): ProviderCheckoutSession {
  const { attributes } = session;
  const paid = (attributes.payments ?? []).find((payment) => payment.attributes.status === 'paid');
  const status: CheckoutSessionStatus = paid
    ? 'completed'
    : attributes.status === 'active'
      ? 'open'
      : attributes.status === 'expired'
        ? 'expired'
        : 'unknown';

  // CulGate payment IDs for PayMongo are Payment Intent IDs.
  const paymentId = paid
    ? (paid.attributes.payment_intent_id ?? attributes.payment_intent?.id)
    : undefined;

  const items = attributes.line_items ?? [];
  const currency = items[0]?.currency ?? undefined;
  const complete =
    items.length > 0 &&
    currency !== undefined &&
    items.every(
      (item) =>
        typeof item.amount === 'number' &&
        typeof item.quantity === 'number' &&
        item.currency === currency,
    );
  const total = complete
    ? items.reduce((sum, item) => sum + item.amount! * item.quantity!, 0)
    : undefined;

  const metadata = attributes.metadata ?? undefined;
  return {
    id: session.id,
    providerSessionId: session.id,
    status,
    ...(attributes.status && { providerStatus: attributes.status }),
    ...(attributes.checkout_url && { url: attributes.checkout_url }),
    ...(total !== undefined &&
      Number.isSafeInteger(total) && { amount: { value: total, currency: currency! } }),
    ...(attributes.reference_number && { reference: attributes.reference_number }),
    ...(paymentId && { paymentId }),
    ...(metadata && Object.keys(metadata).length > 0 && { metadata }),
    ...(typeof attributes.created_at === 'number' && {
      createdAt: new Date(attributes.created_at * 1000),
    }),
    raw,
  };
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !RESOURCE_ID_PATTERN.test(sessionId)) {
    throw invalid('sessionId', 'Not a valid PayMongo resource ID.');
  }
}

function asSessionNotFound(error: unknown, sessionId: string): unknown {
  const notFound =
    error instanceof ProviderError &&
    (error.httpStatus === 404 ||
      hasProviderCode(error, 'resource_not_found') ||
      hasProviderCode(error, 'not_found'));
  if (!notFound) return error;
  return new ProviderError(`Checkout session "${sessionId}" was not found.`, {
    code: 'checkout_session_not_found',
    cause: error,
    ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
    ...(error.providerCode !== undefined && { providerCode: error.providerCode }),
  });
}

export function createPayMongoCheckout(client: PayMongoClient): CheckoutOperations {
  async function create(input: ProviderCheckoutCreateInput): Promise<ProviderCheckoutSession> {
    // `payment_method_types` is required by PayMongo, so a default is needed
    // when the caller does not choose.
    const methods = input.paymentMethods ?? DEFAULT_CHECKOUT_METHODS;
    const types = methods.map((method, index) => {
      if (!Object.hasOwn(CHECKOUT_PAYMENT_METHODS, method)) {
        throw invalid(`paymentMethods.${index}`, 'Not supported by PayMongo checkout.');
      }
      return CHECKOUT_PAYMENT_METHODS[method]!;
    });
    const metadata = toPayMongoMetadata(input.metadata, undefined);

    const created = await client.send(createResponseSchema, {
      method: 'POST',
      path: '/v2/checkout_sessions',
      body: {
        data: {
          attributes: {
            line_items: input.lineItems.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              amount: item.amount.value, // per unit, in centavos
              currency: item.amount.currency,
              ...(item.description !== undefined && { description: item.description }),
            })),
            payment_method_types: types,
            ...(input.returnUrls?.success !== undefined && {
              success_url: input.returnUrls.success,
            }),
            ...(input.returnUrls?.cancel !== undefined && { cancel_url: input.returnUrls.cancel }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.reference !== undefined && { reference_number: input.reference }),
            ...(metadata && { metadata }),
          },
        },
      },
      // Sent as documented, but PayMongo's sandbox was observed to ignore it
      // (the same key created two sessions), so nothing is retried.
      ...(input.idempotencyKey !== undefined && {
        headers: { 'idempotency-key': input.idempotencyKey },
      }),
    });

    const { id, attributes } = created.data.data;
    // The v2 create response carries only the URL and timestamps; the rest is
    // what was just sent.
    return {
      id,
      providerSessionId: id,
      url: attributes.checkout_url,
      status: 'open',
      amount: { ...input.total },
      ...(input.reference !== undefined && { reference: input.reference }),
      ...(input.metadata &&
        Object.keys(input.metadata).length > 0 && { metadata: { ...input.metadata } }),
      ...(typeof attributes.created_at === 'number' && {
        createdAt: new Date(attributes.created_at * 1000),
      }),
      raw: created.raw,
    };
  }

  return {
    create,
    async retrieve({ sessionId }) {
      assertSessionId(sessionId);
      try {
        const session = await client.send(sessionResponseSchema, {
          method: 'GET',
          path: `/v1/checkout_sessions/${sessionId}`,
        });
        return mapSession(session.data.data, session.raw);
      } catch (error) {
        throw asSessionNotFound(error, sessionId);
      }
    },
    async expire({ sessionId }) {
      assertSessionId(sessionId);
      try {
        const session = await client.send(sessionResponseSchema, {
          method: 'POST',
          path: `/v1/checkout_sessions/${sessionId}/expire`,
        });
        return mapSession(session.data.data, session.raw);
      } catch (error) {
        throw asSessionNotFound(error, sessionId);
      }
    },
  };
}
