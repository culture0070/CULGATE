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
import { xendit } from '../src/index.js';
import {
  errorBody,
  fakeXendit,
  paymentRequest,
  PR,
  PY,
  refund,
  RFD,
  TEST_KEY,
  WEBHOOK_TOKEN,
} from './helpers.js';

const createInput = {
  amount: { value: 150050, currency: 'PHP' },
  paymentMethod: { type: 'gcash' },
  returnUrls: {
    success: 'https://example.com/payment/success',
    cancel: 'https://example.com/payment/cancel',
  },
  reference: 'ORDER-123',
} as const;

const created = () =>
  fakeXendit().on('POST /v3/payment_requests', { status: 201, body: paymentRequest() });

describe('provider contract and configuration', () => {
  it('passes the shared provider contract, with and without webhooks', () => {
    const base = { provider: 'xendit', secretKey: TEST_KEY, environment: 'test' };
    assertProviderContract(xendit(), {
      validConfig: base,
      requiredKeys: ['secretKey'],
      secrets: [TEST_KEY],
    });
    assertProviderContract(xendit(), {
      validConfig: { ...base, webhookToken: WEBHOOK_TOKEN },
      requiredKeys: ['secretKey'],
      secrets: [TEST_KEY, WEBHOOK_TOKEN],
    });
  });

  it('declares exactly the operations it implements', () => {
    expect(fakeXendit().adapter().capabilities.operations).toEqual([
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
    expect(fakeXendit().adapter({ webhookToken: WEBHOOK_TOKEN }).capabilities.operations).toEqual(
      expect.arrayContaining(['webhooks.verify', 'webhooks.normalize']),
    );
  });

  it('rejects invalid configuration without echoing values', () => {
    const parse = (raw: Record<string, unknown>) =>
      xendit().parseConfig({ provider: 'xendit', environment: 'test', ...raw }, { accountId: 'a' });
    expect(() => parse({})).toThrow(/missing required config key "secretKey"/);
    expect(() => parse({ secretKey: TEST_KEY, webhookToken: '' })).toThrow(ConfigurationError);
    expect(() => parse({ secretKey: TEST_KEY, timeoutMs: '30' })).toThrow(/"timeoutMs"/);
  });

  it('reports the supported currency and channels', () => {
    const { capabilities } = fakeXendit().adapter();
    const check = (context: object) =>
      capabilities.check({ operation: 'payments.create', ...context }).supported;
    expect(check({ currency: 'PHP', paymentMethod: 'gcash' })).toBe(true);
    expect(check({ paymentMethod: 'shopeepay' })).toBe(true);
    expect(check({ paymentMethod: 'maya' })).toBe(false);
    expect(check({ paymentMethod: 'card' })).toBe(false);
    expect(check({ currency: 'IDR' })).toBe(false);
    expect(capabilities.check({ operation: 'payments.capture' }).supported).toBe(false);
  });
});

describe('payments.create', () => {
  it('creates one payment request with major-unit amounts', async () => {
    const api = created();
    const payment = await api.adapter().payments!.create!({
      ...createInput,
      description: 'Order payment',
      metadata: { cart: 'c_1', items: 3, gift: false },
    });

    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(`${request!.method} ${request!.path}`).toBe('POST /v3/payment_requests');
    expect(request!.body).toEqual({
      reference_id: 'ORDER-123',
      type: 'PAY',
      country: 'PH',
      currency: 'PHP',
      request_amount: 1500.5, // 150050 centavos
      capture_method: 'AUTOMATIC',
      channel_code: 'GCASH',
      channel_properties: {
        success_return_url: 'https://example.com/payment/success',
        failure_return_url: 'https://example.com/payment/cancel',
      },
      description: 'Order payment',
      metadata: { cart: 'c_1', items: 3, gift: false },
    });

    expect(payment).toMatchObject({
      id: PR,
      providerPaymentId: PR,
      amount: { value: 150050, currency: 'PHP' },
      status: 'requires_action',
      providerStatus: 'REQUIRES_ACTION',
      reference: 'ORDER-123',
      paymentMethod: { type: 'gcash', providerType: 'GCASH' },
      checkoutUrl: 'https://pay.example/redirect/abc',
      createdAt: new Date('2026-08-26T07:28:23.731Z'),
    });
    expect(payment.raw).toEqual(paymentRequest());
  });

  it('sends Basic auth and the pinned API version on every call', async () => {
    const api = created();
    await api.adapter().payments!.create!(createInput);
    const { headers } = api.requests[0]!;
    expect(headers.get('authorization')).toBe(`Basic ${btoa(`${TEST_KEY}:`)}`);
    expect(headers.get('api-version')).toBe('2024-11-11');
  });

  it('uses each account’s own key', async () => {
    const api = created();
    const other = 'xnd_test_another_account_key';
    await api.adapter({ secretKey: other, accountId: 'xendit-second' }).payments!.create!(
      createInput,
    );
    expect(api.requests[0]!.headers.get('authorization')).toBe(`Basic ${btoa(`${other}:`)}`);
  });

  it('maps shopeepay to the SHOPEEPAY channel', async () => {
    const api = created();
    await api.adapter().payments!.create!({ ...createInput, paymentMethod: { type: 'shopeepay' } });
    expect(api.requests[0]!.body).toMatchObject({ channel_code: 'SHOPEEPAY', country: 'PH' });
  });

  it('falls back to the success URL when no cancel URL is given', async () => {
    const api = created();
    await api.adapter().payments!.create!({
      ...createInput,
      returnUrls: { success: 'https://example.com/done' },
    });
    expect(api.requests[0]!.body).toMatchObject({
      channel_properties: {
        success_return_url: 'https://example.com/done',
        failure_return_url: 'https://example.com/done',
      },
    });
  });

  it('generates the required reference when none is given, and does not report it back', async () => {
    const api = fakeXendit().on('POST /v3/payment_requests', {
      body: paymentRequest({ reference_id: 'culgate-0b0e7d4e-2f0f-4f58-9a52-0d4c1e7a7c11' }),
    });
    const payment = await api.adapter().payments!.create!({
      ...createInput,
      reference: undefined,
    } as never);
    expect((api.requests[0]!.body as { reference_id: string }).reference_id).toMatch(
      /^culgate-[0-9a-f-]{36}$/,
    );
    expect(payment.reference).toBeUndefined();
  });

  it('never retries a create and sends no idempotency header, even with a key', async () => {
    const api = fakeXendit().on('POST /v3/payment_requests', {
      status: 503,
      body: errorBody('CHANNEL_UNAVAILABLE'),
    });
    const error = await api.adapter().payments!.create!({
      ...createInput,
      idempotencyKey: 'order-123',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ providerCode: 'CHANNEL_UNAVAILABLE', httpStatus: 503 });
    expect(api.requests).toHaveLength(1);
    expect([...api.requests[0]!.headers.keys()].filter((name) => name.includes('idempot'))).toEqual(
      [],
    );
  });

  it.each([
    ['missing payment method', { ...createInput, paymentMethod: undefined }],
    ['unsupported payment method', { ...createInput, paymentMethod: { type: 'maya' } }],
    ['prototype key as payment method', { ...createInput, paymentMethod: { type: 'toString' } }],
    [
      'wrong currency for the channel',
      { ...createInput, amount: { value: 1000, currency: 'USD' } },
    ],
    ['missing return URL', { ...createInput, returnUrls: undefined }],
    ['nested metadata', { ...createInput, metadata: { a: { b: 1 } } }],
    ['over-long metadata key', { ...createInput, metadata: { ['k'.repeat(41)]: 'v' } }],
    ['over-long metadata value', { ...createInput, metadata: { k: 'v'.repeat(501) } }],
    [
      'too many metadata keys',
      {
        ...createInput,
        metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])),
      },
    ],
  ])('rejects %s before calling Xendit', async (_label, input) => {
    const api = created();
    await expect(api.adapter().payments!.create!(input as never)).rejects.toThrow(ValidationError);
    expect(api.requests).toEqual([]);
  });
});

