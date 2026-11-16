import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  Money,
  ProviderWebhookEvent,
  WebhookCheckoutData,
  WebhookOperations,
  WebhookPaymentData,
  WebhookRefundData,
  WebhookRequest,
} from '@culgate/core';
import {
  getWebhookHeader,
  parseWebhookJson,
  webhookBodyBytes,
  WebhookVerificationError,
} from '@culgate/core';
import { z } from 'zod';
import type { PayMongoAccountConfig } from './config.js';

export const PAYMONGO_SIGNATURE_HEADER = 'Paymongo-Signature';

export interface PayMongoWebhookOptions {
  /**
   * Reject events whose signature timestamp is further than this from the
   * current time. Off by default: PayMongo recommends the check but documents
   * neither a tolerance nor whether retried deliveries carry a new timestamp.
   */
  timestampToleranceSeconds?: number;
  /** Test seam. */
  now?: () => number;
}

const eventSchema = z.object({
  data: z.object({
    id: z.string(),
    attributes: z.object({
      type: z.string(),
      livemode: z.boolean().nullish(),
      created_at: z.number().nullish(),
      data: z
        .object({
          id: z.string(),
          attributes: z.record(z.string(), z.unknown()).nullish(),
        })
        .nullish(),
    }),
  }),
});

const REFUND_EVENT_TYPE = {
  pending: 'refund.pending',
  processing: 'refund.pending',
  succeeded: 'refund.succeeded',
  failed: 'refund.failed',
} as const;

