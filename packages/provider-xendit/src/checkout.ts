import { randomUUID } from 'node:crypto';
import type {
  CheckoutOperations,
  CheckoutSessionStatus,
  ProviderCheckoutCreateInput,
  ProviderCheckoutSession,
} from '@culgate/core';
import { fromDecimal, ProviderError } from '@culgate/core';
import { z } from 'zod';
import type { XenditClient } from './client.js';
import {
  GENERATED_REFERENCE_PREFIX,
  invalid,
  toXenditAmount,
  toXenditMetadata,
} from './mappers.js';

/** CulGate payment method -> Xendit channel code for `allowed_payment_channels`. */
export const CHECKOUT_PAYMENT_METHODS: Readonly<Record<string, string>> = Object.freeze({
  card: 'CARDS',
  gcash: 'GCASH',
  maya: 'PAYMAYA',
  grabpay: 'GRABPAY',
  shopeepay: 'SHOPEEPAY',
  qrph: 'QRPH',
});

/** Currencies offered for checkout, with the country Xendit requires alongside. */
const COUNTRY_BY_CURRENCY: Readonly<Record<string, string>> = { PHP: 'PH' };
export const CHECKOUT_CURRENCIES = Object.keys(COUNTRY_BY_CURRENCY);

const MAX_REFERENCE_LENGTH = 64;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const STATUS: Readonly<Record<string, CheckoutSessionStatus>> = {
  ACTIVE: 'open',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  CANCELED: 'cancelled',
};

const sessionSchema = z.object({
  payment_session_id: z.string(),
  status: z.string(),
  reference_id: z.string().nullish(),
  payment_link_url: z.string().nullish(),
  amount: z.number().nullish(),
  currency: z.string().nullish(),
  payment_request_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  expires_at: z.string().nullish(),
  created: z.string().nullish(),
});

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function mapSession(session: z.infer<typeof sessionSchema>, raw: unknown): ProviderCheckoutSession {
  const reference = session.reference_id ?? undefined;
  const createdAt = toDate(session.created);
  const expiresAt = toDate(session.expires_at);
  const metadata = session.metadata ?? undefined;
  const hasAmount = typeof session.amount === 'number' && typeof session.currency === 'string';
  return {
    id: session.payment_session_id,
    providerSessionId: session.payment_session_id,
    status: Object.hasOwn(STATUS, session.status) ? STATUS[session.status]! : 'unknown',
    providerStatus: session.status,
    ...(session.payment_link_url && { url: session.payment_link_url }),
    // Throws on an amount with too many decimals; the client reports that as
    // an invalid provider response.
    ...(hasAmount && { amount: fromDecimal(session.amount!, session.currency!, 'amount') }),
    ...(reference !== undefined &&
      !reference.startsWith(GENERATED_REFERENCE_PREFIX) && { reference }),
    // CulGate payment IDs for Xendit are Payment Request IDs.
    ...(session.payment_request_id && { paymentId: session.payment_request_id }),
    ...(metadata && Object.keys(metadata).length > 0 && { metadata }),
    ...(createdAt && { createdAt }),
    ...(expiresAt && { expiresAt }),
    raw,
  };
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw invalid('sessionId', 'Not a valid Xendit resource ID.');
  }
}

function asSessionNotFound(error: unknown, sessionId: string): unknown {
  const notFound =
    error instanceof ProviderError &&
    (error.httpStatus === 404 ||
      error.providerCode === 'NOT_FOUND' ||
      error.providerCode === 'DATA_NOT_FOUND');
  if (!notFound) return error;
  return new ProviderError(`Checkout session "${sessionId}" was not found.`, {
    code: 'checkout_session_not_found',
    cause: error,
    ...(error.httpStatus !== undefined && { httpStatus: error.httpStatus }),
    ...(error.providerCode !== undefined && { providerCode: error.providerCode }),
  });
}

/** Xendit requires HTTPS return URLs for sessions. */
function httpsUrl(value: string | undefined, path: string): string | undefined {
  if (value !== undefined && new URL(value).protocol !== 'https:') {
    throw invalid(path, 'Xendit requires an https URL.');
  }
  return value;
}

/**
 * Hosted checkout through Xendit Payment Sessions (`mode: PAYMENT_LINK`).
 * The Sessions API takes no `api-version` header.
 */
export function createXenditCheckout(client: XenditClient): CheckoutOperations {
  const unversioned = { apiVersion: false } as const;

  async function create(input: ProviderCheckoutCreateInput): Promise<ProviderCheckoutSession> {
    const { currency } = input.total;
    const country = Object.hasOwn(COUNTRY_BY_CURRENCY, currency)
      ? COUNTRY_BY_CURRENCY[currency]
      : undefined;
    if (!country) throw invalid('lineItems', `Xendit checkout does not support ${currency}.`);
    if (input.reference !== undefined && input.reference.length > MAX_REFERENCE_LENGTH) {
      throw invalid('reference', `Must be at most ${MAX_REFERENCE_LENGTH} characters for Xendit.`);
    }
    const channels = input.paymentMethods?.map((method, index) => {
      if (!Object.hasOwn(CHECKOUT_PAYMENT_METHODS, method)) {
        throw invalid(`paymentMethods.${index}`, 'Not supported by Xendit checkout.');
      }
      return CHECKOUT_PAYMENT_METHODS[method]!;
    });
    const successUrl = httpsUrl(input.returnUrls?.success, 'returnUrls.success');
    const cancelUrl = httpsUrl(input.returnUrls?.cancel, 'returnUrls.cancel');
    const metadata = toXenditMetadata(input.metadata);

    return client.send(
      sessionSchema,
      {
        method: 'POST',
        path: '/sessions',
        // Never retried: Xendit documents no idempotency mechanism here.
        body: {
          reference_id: input.reference ?? `${GENERATED_REFERENCE_PREFIX}${randomUUID()}`,
          session_type: 'PAY',
          mode: 'PAYMENT_LINK',
          amount: toXenditAmount(input.total, 'lineItems'),
          currency,
          country,
          // Line items are not sent: Xendit requires a product type and
          // category per item, which CulGate does not model. Only the total
          // and description reach the hosted page.
          ...(input.description !== undefined && { description: input.description }),
          // Omitted means every channel activated on the account.
          ...(channels && { allowed_payment_channels: channels }),
          ...(successUrl !== undefined && { success_return_url: successUrl }),
          ...(cancelUrl !== undefined && { cancel_return_url: cancelUrl }),
          ...(metadata && { metadata }),
        },
      },
      mapSession,
      unversioned,
    );
  }

  return {
    create,
    async retrieve({ sessionId }) {
      assertSessionId(sessionId);
      try {
        return await client.send(
          sessionSchema,
          { method: 'GET', path: `/sessions/${sessionId}` },
          mapSession,
          unversioned,
        );
      } catch (error) {
        throw asSessionNotFound(error, sessionId);
      }
    },
    async expire({ sessionId }) {
      assertSessionId(sessionId);
      try {
        return await client.send(
          sessionSchema,
          { method: 'POST', path: `/sessions/${sessionId}/cancel` },
          mapSession,
          unversioned,
        );
      } catch (error) {
        throw asSessionNotFound(error, sessionId);
      }
    },
  };
}