describe('amount conversion', () => {
  it.each([
    [100, 1],
    [150050, 1500.5],
    [1, 0.01],
    [10000001, 100000.01],
    [29, 0.29],
  ])('sends %i centavos as %d and reads it back unchanged', async (value, major) => {
    const api = fakeXendit().on('POST /v3/payment_requests', {
      body: paymentRequest({ request_amount: major }),
    });
    const payment = await api.adapter().payments!.create!({
      ...createInput,
      amount: { value, currency: 'PHP' },
    });
    expect((api.requests[0]!.body as { request_amount: number }).request_amount).toBe(major);
    expect(payment.amount).toEqual({ value, currency: 'PHP' });
  });

  it('treats an amount with too many decimals as an invalid response, never rounding', async () => {
    const api = fakeXendit().on(`GET /v3/payment_requests/${PR}`, {
      body: paymentRequest({ request_amount: 1500.505 }),
    });
    const error = await api.adapter().payments!.retrieve!({ paymentId: PR }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'ProviderError', code: 'invalid_response' });
  });
});

describe('status mapping', () => {
  it.each([
    ['REQUIRES_ACTION', 'requires_action'],
    ['ACCEPTING_PAYMENTS', 'pending'],
    ['PENDING', 'pending'],
    ['AUTHORIZED', 'authorized'],
    ['SUCCEEDED', 'succeeded'],
    ['FAILED', 'failed'],
    ['CANCELED', 'cancelled'],
    ['EXPIRED', 'expired'],
    ['SOMETHING_NEW', 'unknown'],
    ['constructor', 'unknown'],
  ])('maps %s to %s and keeps the original', async (providerStatus, status) => {
    const api = fakeXendit().on(`GET /v3/payment_requests/${PR}`, {
      body: paymentRequest({ status: providerStatus, actions: [] }),
    });
    const payment = await api.adapter().payments!.retrieve!({ paymentId: PR });
    expect(payment).toMatchObject({ status, providerStatus });
    expect(payment.checkoutUrl).toBeUndefined();
  });
});

