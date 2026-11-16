import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Operation } from '../capabilities/index.js';
import { createStaticCapabilities, OPERATIONS } from '../capabilities/index.js';
import type { BaseAccountConfig } from '../configuration/index.js';
import { ENVIRONMENTS } from '../configuration/index.js';
import type {
  ProviderAdapter,
  ProviderCheckoutSession,
  ProviderDefinition,
  ProviderPayment,
  ProviderRefund,
} from '../contracts/index.js';
import {
  ConfigurationError,
  PaymentNotFoundError,
  ProviderError,
  RefundError,
  WebhookVerificationError,
} from '../errors/index.js';
import type { ProviderRequestInput, ProviderResponse } from '../http/provider-request.js';
import type { PaymentStatus } from '../models/index.js';
import type { ProviderWebhookEvent, WebhookRequest } from '../webhooks/index.js';
import {
  getWebhookHeader,
  isWebhookEventType,
  parseWebhookJson,
  webhookBodyBytes,
} from '../webhooks/index.js';

/**
 * In-memory provider for tests and examples. It performs no network calls and
 * is not a payment gateway; never register it in production.
 */
export interface MockAccountConfig extends BaseAccountConfig {
  readonly provider: 'mock';
  readonly secretKey: string;
  /** Enables webhooks for the account. Without it, webhook operations are unsupported. */
  readonly webhookSecret?: string;
}

/** Header carrying the mock's signature: hex HMAC-SHA256 of the raw body. */
export const MOCK_SIGNATURE_HEADER = 'mock-signature';

export interface MockWebhookInput {
  /** Omit to simulate a provider that sends no event ID. */
  id?: string;
  /** Mock event type, e.g. `mock.payment.succeeded`. Unrecognized types are allowed. */
  type: string;
  resourceId?: string;
  occurredAt?: Date;
  data?: Record<string, unknown>;
}

export interface MockCall {
  readonly accountId: string;
  readonly operation: Operation;
  readonly input: unknown;
  /** Fingerprint of the credential the adapter used; see {@link fingerprintSecret}. */
  readonly credentialFingerprint: string;
}

export interface MockProviderOptions {
  /**
   * Defaults to every operation CulGate defines. Webhook operations are only
   * ever available on accounts configured with a `webhookSecret`.
   */
  operations?: readonly Operation[];
  /** Restrict supported currencies. Unrestricted by default. */
  currencies?: readonly string[];
  /** Restrict supported payment methods. Unrestricted by default. */
  paymentMethods?: readonly string[];
}

export interface MockProvider extends ProviderDefinition<MockAccountConfig> {
  /** Every adapter call made through this provider, in order. */
  readonly calls: readonly MockCall[];
  callsFor(accountId: string): MockCall[];
  /** Clears recorded calls. Stored payments and refunds are kept. */
  reset(): void;
  /**
   * Simulates the provider moving a payment to another state, as a customer
   * completing (or abandoning) a payment would.
   */
  setPaymentStatus(accountId: string, paymentId: string, status: PaymentStatus): void;
  /**
   * Builds a webhook request signed with the account's `webhookSecret`, as
   * the provider would send it.
   */
  signWebhook(accountId: string, event: MockWebhookInput): WebhookRequest & { rawBody: string };
  /**
   * Simulates a customer paying through a checkout session: creates a
   * succeeded payment for the session total and completes the session.
   * Returns the new payment's ID.
   */
  completeCheckout(accountId: string, sessionId: string): string;
}

