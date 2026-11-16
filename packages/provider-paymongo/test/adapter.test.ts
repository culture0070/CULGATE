import {
  AuthenticationError,
  ConfigurationError,
  PaymentNotFoundError,
  ProviderError,
  RateLimitError,
  RefundError,
  ValidationError,
} from '@culgate/core';
import { assertProviderContract } from '@culgate/core/testing';
import { describe, expect, it } from 'vitest';
import { paymongo } from '../src/index.js';
import {
  awaitingAction,
  errorBody,
  fakePayMongo,
  intent,
  paidIntent,
  refund,
  TEST_KEY,
} from './helpers.js';

const PI = 'pi_1Pb5ED9RDLCSsWMwXT5W6Q3K';
const PAY = 'pay_JMg1rgaUtg5U79rRSjiDUvLr';
const REF = 'ref_6W6F9Gi82YiApC4cBEzYq4nu';

const createInput = {
  amount: { value: 150000, currency: 'PHP' },
  paymentMethod: { type: 'gcash' },
  returnUrls: { success: 'https://example.com/payment/success' },
} as const;

function happyPath() {
  return fakePayMongo()
    .on('POST /v1/payment_intents', { body: intent() })
    .on('POST /v1/payment_methods', { body: { data: { id: 'pm_abc', type: 'payment_method' } } })
    .on(`POST /v1/payment_intents/${PI}/attach`, { body: awaitingAction() });
}