describe('payments.retrieve and payments.cancel', () => {
  it('maps DATA_NOT_FOUND to PaymentNotFoundError', async () => {
    const error = await fakeXendit().adapter().payments!.retrieve!({ paymentId: PR }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PaymentNotFoundError);
    expect(error).toMatchObject({ providerCode: 'DATA_NOT_FOUND', httpStatus: 404 });
  });

  it.each(['../refunds', 'pr-1/cancel', 'pr-1?x=1', '', 'pr 1'])(
    'rejects the malformed id %j without calling Xendit',
    async (paymentId) => {
      const api = fakeXendit();
      await expect(api.adapter().payments!.retrieve!({ paymentId })).rejects.toThrow(
        ValidationError,
      );
      await expect(api.adapter().payments!.cancel!({ paymentId })).rejects.toThrow(ValidationError);
      expect(api.requests).toEqual([]);
    },
  );

  it('cancels a payment request with no body', async () => {
    const api = fakeXendit().on(`POST /v3/payment_requests/${PR}/cancel`, {
      body: paymentRequest({ status: 'CANCELED', actions: [] }),
    });
    const payment = await api.adapter().payments!.cancel!({ paymentId: PR });
    expect(payment).toMatchObject({ status: 'cancelled', providerStatus: 'CANCELED' });
    expect(api.requests[0]!.body).toBeUndefined();
  });

  it('surfaces Xendit’s refusal to cancel', async () => {
    const api = fakeXendit().on(`POST /v3/payment_requests/${PR}/cancel`, {
      status: 400,
      body: errorBody('INACTIVE_PAYMENT_REQUEST'),
    });
    await expect(api.adapter().payments!.cancel!({ paymentId: PR })).rejects.toMatchObject({
      name: 'ProviderError',
      providerCode: 'INACTIVE_PAYMENT_REQUEST',
    });
  });
});