function sign(secret: string, body: Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Non-reversible fingerprint used to assert which credential was used. */
export function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

interface AccountState {
  readonly payments: Map<string, ProviderPayment>;
  readonly refunds: Map<string, ProviderRefund>;
  readonly sessions: Map<string, ProviderCheckoutSession>;
  readonly refundedTotals: Map<string, number>;
  readonly idempotent: Map<string, ProviderPayment | ProviderRefund>;
}

const CANCELLABLE: readonly PaymentStatus[] = ['pending', 'requires_action', 'authorized'];
const REFUNDABLE: readonly PaymentStatus[] = ['succeeded', 'partially_refunded'];

export function mockProvider(options: MockProviderOptions = {}): MockProvider {
  const operations = options.operations ?? OPERATIONS;
  const calls: MockCall[] = [];
  const states = new Map<string, AccountState>();
  const webhookSecrets = new Map<string, string>();
  let sequence = 0;

  return {
    name: 'mock',
    get calls() {
      return [...calls];
    },
    callsFor: (accountId) => calls.filter((call) => call.accountId === accountId),
    reset: () => {
      calls.length = 0;
    },
    setPaymentStatus(accountId, paymentId, status) {
      const payment = states.get(accountId)?.payments.get(paymentId);
      if (!payment) {
        throw new Error(`Mock account "${accountId}" has no payment "${paymentId}".`);
      }
      payment.status = status;
      payment.providerStatus = `mock_${status}`;
      payment.updatedAt = new Date();
    },

    completeCheckout(accountId, sessionId) {
      const state = states.get(accountId);
      const session = state?.sessions.get(sessionId);
      if (!state || !session) {
        throw new Error(`Mock account "${accountId}" has no checkout session "${sessionId}".`);
      }
      if (session.status !== 'open') {
        throw new Error(`Mock checkout session "${sessionId}" is ${session.status}, not open.`);
      }
      const id = `mock_pay_${++sequence}`;
      const now = new Date();
      state.payments.set(id, {
        id,
        providerPaymentId: id,
        amount: { ...session.amount! },
        status: 'succeeded',
        providerStatus: 'mock_succeeded',
        createdAt: now,
        updatedAt: now,
        ...(session.reference !== undefined && { reference: session.reference }),
        raw: { id, object: 'mock_payment', checkout_session: sessionId },
      });
      session.status = 'completed';
      session.providerStatus = 'mock_completed';
      session.paymentId = id;
      return id;
    },

    signWebhook(accountId, event) {
      const secret = webhookSecrets.get(accountId);
      if (secret === undefined) {
        throw new Error(`Mock account "${accountId}" has no webhookSecret configured.`);
      }
      const rawBody = JSON.stringify({
        ...(event.id !== undefined && { id: event.id }),
        type: event.type,
        ...(event.resourceId !== undefined && { resource_id: event.resourceId }),
        created: Math.floor((event.occurredAt ?? new Date()).getTime() / 1000),
        data: event.data ?? {},
      });
      return {
        rawBody,
        headers: { [MOCK_SIGNATURE_HEADER]: sign(secret, webhookBodyBytes(rawBody)) },
      };
    },

    parseConfig(raw, { accountId }) {
      const { secretKey, environment, webhookSecret } = raw;
      if (webhookSecret !== undefined && (typeof webhookSecret !== 'string' || !webhookSecret)) {
        throw new ConfigurationError(
          `Account "${accountId}" config key "webhookSecret" must be a non-empty string.`,
          { accountId, provider: 'mock' },
        );
      }
      if (typeof secretKey !== 'string' || secretKey.length === 0) {
        throw new ConfigurationError(
          `Account "${accountId}" is missing required config key "secretKey".`,
          { accountId, provider: 'mock' },
        );
      }
      // `environment` is validated by the SDK; narrowed here for the type system.
      const env = ENVIRONMENTS.find((candidate) => candidate === environment) ?? 'test';
      return {
        provider: 'mock',
        secretKey,
        environment: env,
        ...(typeof webhookSecret === 'string' && { webhookSecret }),
      };
    },

    createAdapter({ accountId, config }): ProviderAdapter {
      // Held in closures only, so the adapter object exposes no credentials.
      const credentialFingerprint = fingerprintSecret(config.secretKey);
      const state: AccountState = {
        payments: new Map(),
        refunds: new Map(),
        sessions: new Map(),
        refundedTotals: new Map(),
        idempotent: new Map(),
      };
      states.set(accountId, state);
      const { webhookSecret } = config;
      if (webhookSecret === undefined) webhookSecrets.delete(accountId);
      else webhookSecrets.set(accountId, webhookSecret);
      const accountOperations = operations.filter(
        (operation) => webhookSecret !== undefined || !operation.startsWith('webhooks.'),
      );

      const record = (operation: Operation, input: unknown) => {
        calls.push({ accountId, operation, input, credentialFingerprint });
      };
      const findPayment = (paymentId: string): ProviderPayment => {
        const payment = state.payments.get(paymentId);
        if (!payment) {
          throw new PaymentNotFoundError(`Payment "${paymentId}" was not found.`, {
            httpStatus: 404,
            providerCode: 'resource_not_found',
          });
        }
        return payment;
      };
      const findSession = (sessionId: string): ProviderCheckoutSession => {
        const session = state.sessions.get(sessionId);
        if (!session) {
          throw new ProviderError(`Checkout session "${sessionId}" was not found.`, {
            code: 'checkout_session_not_found',
            httpStatus: 404,
            providerCode: 'resource_not_found',
          });
        }
        return session;
      };
      const transition = (payment: ProviderPayment, status: PaymentStatus) => {
        payment.status = status;
        payment.providerStatus = `mock_${status}`;
        payment.updatedAt = new Date();
      };

      return {
        capabilities: createStaticCapabilities({
          operations: accountOperations,
          ...(options.currencies && { currencies: options.currencies }),
          ...(options.paymentMethods && { paymentMethods: options.paymentMethods }),
        }),

        payments: {
          async create(input) {
            record('payments.create', input);
            const idempotencyKey =
              input.idempotencyKey && `payments.create:${input.idempotencyKey}`;
            const replay = idempotencyKey && state.idempotent.get(idempotencyKey);
            if (replay) return structuredClone(replay as ProviderPayment);

            const id = `mock_pay_${++sequence}`;
            const now = new Date();
            const payment: ProviderPayment = {
              id,
              providerPaymentId: id,
              amount: { ...input.amount },
              status: 'pending',
              providerStatus: 'mock_pending',
              createdAt: now,
              updatedAt: now,
              ...(input.reference !== undefined && { reference: input.reference }),
              ...(input.paymentMethod && { paymentMethod: { type: input.paymentMethod.type } }),
              ...(input.metadata && { metadata: structuredClone(input.metadata) }),
              raw: { id, object: 'mock_payment' },
            };
            state.payments.set(id, payment);
            if (idempotencyKey) state.idempotent.set(idempotencyKey, payment);
            return structuredClone(payment);
          },

          async retrieve(input) {
            record('payments.retrieve', input);
            return structuredClone(findPayment(input.paymentId));
          },

          async cancel(input) {
            record('payments.cancel', input);
            const payment = findPayment(input.paymentId);
            if (!CANCELLABLE.includes(payment.status)) {
              throw new ProviderError(
                `Payment "${payment.id}" cannot be cancelled while it is ${payment.status}.`,
                { httpStatus: 409, providerCode: 'payment_not_cancellable' },
              );
            }
            transition(payment, 'cancelled');
            return structuredClone(payment);
          },

          async capture(input) {
            record('payments.capture', input);
            const payment = findPayment(input.paymentId);
            if (payment.status !== 'authorized') {
              throw new ProviderError(
                `Payment "${payment.id}" cannot be captured while it is ${payment.status}.`,
                { httpStatus: 409, providerCode: 'payment_not_capturable' },
              );
            }
            const amount = input.amount ?? payment.amount;
            if (
              amount.currency !== payment.amount.currency ||
              amount.value > payment.amount.value
            ) {
              throw new ProviderError('Capture amount exceeds the authorized amount.', {
                httpStatus: 400,
                providerCode: 'invalid_capture_amount',
              });
            }
            payment.amount = { ...amount };
            transition(payment, 'succeeded');
            return structuredClone(payment);
          },
        },

        refunds: {
          async create(input) {
            record('refunds.create', input);
            const idempotencyKey = input.idempotencyKey && `refunds.create:${input.idempotencyKey}`;
            const replay = idempotencyKey && state.idempotent.get(idempotencyKey);
            if (replay) return structuredClone(replay as ProviderRefund);

            const payment = findPayment(input.paymentId);
            if (!REFUNDABLE.includes(payment.status)) {
              throw new RefundError(
                `Payment "${payment.id}" cannot be refunded while it is ${payment.status}.`,
                { httpStatus: 400, providerCode: 'payment_not_refundable' },
              );
            }
            const alreadyRefunded = state.refundedTotals.get(payment.id) ?? 0;
            const remaining = payment.amount.value - alreadyRefunded;
            const amount = input.amount ?? { value: remaining, currency: payment.amount.currency };
            if (amount.currency !== payment.amount.currency) {
              throw new RefundError('Refund currency does not match the payment currency.', {
                httpStatus: 400,
                providerCode: 'currency_mismatch',
              });
            }
            if (amount.value > remaining) {
              throw new RefundError('Refund amount exceeds the refundable balance.', {
                httpStatus: 400,
                providerCode: 'refund_exceeds_balance',
              });
            }

            const id = `mock_ref_${++sequence}`;
            const refund: ProviderRefund = {
              id,
              providerRefundId: id,
              paymentId: payment.id,
              amount: { ...amount },
              status: 'succeeded',
              providerStatus: 'mock_succeeded',
              createdAt: new Date(),
              ...(input.reason !== undefined && { reason: input.reason }),
              raw: { id, object: 'mock_refund' },
            };
            state.refunds.set(id, refund);
            state.refundedTotals.set(payment.id, alreadyRefunded + amount.value);
            transition(payment, amount.value === remaining ? 'refunded' : 'partially_refunded');
            if (idempotencyKey) state.idempotent.set(idempotencyKey, refund);
            return structuredClone(refund);
          },

          async retrieve(input) {
            record('refunds.retrieve', input);
            const refund = state.refunds.get(input.refundId);
            if (!refund) {
              throw new RefundError(`Refund "${input.refundId}" was not found.`, {
                code: 'refund_not_found',
                httpStatus: 404,
                providerCode: 'resource_not_found',
              });
            }
            return structuredClone(refund);
          },
        },

        checkout: {
          async create(input) {
            record('checkout.create', input);
            const idempotencyKey =
              input.idempotencyKey && `checkout.create:${input.idempotencyKey}`;
            const replay = idempotencyKey && state.idempotent.get(idempotencyKey);
            if (replay) return structuredClone(replay as unknown as ProviderCheckoutSession);

            const id = `mock_cs_${++sequence}`;
            const session: ProviderCheckoutSession = {
              id,
              providerSessionId: id,
              url: `https://checkout.mock.test/${id}`,
              status: 'open',
              providerStatus: 'mock_open',
              amount: { ...input.total },
              createdAt: new Date(),
              ...(input.reference !== undefined && { reference: input.reference }),
              ...(input.metadata && { metadata: structuredClone(input.metadata) }),
              raw: {
                id,
                object: 'mock_checkout_session',
                line_items: structuredClone(input.lineItems),
              },
            };
            state.sessions.set(id, session);
            if (idempotencyKey) state.idempotent.set(idempotencyKey, session as never);
            return structuredClone(session);
          },
          async retrieve(input) {
            record('checkout.retrieve', input);
            return structuredClone(findSession(input.sessionId));
          },
          async expire(input) {
            record('checkout.expire', input);
            const session = findSession(input.sessionId);
            if (session.status !== 'open') {
              throw new ProviderError(
                `Checkout session "${session.id}" cannot be expired while it is ${session.status}.`,
                { httpStatus: 400, providerCode: 'session_not_open' },
              );
            }
            session.status = 'expired';
            session.providerStatus = 'mock_expired';
            return structuredClone(session);
          },
        },

        provider: {
          // Echoes the request so tests can assert on what would be sent.
          async request<T>(input: ProviderRequestInput): Promise<ProviderResponse<T>> {
            record('provider.request', input);
            return {
              status: 200,
              headers: new Headers({ 'content-type': 'application/json' }),
              body: { method: input.method, path: input.path, body: input.body ?? null } as T,
            };
          },
        },

        ...(webhookSecret !== undefined && {
          webhooks: {
            verify(request: WebhookRequest) {
              const received = getWebhookHeader(request.headers, MOCK_SIGNATURE_HEADER);
              if (!received) {
                throw new WebhookVerificationError('Missing webhook signature header.', {
                  code: 'missing_signature',
                });
              }
              const expected = Buffer.from(sign(webhookSecret, webhookBodyBytes(request.rawBody)));
              const actual = Buffer.from(received);
              if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
                throw new WebhookVerificationError('Webhook signature does not match.', {
                  code: 'invalid_signature',
                });
              }
            },
            normalize(request: WebhookRequest): ProviderWebhookEvent {
              const payload = parseWebhookJson(request.rawBody);
              const providerEventType =
                typeof payload['type'] === 'string' ? payload['type'] : 'unknown';
              const canonical = providerEventType.replace(/^mock\./, '');
              const { id, resource_id: resourceId, created } = payload;
              return {
                type: isWebhookEventType(canonical) ? canonical : 'provider.unknown',
                providerEventType,
                data: payload['data'] ?? {},
                raw: payload,
                ...(typeof id === 'string' && { id }),
                ...(typeof resourceId === 'string' && { resourceId }),
                ...(typeof created === 'number' && { occurredAt: new Date(created * 1000) }),
              };
            },
          },
        }),
      };
    },
  };
}
