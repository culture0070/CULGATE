import type { Money } from '../money/index.js';

/**
 * Normalized payment status.
 *
 * Only `succeeded` means the provider has confirmed payment success.
 * `pending`, `requires_action`, `processing`, and `authorized` are NOT success.
 * Unrecognized provider states map to `unknown`, never to a guess.
 */
export type PaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'processing'
  | 'authorized'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'partially_refunded'
  | 'refunded'
  | 'unknown';

export const PAYMENT_STATUSES = [
  'pending',
  'requires_action',
  'processing',
  'authorized',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'partially_refunded',
  'refunded',
  'unknown',
] as const satisfies readonly PaymentStatus[];

export interface PaymentMethodInfo {
  /** CulGate payment method type, e.g. `gcash`. */
  type: string;
  /** The provider's own name for the method, when it differs. */
  providerType?: string;
}

export interface Payment {
  /**
   * Identifier to pass back to CulGate (e.g. `payments.retrieve`). CulGate is
   * stateless, so this is the provider's payment ID; it is only meaningful
   * together with `accountId`.
   */
  id: string;
  /** Application-defined CulGate account that owns this payment. */
  accountId: string;
  provider: string;
  providerPaymentId: string;
  reference?: string;
  amount: Money;
  status: PaymentStatus;
  /** The provider's original status string, verbatim. */
  providerStatus?: string;
  paymentMethod?: PaymentMethodInfo;
  /** URL the customer must visit to complete the payment, when applicable. */
  checkoutUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
  /** Unmodified provider response. May contain personal data: do not log blindly. */
  raw?: unknown;
}

export type RefundStatus =
  'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export const REFUND_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
] as const satisfies readonly RefundStatus[];

export interface Refund {
  id: string;
  accountId: string;
  provider: string;
  providerRefundId: string;
  paymentId: string;
  amount: Money;
  status: RefundStatus;
  providerStatus?: string;
  reason?: string;
  createdAt?: Date;
  raw?: unknown;
}