export function createPayMongoWebhooks(
  config: PayMongoAccountConfig & { webhookSecret: string },
  options: PayMongoWebhookOptions = {},
): WebhookOperations {
  const live = config.environment === 'live';
  const now = options.now ?? Date.now;

  return {
    /**
     * `Paymongo-Signature: t=<timestamp>,te=<test signature>,li=<live signature>`.
     * The signature is HMAC-SHA256, keyed with the webhook's secret, over
     * `<timestamp>.<raw body>`. `te` applies in test mode and `li` in live mode.
     */
    verify(request: WebhookRequest): void {
      const header = getWebhookHeader(request.headers, PAYMONGO_SIGNATURE_HEADER);
      if (!header) throw rejected('missing_signature', 'Missing Paymongo-Signature header.');

      const parts = new Map<string, string>();
      for (const segment of header.split(',')) {
        const separator = segment.indexOf('=');
        if (separator > 0) {
          parts.set(segment.slice(0, separator).trim(), segment.slice(separator + 1).trim());
        }
      }
      const timestamp = parts.get('t');
      if (!timestamp || !/^\d{1,15}$/.test(timestamp)) {
        throw rejected('invalid_signature', 'Malformed Paymongo-Signature header.');
      }
      const received = parts.get(live ? 'li' : 'te');
      if (!received) {
        throw rejected(
          'invalid_signature',
          `The request carries no ${live ? 'live' : 'test'}-mode signature for this account.`,
        );
      }

      const expected = createHmac('sha256', config.webhookSecret)
        .update(`${timestamp}.`)
        .update(webhookBodyBytes(request.rawBody))
        .digest();
      // A non-hex or wrong-length value can never match; comparing only
      // equal-length buffers keeps the comparison constant-time.
      const actual = /^[0-9a-fA-F]{64}$/.test(received) ? Buffer.from(received, 'hex') : undefined;
      if (!actual || !timingSafeEqual(actual, expected)) {
        throw rejected('invalid_signature', 'Webhook signature does not match.');
      }

      const tolerance = options.timestampToleranceSeconds;
      if (tolerance !== undefined && Math.abs(now() / 1000 - Number(timestamp)) > tolerance) {
        throw rejected('timestamp_out_of_tolerance', 'Webhook timestamp is outside the tolerance.');
      }
    },

    normalize(request: WebhookRequest): ProviderWebhookEvent {
      const payload = parseWebhookJson(request.rawBody);
      const parsed = eventSchema.safeParse(payload);
      if (!parsed.success) {
        // Authentic but not in the documented envelope: keep it observable.
        return { type: 'provider.unknown', providerEventType: 'unknown', data: {}, raw: payload };
      }

      const { id, attributes } = parsed.data.data;
      if (typeof attributes.livemode === 'boolean' && attributes.livemode !== live) {
        throw rejected('livemode_mismatch', 'Event mode does not match the account environment.');
      }
      const base = {
        id,
        providerEventType: attributes.type,
        raw: payload,
        ...(typeof attributes.created_at === 'number' && {
          occurredAt: new Date(attributes.created_at * 1000),
        }),
      };
      const resource = attributes.data;
      const fields = resource?.attributes ?? {};
      const amount = toMoney(fields['amount'], fields['currency']);
      const providerStatus = typeof fields['status'] === 'string' ? fields['status'] : undefined;

      if (
        resource &&
        (attributes.type === 'payment.paid' || attributes.type === 'payment.failed')
      ) {
        // CulGate payment IDs are Payment Intent IDs. Payments made outside
        // the intent flow have none, so fall back to the Payment's own ID.
        const intentId = fields['payment_intent_id'];
        const paymentId = typeof intentId === 'string' && intentId ? intentId : resource.id;
        const data: WebhookPaymentData = {
          paymentId,
          ...(amount && { amount }),
          ...(providerStatus !== undefined && { providerStatus }),
        };
        return {
          ...base,
          type: attributes.type === 'payment.paid' ? 'payment.succeeded' : 'payment.failed',
          resourceId: paymentId,
          data,
        };
      }

      if (resource && attributes.type === 'checkout_session.payment.paid') {
        const payments = Array.isArray(fields['payments']) ? fields['payments'] : [];
        const paid = payments
          .map(
            (payment) => (payment as { attributes?: Record<string, unknown> } | null)?.attributes,
          )
          .find((payment) => payment?.['status'] === 'paid');
        const intent = fields['payment_intent'] as { id?: unknown } | null | undefined;
        const paymentId =
          typeof paid?.['payment_intent_id'] === 'string'
            ? paid['payment_intent_id']
            : typeof intent?.id === 'string'
              ? intent.id
              : undefined;
        const reference = fields['reference_number'];
        const paidAmount = toMoney(paid?.['amount'], paid?.['currency']);
        const data: WebhookCheckoutData = {
          sessionId: resource.id,
          ...(paymentId !== undefined && { paymentId }),
          ...(typeof reference === 'string' && reference && { reference }),
          ...(paidAmount && { amount: paidAmount }),
          ...(providerStatus !== undefined && { providerStatus }),
        };
        return { ...base, type: 'checkout.completed', resourceId: resource.id, data };
      }

      if (resource && attributes.type === 'payment.refund.updated') {
        const type =
          providerStatus !== undefined && Object.hasOwn(REFUND_EVENT_TYPE, providerStatus)
            ? REFUND_EVENT_TYPE[providerStatus as keyof typeof REFUND_EVENT_TYPE]
            : undefined;
        if (type) {
          const providerPaymentId = fields['payment_id'];
          const data: WebhookRefundData = {
            refundId: resource.id,
            ...(typeof providerPaymentId === 'string' && { providerPaymentId }),
            ...(amount && { amount }),
            ...(providerStatus !== undefined && { providerStatus }),
          };
          return { ...base, type, resourceId: resource.id, data };
        }
      }

      return { ...base, type: 'provider.unknown', data: {} };
    },
  };
}

function toMoney(amount: unknown, currency: unknown): Money | undefined {
  return typeof amount === 'number' && Number.isSafeInteger(amount) && typeof currency === 'string'
    ? { value: amount, currency }
    : undefined;
}

function rejected(code: string, message: string): WebhookVerificationError {
  return new WebhookVerificationError(message, { code, provider: 'paymongo' });
}