describe('provider contract and configuration', () => {
  it('passes the shared provider contract', () => {
    assertProviderContract(paymongo(), {
      validConfig: { provider: 'paymongo', secretKey: TEST_KEY, environment: 'test' },
      requiredKeys: ['secretKey'],
      secrets: [TEST_KEY],
    });
  });

  it('declares exactly the operations it implements', () => {
    expect(fakePayMongo().adapter().capabilities.operations).toEqual([
      'payments.create',
      'payments.retrieve',
      'payments.cancel',
      'refunds.create',
      'refunds.retrieve',
      'checkout.create',
      'checkout.retrieve',
      'checkout.expire',
      'provider.request',
    ]);
  });

  it.each([
    [
      'a live key in the test environment',
      'sk_live_abcdef123456',
      'test',
      /does not match environment "test"/,
    ],
    [
      'a test key in the live environment',
      'sk_test_abcdef123456',
      'live',
      /does not match environment "live"/,
    ],
    ['a public key', 'pk_test_abcdef123456', 'test', /is a public key/],
    ['an unrecognized key', 'abcdef123456', 'test', /does not match environment/],
  ])('rejects %s without echoing it', (_label, secretKey, environment, message) => {
    let error: unknown;
    try {
      paymongo().parseConfig({ provider: 'paymongo', secretKey, environment }, { accountId: 'a' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain(secretKey);
  });

  it('reports PHP and the server-side e-wallets as supported', () => {
    const { capabilities } = fakePayMongo().adapter();
    const check = (context: object) =>
      capabilities.check({ operation: 'payments.create', ...context }).supported;
    expect(check({ currency: 'PHP', paymentMethod: 'gcash' })).toBe(true);
    expect(check({ paymentMethod: 'maya' })).toBe(true);
    expect(check({ paymentMethod: 'grabpay' })).toBe(true);
    expect(check({ currency: 'USD' })).toBe(false);
    expect(check({ paymentMethod: 'card' })).toBe(false);
    expect(check({ paymentMethod: 'shopeepay' })).toBe(true);
    expect(check({ paymentMethod: 'qrph' })).toBe(false);
    expect(capabilities.check({ operation: 'payments.capture' }).supported).toBe(false);
  });
});

describe('payments.create', () => {
  it('runs the create -> payment method -> attach workflow', async () => {
    const api = happyPath();
    const payment = await api.adapter().payments!.create!({
      ...createInput,
      reference: 'ORDER-123',
      description: 'Order payment',
      metadata: { cart: 'c_1' },
    });

    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /v1/payment_intents',
      'POST /v1/payment_methods',
      `POST /v1/payment_intents/${PI}/attach`,
    ]);
    const [create, method, attach] = api.requests;
    expect(create!.body).toEqual({
      data: {
        attributes: {
          amount: 150000,
          currency: 'PHP',
          payment_method_allowed: ['gcash'],
          description: 'Order payment',
          metadata: { cart: 'c_1', culgate_reference: 'ORDER-123' },
        },
      },
    });
    expect(method!.body).toEqual({ data: { attributes: { type: 'gcash' } } });
    expect(attach!.body).toEqual({
      data: {
        attributes: {
          payment_method: 'pm_abc',
          return_url: 'https://example.com/payment/success',
        },
      },
    });

    expect(payment).toMatchObject({
      id: PI,
      providerPaymentId: PI,
      amount: { value: 150000, currency: 'PHP' },
      status: 'requires_action',
      providerStatus: 'awaiting_next_action',
      paymentMethod: { type: 'gcash', providerType: 'gcash' },
      checkoutUrl: 'https://test-sources.paymongo.com/sources?id=src_abc',
      createdAt: new Date(1586179682 * 1000),
    });
    expect(payment.raw).toEqual(awaitingAction());
  });

  it('authenticates with HTTP Basic using the secret key and an empty password', async () => {
    const api = happyPath();
    await api.adapter().payments!.create!(createInput);
    for (const request of api.requests) {
      expect(request.headers.get('authorization')).toBe(`Basic ${btoa(`${TEST_KEY}:`)}`);
    }
  });

  it('uses each account’s own key', async () => {
    const api = happyPath();
    const other = 'sk_test_another_account_fake';
    await api.adapter(other, 'paymongo-second').payments!.create!(createInput);
    expect(api.requests[0]!.headers.get('authorization')).toBe(`Basic ${btoa(`${other}:`)}`);
  });

  it.each([
    ['maya', 'paymaya'],
    ['grabpay', 'grab_pay'],
    ['shopeepay', 'shopee_pay'],
    ['billease', 'billease'],
  ])('maps payment method %s to PayMongo type %s', async (type, providerType) => {
    const api = happyPath();
    await api.adapter().payments!.create!({ ...createInput, paymentMethod: { type } });
    expect(api.requests[0]!.body).toMatchObject({
      data: { attributes: { payment_method_allowed: [providerType] } },
    });
    expect(api.requests[1]!.body).toEqual({ data: { attributes: { type: providerType } } });
  });

  it('sends distinct idempotency keys for the two created resources, and none for attach', async () => {
    const api = happyPath();
    await api.adapter().payments!.create!({ ...createInput, idempotencyKey: 'order-123' });
    expect(api.requests.map((request) => request.headers.get('idempotency-key'))).toEqual([
      'order-123:pi',
      'order-123:pm',
      null,
    ]);
  });

  it('sends no idempotency header when no key is given', async () => {
    const api = happyPath();
    await api.adapter().payments!.create!(createInput);
    expect(api.requests.every((request) => !request.headers.has('idempotency-key'))).toBe(true);
  });

  it('returns the original intent on an idempotent replay instead of attaching twice', async () => {
    const api = fakePayMongo().on('POST /v1/payment_intents', { body: awaitingAction() });
    const payment = await api.adapter().payments!.create!({
      ...createInput,
      idempotencyKey: 'order-123',
    });
    expect(api.requests).toHaveLength(1);
    expect(payment).toMatchObject({ status: 'requires_action', checkoutUrl: expect.any(String) });
  });

  it('never retries a failed create, with or without an idempotency key', async () => {
    // PayMongo's sandbox ignores Idempotency-Key, so a retry could duplicate.
    const unavailable = { status: 503, body: errorBody('resource_processing_error') };
    for (const input of [createInput, { ...createInput, idempotencyKey: 'order-1' }]) {
      const api = happyPath().on('POST /v1/payment_intents', unavailable, { body: intent() });
      await expect(api.adapter().payments!.create!(input)).rejects.toThrow(ProviderError);
      expect(api.requests).toHaveLength(1);
    }
  });

  it('names the created intent when a later step fails', async () => {
    const api = happyPath().on(`POST /v1/payment_intents/${PI}/attach`, {
      status: 400,
      body: errorBody('parameter_required', 'billing.email is required.', 'billing.email'),
    });
    const error = await api.adapter().payments!.create!(createInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      providerCode: 'parameter_required',
      httpStatus: 400,
      details: {
        paymentIntentId: PI,
        stage: 'attach_payment_method',
        errors: [{ code: 'parameter_required', pointer: 'billing.email' }],
      },
    });
  });

  it.each([
    ['missing payment method', { ...createInput, paymentMethod: undefined }],
    ['unsupported payment method', { ...createInput, paymentMethod: { type: 'card' } }],
    ['prototype key as payment method', { ...createInput, paymentMethod: { type: 'constructor' } }],
    ['missing return URL', { ...createInput, returnUrls: undefined }],
    ['amount below PHP 1.00', { ...createInput, amount: { value: 99, currency: 'PHP' } }],
    ['non-string metadata value', { ...createInput, metadata: { attempts: 3 } }],
    ['reserved metadata key', { ...createInput, metadata: { PYM_internal: 'x' } }],
    ['over-long idempotency key', { ...createInput, idempotencyKey: 'k'.repeat(253) }],
  ])('rejects %s before calling PayMongo', async (_label, input) => {
    const api = happyPath();
    await expect(api.adapter().payments!.create!(input as never)).rejects.toThrow(ValidationError);
    expect(api.requests).toEqual([]);
  });
});