describe('refunds.create', () => {
  const paid = () =>
    fakeXendit()
      .on(`GET /v3/payment_requests/${PR}`, {
        body: paymentRequest({ status: 'SUCCEEDED', latest_payment_id: PY, actions: [] }),
      })
      .on('POST /v3/refunds', { body: refund() });

  it('refunds the Payment behind the payment request', async () => {
    const api = paid();
    const result = await api.adapter().refunds!.create!({
      paymentId: PR,
      amount: { value: 50000, currency: 'PHP' },
      reason: 'requested_by_customer',
      idempotencyKey: 'refund-order-123',
    });

    const post = api.requests[1]!;
    expect(post.body).toEqual({
      reference_id: 'refund-order-123',
      payment_id: PY,
      reason: 'REQUESTED_BY_CUSTOMER',
      amount: 500,
    });
    expect(post.headers.get('api-version')).toBe('2024-11-11');
    expect(result).toMatchObject({
      id: RFD,
      providerRefundId: RFD,
      paymentId: PR,
      amount: { value: 50000, currency: 'PHP' },
      status: 'succeeded',
      providerStatus: 'SUCCEEDED',
      reason: 'REQUESTED_BY_CUSTOMER',
    });
  });

  it('omits the amount for a full refund and generates a reference', async () => {
    const api = paid();
    await api.adapter().refunds!.create!({ paymentId: PR });
    const body = api.requests[1]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('amount');
    expect(body['reason']).toBe('OTHERS');
    expect(body['reference_id']).toMatch(/^culgate-/);
  });

  it('keeps a free-text reason in metadata with the generic reason code', async () => {
    const api = paid().on('POST /v3/refunds', {
      body: refund({ reason: 'OTHERS', metadata: { culgate_reason: 'Wrong size' } }),
    });
    const result = await api.adapter().refunds!.create!({ paymentId: PR, reason: 'Wrong size' });
    expect(api.requests[1]!.body).toMatchObject({
      reason: 'OTHERS',
      metadata: { culgate_reason: 'Wrong size' },
    });
    expect(result.reason).toBe('Wrong size');
  });

  it('refuses locally when the request has no payment yet', async () => {
    const api = fakeXendit().on(`GET /v3/payment_requests/${PR}`, { body: paymentRequest() });
    const error = await api.adapter().refunds!.create!({ paymentId: PR }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefundError);
    expect(error).toMatchObject({ code: 'payment_not_refundable' });
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('rejects a refund in a different currency than the payment', async () => {
    const api = paid();
    await expect(
      api.adapter().refunds!.create!({ paymentId: PR, amount: { value: 100, currency: 'USD' } }),
    ).rejects.toThrow(ValidationError);
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it.each([
    [400, 'REFUND_AMOUNT_EXCEEDED'],
    [403, 'PARTIAL_REFUND_NOT_SUPPORTED'],
    [409, 'DUPLICATE_ERROR'],
  ])('wraps HTTP %i %s as RefundError and does not retry', async (status, code) => {
    const api = paid().on('POST /v3/refunds', { status, body: errorBody(code) });
    const error = await api.adapter().refunds!.create!({ paymentId: PR }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefundError);
    expect(error).toMatchObject({ providerCode: code, httpStatus: status });
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['PENDING', 'pending'],
    ['SUCCEEDED', 'succeeded'],
    ['FAILED', 'failed'],
    ['REVERSED', 'unknown'],
  ])('maps refund status %s to %s', async (providerStatus, status) => {
    const api = paid().on('POST /v3/refunds', { body: refund({ status: providerStatus }) });
    const result = await api.adapter().refunds!.create!({ paymentId: PR });
    expect(result).toMatchObject({ status, providerStatus });
  });
});

describe('refunds.retrieve', () => {
  it('retrieves the refund and resolves the owning payment request', async () => {
    const api = fakeXendit()
      .on(`GET /v3/refunds/${RFD}`, { body: refund({ status: 'PENDING' }) })
      .on(`GET /v3/payments/${PY}`, {
        body: { payment_id: PY, payment_request_id: PR, status: 'SUCCEEDED' },
      });
    const result = await api.adapter().refunds!.retrieve!({ refundId: RFD });
    expect(result).toMatchObject({ id: RFD, paymentId: PR, status: 'pending' });
  });

  it('maps a missing refund to RefundError refund_not_found', async () => {
    const error = await fakeXendit().adapter().refunds!.retrieve!({ refundId: RFD }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RefundError);
    expect(error).toMatchObject({ code: 'refund_not_found', providerCode: 'DATA_NOT_FOUND' });
  });
});

describe('error handling', () => {
  it('maps INVALID_API_KEY to AuthenticationError without leaking the key', async () => {
    const api = fakeXendit().on(`GET /v3/payment_requests/${PR}`, {
      status: 401,
      body: errorBody('INVALID_API_KEY', 'The API key is missing or invalid.'),
    });
    const error = await api.adapter().payments!.retrieve!({ paymentId: PR }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({
      providerCode: 'INVALID_API_KEY',
      provider: 'xendit',
      accountId: 'xendit-main',
    });
    const exposed = JSON.stringify(error) + String(error) + String((error as Error).stack);
    expect(exposed).not.toContain(TEST_KEY);
    expect(exposed).not.toContain(btoa(`${TEST_KEY}:`));
  });

  it('does not treat a 403 business rule as an authentication failure', async () => {
    const api = fakeXendit().on('POST /v3/payment_requests', {
      status: 403,
      body: errorBody('INVALID_MERCHANT_SETTINGS'),
    });
    const error = await api.adapter().payments!.create!(createInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(AuthenticationError);
  });

  it('maps HTTP 429 to RateLimitError using Rate-Limit-Reset', async () => {
    const api = fakeXendit().on('POST /v3/payment_requests', {
      status: 429,
      body: errorBody('RATE_LIMIT_EXCEEDED'),
      headers: { 'Rate-Limit-Reset': '58.37' },
    });
    const error = await api.adapter().payments!.create!(createInput).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 58370, providerCode: 'RATE_LIMIT_EXCEEDED' });
  });

  it('rejects a success response that is not in the documented shape', async () => {
    const api = fakeXendit().on(`GET /v3/payment_requests/${PR}`, {
      body: { payment_request_id: PR, status: 'SUCCEEDED', request_amount: '1500' },
    });
    const error = await api.adapter().payments!.retrieve!({ paymentId: PR }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: 'ProviderError', code: 'invalid_response' });
  });
});
