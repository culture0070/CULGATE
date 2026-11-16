import { createHash, timingSafeEqual } from 'node:crypto';
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
  fromDecimal,
  getWebhookHeader,
  parseWebhookJson,
  WebhookVerificationError,
} from '@culgate/core';
import { z } from 'zod';

export const XENDIT_CALLBACK_TOKEN_HEADER = 'x-callback-token';

const eventSchema = z.object({
  event: z.string(),
  created: z.string().nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
});

const PAYMENT_EVENT_TYPE = {
  'payment.capture': 'payment.succeeded',
  'payment.failure': 'payment.failed',
  'payment.expiry': 'payment.expired',
  'payment_request.expiry': 'payment.expired',
} as const;

const SESSION_EVENT_TYPE = {
  'payment_session.completed': 'checkout.completed',
  'payment_session.expired': 'checkout.expired',
} as const;

const REFUND_EVENT_TYPE = {
  'refund.succeeded': 'refund.succeeded',
  'refund.failed': 'refund.failed',
} as const;

export function createXenditWebhooks(webhookToken: string): WebhookOperations {
  // Compare fixed-length digests so neither content nor length leaks through timing.
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = digest(webhookToken);

  return {
    /**
     * Xendit authenticates Payments API webhooks with a shared token in the
     * `x-callback-token` header. There is no signature over the body, so the
     * token is the only proof of origin and the body is not tamper-evident.
     */
    verify(request: WebhookRequest): void {
      const received = getWebhookHeader(request.headers, XENDIT_CALLBACK_TOKEN_HEADER);
      if (!received) throw rejected('missing_signature', 'Missing x-callback-token header.');
      if (!timingSafeEqual(digest(received), expected)) {
        throw rejected('invalid_signature', 'Webhook token does not match.');
      }
    },

    normalize(request: WebhookRequest): ProviderWebhookEvent {
      const payload = parseWebhookJson(request.rawBody);
      const parsed = eventSchema.safeParse(payload);
      if (!parsed.success) {
        return { type: 'provider.unknown', providerEventType: 'unknown', data: {}, raw: payload };
      }

      const { event, created } = parsed.data;
      const data = parsed.data.data ?? {};
      const text = (key: string) => (typeof data[key] === 'string' ? data[key] : undefined);
      const occurredAt = created ? new Date(created) : undefined;
      const base = {
        providerEventType: event,
        raw: payload,
        ...(occurredAt && !Number.isNaN(occurredAt.getTime()) && { occurredAt }),
      };
      const providerStatus = text('status');
      const currency = text('currency');

      const sessionId = text('payment_session_id');
      if (Object.hasOwn(SESSION_EVENT_TYPE, event) && sessionId) {
        const amount = toMoney(data['amount'], currency);
        const reference = text('reference_id');
        const sessionPaymentId = text('payment_request_id');
        const eventData: WebhookCheckoutData = {
          sessionId,
          ...(sessionPaymentId !== undefined && { paymentId: sessionPaymentId }),
          ...(reference !== undefined && { reference }),
          ...(amount && { amount }),
          ...(providerStatus !== undefined && { providerStatus }),
        };
        return {
          ...base,
          // A session completes or expires once, so the session ID identifies the event.
          id: `${event}:${sessionId}`,
          type: SESSION_EVENT_TYPE[event as keyof typeof SESSION_EVENT_TYPE],
          resourceId: sessionId,
          data: eventData,
        };
      }

      const paymentRequestId = text('payment_request_id');
      if (Object.hasOwn(PAYMENT_EVENT_TYPE, event) && paymentRequestId) {
        const amount = toMoney(data['request_amount'], currency);
        const eventData: WebhookPaymentData = {
          paymentId: paymentRequestId,
          ...(amount && { amount }),
          ...(providerStatus !== undefined && { providerStatus }),
        };
        // Xendit sends no event ID. It documents `payment_id` and `capture_id`
        // as the fields that identify a unique payment event, so the ID is
        // built from those.
        const paymentId = text('payment_id');
        const captures = Array.isArray(data['captures']) ? data['captures'] : [];
        const captureId = (captures[0] as { capture_id?: unknown } | undefined)?.capture_id;
        const id = paymentId
          ? [event, paymentId, ...(typeof captureId === 'string' ? [captureId] : [])].join(':')
          : undefined;
        return {
          ...base,
          ...(id !== undefined && { id }),
          type: PAYMENT_EVENT_TYPE[event as keyof typeof PAYMENT_EVENT_TYPE],
          resourceId: paymentRequestId,
          data: eventData,
        };
      }

      const refundId = text('refund_id');
      if (Object.hasOwn(REFUND_EVENT_TYPE, event) && refundId) {
        const amount = toMoney(data['amount'], currency);
        const providerPaymentId = text('payment_id');
        const eventData: WebhookRefundData = {
          refundId,
          ...(providerPaymentId !== undefined && { providerPaymentId }),
          ...(amount && { amount }),
          ...(providerStatus !== undefined && { providerStatus }),
        };
        return {
          ...base,
          id: `${event}:${refundId}`,
          type: REFUND_EVENT_TYPE[event as keyof typeof REFUND_EVENT_TYPE],
          resourceId: refundId,
          data: eventData,
        };
      }

      return { ...base, type: 'provider.unknown', data: {} };
    },
  };
}

function toMoney(amount: unknown, currency: string | undefined): Money | undefined {
  if (typeof amount !== 'number' || currency === undefined) return undefined;
  try {
    return fromDecimal(amount, currency);
  } catch {
    // Unsupported currency or unexpected precision: leave the amount out; it
    // is still available in `raw`.
    return undefined;
  }
}

function rejected(code: string, message: string): WebhookVerificationError {
  return new WebhookVerificationError(message, { code, provider: 'xendit' });
}
