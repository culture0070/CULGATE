import type { PaymentStatus, ProviderPayment, ProviderRefund, RefundStatus } from '@culgate/core';
import { ValidationError } from '@culgate/core';
import type { PayMongoPaymentIntent, PayMongoRefund } from './schemas.js';

/** Metadata key under which CulGate stores the caller's `reference`. */
export const REFERENCE_METADATA_KEY = 'culgate_reference';

/**
 * CulGate payment method type -> PayMongo `type`. Only redirect-based methods
 * that can be created server-side with nothing but a `type` are listed.
 * See docs/providers/paymongo.md for why others are excluded.
 */
export const PAYMENT_METHODS: Readonly<Record<string, string>> = Object.freeze({
  // Each confirmed against the PayMongo sandbox on 2026-11-16.
  gcash: 'gcash',
  maya: 'paymaya',
  grabpay: 'grab_pay',
  shopeepay: 'shopee_pay',
  billease: 'billease',
});

const CULGATE_METHOD_BY_PROVIDER_TYPE = new Map(
  Object.entries(PAYMENT_METHODS).map(([culgate, provider]) => [provider, culgate]),
);

/**
 * Payment Intent status -> CulGate status. PayMongo has no `failed` intent
 * status: a failed attempt returns the intent to `awaiting_payment_method`,
 * which stays `pending` because the intent can still be paid.
 */
const PAYMENT_STATUS: Readonly<Record<string, PaymentStatus>> = {
  awaiting_payment_method: 'pending',
  awaiting_next_action: 'requires_action',
  processing: 'processing',
  awaiting_capture: 'authorized',
  succeeded: 'succeeded',
  cancelled: 'cancelled',
};

const REFUND_STATUS: Readonly<Record<string, RefundStatus>> = {
  pending: 'pending',
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
};

export function mapPaymentStatus(status: string): PaymentStatus {
  return Object.hasOwn(PAYMENT_STATUS, status) ? PAYMENT_STATUS[status]! : 'unknown';
}

export function mapRefundStatus(status: string): RefundStatus {
  return Object.hasOwn(REFUND_STATUS, status) ? REFUND_STATUS[status]! : 'unknown';
}

/** PayMongo timestamps are integers; examples are Unix seconds. */
function toDate(seconds: number | null | undefined): Date | undefined {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : undefined;
}

export function mapPaymentIntent(intent: PayMongoPaymentIntent, raw: unknown): ProviderPayment {
  const { attributes } = intent;
  const metadata = { ...(attributes.metadata ?? {}) };
  const reference = metadata[REFERENCE_METADATA_KEY];
  delete metadata[REFERENCE_METADATA_KEY];

  const allowed = attributes.payment_method_allowed ?? [];
  const providerType = allowed.length === 1 ? allowed[0] : undefined;
  const checkoutUrl = attributes.next_action?.redirect?.url;
  const createdAt = toDate(attributes.created_at);
  const updatedAt = toDate(attributes.updated_at);

  return {
    id: intent.id,
    providerPaymentId: intent.id,
    amount: { value: attributes.amount, currency: attributes.currency },
    status: mapPaymentStatus(attributes.status),
    providerStatus: attributes.status,
    ...(typeof reference === 'string' && { reference }),
    ...(providerType !== undefined && {
      paymentMethod: {
        type: CULGATE_METHOD_BY_PROVIDER_TYPE.get(providerType) ?? providerType,
        providerType,
      },
    }),
    ...(checkoutUrl && { checkoutUrl }),
    ...(Object.keys(metadata).length > 0 && { metadata }),
    ...(createdAt && { createdAt }),
    ...(updatedAt && { updatedAt }),
    raw,
  };
}

export function mapRefund(refund: PayMongoRefund, paymentId: string, raw: unknown): ProviderRefund {
  const { attributes } = refund;
  const createdAt = toDate(attributes.created_at);
  // CulGate's free-text reason is sent as `notes` when it is not a PayMongo
  // reason code, so prefer `notes` when the code is the generic fallback.
  const reason =
    attributes.reason === 'others' ? (attributes.notes ?? attributes.reason) : attributes.reason;
  return {
    id: refund.id,
    providerRefundId: refund.id,
    paymentId,
    amount: { value: attributes.amount, currency: attributes.currency },
    status: mapRefundStatus(attributes.status),
    providerStatus: attributes.status,
    ...(reason && { reason }),
    ...(createdAt && { createdAt }),
    raw,
  };
}

/**
 * PayMongo metadata accepts string values only and reserves keys starting
 * with `PYM_`. Values are never coerced silently.
 */
export function toPayMongoMetadata(
  metadata: Record<string, unknown> | undefined,
  reference: string | undefined,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (key.startsWith('PYM_') || key === REFERENCE_METADATA_KEY) {
      throw invalid(`metadata.${key}`, 'This metadata key is reserved.');
    }
    if (typeof value !== 'string') {
      throw invalid(`metadata.${key}`, 'PayMongo accepts only string metadata values.');
    }
    result[key] = value;
  }
  if (reference !== undefined) result[REFERENCE_METADATA_KEY] = reference;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function invalid(path: string, message: string): ValidationError {
  return new ValidationError(`Invalid ${path}: ${message}`, {
    provider: 'paymongo',
    issues: [{ path, message }],
  });
}
