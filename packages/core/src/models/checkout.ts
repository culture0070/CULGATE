import type { Money } from '../money/index.js';

/**
 * Normalized status of a hosted checkout session.
 *
 * `completed` means the provider reports a successful payment for the
 * session. `open` means the customer can still pay.
 */
export type CheckoutSessionStatus = 'open' | 'completed' | 'expired' | 'cancelled' | 'unknown';

export const CHECKOUT_SESSION_STATUSES = [
  'open',
  'completed',
  'expired',
  'cancelled',
  'unknown',
] as const satisfies readonly CheckoutSessionStatus[];

export interface CheckoutLineItem {
  name: string;
  /** Positive whole number. */
  quantity: number;
  /** Price of ONE unit, in minor units. */
  amount: Money;
  description?: string;
}

/**
 * A provider-hosted payment page. This is a distinct resource from a
 * payment: the customer chooses the payment method on the provider's page,
 * and a payment exists only once they pay.
 */
export interface CheckoutSession {
  /** Identifier to pass back to CulGate; the provider's session ID. */
  id: string;
  accountId: string;
  provider: string;
  providerSessionId: string;
  /** Where to send the customer. Absent once a provider no longer reports it. */
  url?: string;
  status: CheckoutSessionStatus;
  /** The provider's original status string, verbatim, when it reports one. */
  providerStatus?: string;
  /** Total of the session, when known. */
  amount?: Money;
  reference?: string;
  /**
   * CulGate payment ID of the payment made through this session, when the
   * provider reports one. Usable with `payments.retrieve` and
   * `refunds.create` on the same account.
   */
  paymentId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  expiresAt?: Date;
  /** Unmodified provider response. May contain personal data: do not log blindly. */
  raw?: unknown;
}