describe('status mapping', () => {
  it.each([
    ['awaiting_payment_method', 'pending'],
    ['awaiting_next_action', 'requires_action'],
    ['processing', 'processing'],
    ['awaiting_capture', 'authorized'],
    ['succeeded', 'succeeded'],
    ['cancelled', 'cancelled'],
    ['some_future_status', 'unknown'],
    ['toString', 'unknown'],
  ])('maps intent status %s to %s and keeps the original', async (providerStatus, status) => {
    const api = fakePayMongo().on(`GET /v1/payment_intents/${PI}`, {
      body: intent({ status: providerStatus }),
    });
    const payment = await api.adapter().payments!.retrieve!({ paymentId: PI });
    expect(payment).toMatchObject({ status, providerStatus });
  });
});

describe('payments.retrieve and payments.cancel', () => {
  it('retrieves a payment intent and restores the caller’s reference', async () => {
    const api = fakePayMongo().on(`GET /v1/payment_intents/${PI}`, {
      body: paidIntent({ metadata: { culgate_reference: 'ORDER-123', cart: 'c_1' } }),
    });
    const payment = await api.adapter().payments!.retrieve!({ paymentId: PI });
    expect(payment).toMatchObject({
      id: PI,
      status: 'succeeded',
      reference: 'ORDER-123',
      metadata: { cart: 'c_1' },
    });
    expect(payment.checkoutUrl).toBeUndefined();
  });

  it.each([
    [404, 'resource_not_found'],
    [400, 'resource_not_found'],
  ])('maps HTTP %i %s to PaymentNotFoundError', async (status, code) => {
    const api = fakePayMongo().on(`GET /v1/payment_intents/${PI}`, {
      status,
      body: errorBody(code),
    });
    const error = await api.adapter().payments!.retrieve!({ paymentId: PI }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PaymentNotFoundError);
    expect(error).toMatchObject({ providerCode: code, httpStatus: status });
  });

  it.each(['../refunds', 'pi_1/attach', 'pi_1?x=1', '', 'pi 1'])(
    'rejects the malformed id %j without calling PayMongo',
    async (paymentId) => {
      const api = fakePayMongo();
      await expect(api.adapter().payments!.retrieve!({ paymentId })).rejects.toThrow(
        ValidationError,
      );
      await expect(api.adapter().payments!.cancel!({ paymentId })).rejects.toThrow(ValidationError);
      expect(api.requests).toEqual([]);
    },
  );

  it('cancels a payment intent', async () => {
    const api = fakePayMongo().on(`POST /v1/payment_intents/${PI}/cancel`, {
      body: intent({ status: 'cancelled' }),
    });
    const payment = await api.adapter().payments!.cancel!({ paymentId: PI });
    expect(payment).toMatchObject({ status: 'cancelled', providerStatus: 'cancelled' });
    expect(api.requests[0]!.body).toBeUndefined();
  });

  it('surfaces PayMongo’s refusal to cancel', async () => {
    const api = fakePayMongo().on(`POST /v1/payment_intents/${PI}/cancel`, {
      status: 400,
      body: errorBody('resource_succeeded_state', 'Payment intent already succeeded.'),
    });
    await expect(api.adapter().payments!.cancel!({ paymentId: PI })).rejects.toMatchObject({
      name: 'ProviderError',
      providerCode: 'resource_succeeded_state',
    });
  });
});

