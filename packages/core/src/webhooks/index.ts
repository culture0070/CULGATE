import { WebhookVerificationError } from '../errors/index.js';
import type { Money } from '../money/index.js';

/** Canonical event names. Anything CulGate cannot classify is `provider.unknown`. */
export const WEBHOOK_EVENT_TYPES = [
  'payment.pending',
  'payment.requires_action',
  'payment.processing',
  'payment.succeeded',
  'payment.failed',
  'payment.cancelled',
  'payment.expired',
  'refund.pending',
  'refund.succeeded',
  'refund.failed',
  'checkout.completed',
  'checkout.expired',
  'provider.unknown',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** `data` of `payment.*` events. */
export interface WebhookPaymentData {
  /** CulGate payment ID, usable with `payments.retrieve` on the same account. */
  paymentId: string;
  amount?: Money;
  /** The provider's status for the resource in the event, verbatim. */
  providerStatus?: string;
}

/** `data` of `refund.*` events. */
export interface WebhookRefundData {
  refundId: string;
  /**
   * The provider's identifier for the refunded payment as it appears in the
   * event. This is not always a CulGate payment ID; see the provider guide.
   */
  providerPaymentId?: string;
  amount?: Money;
  providerStatus?: string;
}

/** `data` of `checkout.*` events. */
export interface WebhookCheckoutData {
  /** CulGate checkout session ID, usable with `checkout.retrieve`. */
  sessionId: string;
  /** CulGate payment ID of the payment made, when the event carries it. */
  paymentId?: string;
  reference?: string;
  amount?: Money;
  providerStatus?: string;
}

/**
 * A verified, normalized webhook event.
 *
 * An event describes the resource at the time the event was created. Events
 * can be delivered more than once and out of order, so treat an event as a
 * prompt to retrieve the current state, not as the current state itself.
 */
export interface CulGateWebhookEvent<TData = unknown> {
  /** Provider event ID, when the provider supplies a stable one. */
  id?: string;
  accountId: string;
  provider: string;
  type: WebhookEventType;
  /** ID of the payment or refund the event is about, when known. */
  resourceId?: string;
  occurredAt?: Date;
  data: TData;
  /** The provider's original event type, verbatim. */
  providerEventType: string;
  /** The parsed provider payload, unmodified. */
  raw: unknown;
}

/** Adapters return events without ownership fields; the SDK stamps them. */
export type ProviderWebhookEvent = Omit<CulGateWebhookEvent, 'accountId' | 'provider'>;

export type WebhookHeaders =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface WebhookRequest {
  /**
   * The request body exactly as received. Signatures are computed over these
   * bytes: a parsed-and-reserialized body will not verify.
   */
  rawBody: string | Uint8Array;
  headers: WebhookHeaders;
}

export interface WebhookOperations {
  /**
   * Authenticates the request using the provider's documented mechanism.
   * Must throw `WebhookVerificationError` when it cannot be authenticated.
   */
  verify(request: WebhookRequest): void | Promise<void>;
  /** Parses and normalizes a request. Called only after `verify` succeeded. */
  normalize(request: WebhookRequest): ProviderWebhookEvent | Promise<ProviderWebhookEvent>;
}

/**
 * Application-supplied store used to process each event at most once per
 * successful claim. CulGate does not provide exactly-once delivery: the
 * guarantee is only as strong as this store's atomicity and durability.
 */
export interface WebhookEventStore {
  /**
   * Atomically claims an event for processing. Must return `true` for exactly
   * one caller among concurrent claims of the same event, and `false` for an
   * event that is being processed or was completed. An implementation should
   * let a claim be retaken after `markFailed`, or after it has been held
   * longer than a processing timeout (the worker may have crashed).
   */
  claim(input: WebhookEventKey): Promise<boolean>;
  markCompleted(input: WebhookEventKey): Promise<void>;
  markFailed?(input: WebhookEventKey & { error?: unknown }): Promise<void>;
}

export interface WebhookEventKey {
  accountId: string;
  provider: string;
  eventId: string;
}

/** Case-insensitive header lookup. Repeated headers are joined with ", ". */
export function getWebhookHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

/** The exact bytes of the body, for signature computation. */
export function webhookBodyBytes(rawBody: string | Uint8Array): Uint8Array {
  if (typeof rawBody === 'string') return new TextEncoder().encode(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  throw new WebhookVerificationError(
    'Webhook verification needs the raw request body (string or bytes), not a parsed object.',
    { code: 'raw_body_required' },
  );
}

/** Decodes the body as strict UTF-8 text. */
export function webhookBodyText(rawBody: string | Uint8Array): string {
  if (typeof rawBody === 'string') return rawBody;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(webhookBodyBytes(rawBody));
  } catch (cause) {
    if (cause instanceof WebhookVerificationError) throw cause;
    throw new WebhookVerificationError('Webhook body is not valid UTF-8.', {
      code: 'invalid_payload',
      cause,
    });
  }
}

/** Parses the body as a JSON object, or throws `WebhookVerificationError`. */
export function parseWebhookJson(rawBody: string | Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(webhookBodyText(rawBody));
  } catch (cause) {
    if (cause instanceof WebhookVerificationError) throw cause;
    throw new WebhookVerificationError('Webhook body is not valid JSON.', {
      code: 'invalid_payload',
      cause,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WebhookVerificationError('Webhook body is not a JSON object.', {
      code: 'invalid_payload',
    });
  }
  return parsed as Record<string, unknown>;
}
