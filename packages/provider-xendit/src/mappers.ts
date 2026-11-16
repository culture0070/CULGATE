import type {
  Money,
  PaymentStatus,
  ProviderPayment,
  ProviderRefund,
  RefundStatus,
} from '@culgate/core';
import { fromDecimal, toDecimalString, ValidationError } from '@culgate/core';
import type { XenditPaymentRequest, XenditRefund } from './schemas.js';

/** Prefix of reference IDs CulGate generates when the caller supplies none. */
export const GENERATED_REFERENCE_PREFIX = 'culgate-';
/** Metadata key holding a free-text refund reason. */
export const REASON_METADATA_KEY = 'culgate_reason';

interface Channel {
  readonly channelCode: string;
  readonly currency: string;
  readonly country: string;
}

/**
 * CulGate payment method type -> Xendit channel. Limited to redirect
 * e-wallets whose request shape Xendit documents with an example.
 * See docs/providers/xendit.md for why others are excluded.
 */
export const PAYMENT_METHODS: Readonly<Record<string, Channel>> = Object.freeze({
  gcash: { channelCode: 'GCASH', currency: 'PHP', country: 'PH' },
  shopeepay: { channelCode: 'SHOPEEPAY', currency: 'PHP', country: 'PH' },
});

const CULGATE_METHOD_BY_CHANNEL = new Map(
  Object.entries(PAYMENT_METHODS).map(([type, channel]) => [channel.channelCode, type]),
);

const PAYMENT_STATUS: Readonly<Record<string, PaymentStatus>> = {
  ACCEPTING_PAYMENTS: 'pending',
  PENDING: 'pending',
  REQUIRES_ACTION: 'requires_action',
  AUTHORIZED: 'authorized',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'cancelled',
  EXPIRED: 'expired',
};

const REFUND_STATUS: Readonly<Record<string, RefundStatus>> = {
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

export function mapPaymentStatus(status: string): PaymentStatus {
  return Object.hasOwn(PAYMENT_STATUS, status) ? PAYMENT_STATUS[status]! : 'unknown';
}

export function mapRefundStatus(status: string): RefundStatus {
  return Object.hasOwn(REFUND_STATUS, status) ? REFUND_STATUS[status]! : 'unknown';
}

/**
 * Xendit amounts are JSON numbers in major units (PHP 1,500.50 is `1500.5`).
 * The conversion goes through a decimal string and is verified to round-trip,
 * so no amount is ever silently altered.
 */
export function toXenditAmount(money: Money, path = 'amount'): number {
  const amount = Number(toDecimalString(money));
  if (fromDecimal(amount, money.currency, path).value !== money.value) {
    throw invalid(path, 'Amount cannot be represented exactly for Xendit.');
  }
  return amount;
}

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function mapPaymentRequest(request: XenditPaymentRequest, raw: unknown): ProviderPayment {
  const reference = request.reference_id ?? undefined;
  const channelCode = request.channel_code ?? undefined;
  const checkoutUrl = request.actions?.find(
    (action) => action.type === 'REDIRECT_CUSTOMER' && action.descriptor === 'WEB_URL',
  )?.value;
  const createdAt = toDate(request.created);
  const updatedAt = toDate(request.updated);
  const metadata = request.metadata ?? undefined;

  return {
    id: request.payment_request_id,
    providerPaymentId: request.payment_request_id,
    // Throws ValidationError on an amount with too many decimals; the client
    // reports that as an invalid provider response.
    amount: fromDecimal(request.request_amount, request.currency, 'request_amount'),
    status: mapPaymentStatus(request.status),
    providerStatus: request.status,
    ...(reference !== undefined &&
      !reference.startsWith(GENERATED_REFERENCE_PREFIX) && { reference }),
    ...(channelCode !== undefined && {
      paymentMethod: {
        type: CULGATE_METHOD_BY_CHANNEL.get(channelCode) ?? channelCode,
        providerType: channelCode,
      },
    }),
    ...(checkoutUrl && { checkoutUrl }),
    ...(metadata && Object.keys(metadata).length > 0 && { metadata }),
    ...(createdAt && { createdAt }),
    ...(updatedAt && { updatedAt }),
    raw,
  };
}

export function mapRefund(refund: XenditRefund, paymentId: string, raw: unknown): ProviderRefund {
  const createdAt = toDate(refund.created);
  const freeText = refund.metadata?.[REASON_METADATA_KEY];
  const reason = typeof freeText === 'string' ? freeText : (refund.reason ?? undefined);
  return {
    id: refund.refund_id,
    providerRefundId: refund.refund_id,
    paymentId,
    amount: fromDecimal(refund.amount, refund.currency, 'amount'),
    status: mapRefundStatus(refund.status),
    providerStatus: refund.status,
    ...(reason !== undefined && { reason }),
    ...(createdAt && { createdAt }),
    raw,
  };
}

const MAX_METADATA_KEYS = 50;
const MAX_METADATA_KEY_LENGTH = 40;
const MAX_METADATA_VALUE_LENGTH = 500;

/** Xendit metadata: up to 50 keys of at most 40 characters, primitive values up to 500. */
export function toXenditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_METADATA_KEYS) {
    throw invalid('metadata', `Xendit accepts at most ${MAX_METADATA_KEYS} metadata keys.`);
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of entries) {
    const path = `metadata.${key}`;
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      throw invalid(path, `Key must be at most ${MAX_METADATA_KEY_LENGTH} characters.`);
    }
    const primitive =
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!primitive) throw invalid(path, 'Xendit accepts only string, number, boolean or null.');
    if (String(value).length > MAX_METADATA_VALUE_LENGTH) {
      throw invalid(path, `Value must be at most ${MAX_METADATA_VALUE_LENGTH} characters.`);
    }
    result[key] = value as string | number | boolean | null;
  }
  return result;
}

export function invalid(path: string, message: string): ValidationError {
  return new ValidationError(`Invalid ${path}: ${message}`, {
    provider: 'xendit',
    issues: [{ path, message }],
  });
}