/** Sets the refunds PayMongo reports on the intent's paid payment. */
function setRefunds(
  body: ReturnType<typeof paidIntent>,
  refunds: { id: string; type: string; attributes: { amount: number; status: string } }[],
): void {
  const payments = body.data.attributes.payments as { attributes: { refunds: unknown } }[];
  payments[0]!.attributes.refunds = refunds;
}

describe('refunds.create', () => {
  const paid = () =>
    fakePayMongo()
      .on(`GET /v1/payment_intents/${PI}`, { body: paidIntent() })
      .on('POST /v1/refunds', { body: refund() });

  it('refunds the paid Payment behind the intent', async () => {
    const api = paid();
    const result = await api.adapter().refunds!.create!({
      paymentId: PI,
      amount: { value: 5000, currency: 'PHP' },
      reason: 'requested_by_customer',
      idempotencyKey: 'refund-1',
    });

    const post = api.requests[1]!;
    expect(post.body).toEqual({
      data: { attributes: { amount: 5000, payment_id: PAY, reason: 'requested_by_customer' } },
    });
    expect(post.headers.get('idempotency-key')).toBe('refund-1');
    expect(result).toMatchObject({
      id: REF,
      providerRefundId: REF,
      paymentId: PI,
      amount: { value: 5000, currency: 'PHP' },
      status: 'pending',
      providerStatus: 'pending',
      reason: 'requested_by_customer',
    });
  });

  it('refunds only what is still refundable when no amount is given', async () => {
    const withRefunds = paidIntent();
    setRefunds(withRefunds, [
      { id: 'ref_a', type: 'refund', attributes: { amount: 5000, status: 'succeeded' } },
      { id: 'ref_b', type: 'refund', attributes: { amount: 2500, status: 'pending' } },
      { id: 'ref_c', type: 'refund', attributes: { amount: 9999, status: 'failed' } },
    ]);
    const api = paid().on(`GET /v1/payment_intents/${PI}`, { body: withRefunds });
    await api.adapter().refunds!.create!({ paymentId: PI });
    expect(api.requests[1]!.body).toMatchObject({ data: { attributes: { amount: 142500 } } });
  });

  it('refuses locally when nothing is left to refund', async () => {
    const refunded = paidIntent();
    setRefunds(refunded, [
      { id: 'ref_a', type: 'refund', attributes: { amount: 150000, status: 'succeeded' } },
    ]);
    const api = paid().on(`GET /v1/payment_intents/${PI}`, { body: refunded });
    await expect(api.adapter().refunds!.create!({ paymentId: PI })).rejects.toMatchObject({
      code: 'payment_not_refundable',
    });
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('does not retry a refund even with an idempotency key', async () => {
    const api = paid().on('POST /v1/refunds', {
      status: 503,
      body: errorBody('resource_processing_error'),
    });
    await expect(
      api.adapter().refunds!.create!({ paymentId: PI, idempotencyKey: 'refund-1' }),
    ).rejects.toThrow();
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('refunds the full payment amount when none is given', async () => {
    const api = paid();
    await api.adapter().refunds!.create!({ paymentId: PI });
    expect(api.requests[1]!.body).toEqual({
      data: { attributes: { amount: 150000, payment_id: PAY, reason: 'others' } },
    });
  });

  it('sends a free-text reason as notes with the generic reason code', async () => {
    const api = paid().on('POST /v1/refunds', {
      body: refund({ reason: 'others', notes: 'Wrong size' }),
    });
    const result = await api.adapter().refunds!.create!({ paymentId: PI, reason: 'Wrong size' });
    expect(api.requests[1]!.body).toMatchObject({
      data: { attributes: { reason: 'others', notes: 'Wrong size' } },
    });
    expect(result.reason).toBe('Wrong size');
  });

  it('refuses locally when the intent has no paid payment', async () => {
    const api = fakePayMongo().on(`GET /v1/payment_intents/${PI}`, { body: awaitingAction() });
    const error = await api.adapter().refunds!.create!({ paymentId: PI }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefundError);
    expect(error).toMatchObject({ code: 'payment_not_refundable' });
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('wraps PayMongo refund rejections as RefundError with the provider code', async () => {
    const api = paid().on('POST /v1/refunds', {
      status: 400,
      body: errorBody('parameter_above_maximum', 'amount exceeds refundable amount.', 'amount'),
    });
    const error = await api.adapter().refunds!.create!({ paymentId: PI }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefundError);
    expect(error).toMatchObject({ providerCode: 'parameter_above_maximum', httpStatus: 400 });
  });

  it('reports an unknown payment as PaymentNotFoundError', async () => {
    const api = fakePayMongo();
    await expect(api.adapter().refunds!.create!({ paymentId: PI })).rejects.toThrow(
      PaymentNotFoundError,
    );
  });

  it.each([
    ['pending', 'pending'],
    ['processing', 'processing'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['reversed', 'unknown'],
  ])('maps refund status %s to %s', async (providerStatus, status) => {
    const api = paid().on('POST /v1/refunds', { body: refund({ status: providerStatus }) });
    const result = await api.adapter().refunds!.create!({ paymentId: PI });
    expect(result).toMatchObject({ status, providerStatus });
  });
});

describe('refunds.retrieve', () => {
  it('retrieves the refund and resolves the owning payment intent', async () => {
    const api = fakePayMongo()
      .on(`GET /v1/refunds/${REF}`, { body: refund({ status: 'succeeded' }) })
      .on(`GET /v1/payments/${PAY}`, {
        body: {
          data: { id: PAY, type: 'payment', attributes: { status: 'paid', payment_intent_id: PI } },
        },
      });
    const result = await api.adapter().refunds!.retrieve!({ refundId: REF });
    expect(result).toMatchObject({ id: REF, paymentId: PI, status: 'succeeded' });
  });

  it('maps a missing refund to RefundError refund_not_found', async () => {
    const api = fakePayMongo();
    const error = await api.adapter().refunds!.retrieve!({ refundId: REF }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RefundError);
    expect(error).toMatchObject({ code: 'refund_not_found', httpStatus: 404 });
  });
});

describe('error handling', () => {
  it.each([
    [401, 'api_key_not_found'],
    [401, 'authentication_invalid'],
    [401, 'account_not_activated'],
  ])('maps HTTP %i %s to AuthenticationError without leaking the key', async (status, code) => {
    const api = fakePayMongo().on(`GET /v1/payment_intents/${PI}`, {
      status,
      body: errorBody(code),
    });
    const error = await api.adapter().payments!.retrieve!({ paymentId: PI }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({
      providerCode: code,
      provider: 'paymongo',
      accountId: 'paymongo-main',
    });
    const exposed = JSON.stringify(error) + String(error) + String((error as Error).stack);
    expect(exposed).not.toContain(TEST_KEY);
    expect(exposed).not.toContain(btoa(`${TEST_KEY}:`));
  });

  it('does not report a disabled payment method as a credentials problem', async () => {
    // Seen in the sandbox: QR Ph on an account without it enabled.
    const api = happyPath().on(`POST /v1/payment_intents/${PI}/attach`, {
      status: 400,
      body: errorBody('account_not_activated', 'Please activate your account first.'),
    });
    const error = await api.adapter().payments!.create!(createInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ providerCode: 'account_not_activated' });
  });

  it('maps HTTP 429 to RateLimitError', async () => {
    const api = fakePayMongo().on('POST /v1/payment_intents', { status: 429, body: {} });
    await expect(api.adapter().payments!.create!(createInput)).rejects.toThrow(RateLimitError);
  });

  it('rejects a success response that is not in the documented shape', async () => {
    const api = fakePayMongo().on(`GET /v1/payment_intents/${PI}`, {
      body: { data: { id: PI, attributes: { amount: '150000', status: 'succeeded' } } },
    });
    const error = await api.adapter().payments!.retrieve!({ paymentId: PI }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'ProviderError', code: 'invalid_response' });
    expect((error as ProviderError).details).toEqual({
      fields: expect.arrayContaining(['data.attributes.amount', 'data.attributes.currency']),
    });
  });

  it('tolerates undocumented extra fields', async () => {
    const body = intent({ status: 'succeeded', brand_new_field: { nested: true } });
    const api = fakePayMongo().on(`GET /v1/payment_intents/${PI}`, { body });
    const payment = await api.adapter().payments!.retrieve!({ paymentId: PI });
    expect(payment.status).toBe('succeeded');
    expect(payment.raw).toEqual(body);
  });
});
