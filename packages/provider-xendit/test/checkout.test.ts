import { type ProviderWebhookEvent, ValidationError } from '@culgate/core';
import { describe, expect, it } from 'vitest';
import { errorBody, fakeXendit, PR, PY, WEBHOOK_TOKEN } from './helpers.js';

const PS = 'ps-661f87c614802d6c402cd82d';

const input = {
  lineItems: [
    { name: 'T-shirt', quantity: 2, amount: { value: 50000, currency: 'PHP' } },
    { name: 'Shipping', quantity: 1, amount: { value: 15050, currency: 'PHP' } },
  ],
  total: { value: 115050, currency: 'PHP' },
};

/** Shaped like the session object in Xendit's create-session reference. */
function session(overrides: Record<string, unknown> = {}) {
  return {
    payment_session_id: PS,
    created: '2026-11-13T00:00:00Z',
    updated: '2026-11-13T00:00:00Z',
    reference_id: 'ORDER-123',
    session_type: 'PAY',
    currency: 'PHP',
    amount: 1150.5,
    country: 'PH',
    mode: 'PAYMENT_LINK',
    expires_at: '2026-11-13T00:30:00Z',
    expires_ttl: 1800,
    locale: 'en',
    metadata: null,
    items: null,
    status: 'ACTIVE',
    payment_link_url: 'https://dev.xen.to/kGxPCi60',
    payment_token_id: null,
    payment_request_id: null,
    business_id: '661f87c614802d6c402cd82d',
    ...overrides,
  };
}

describe('checkout.create', () => {
  it('creates a PAYMENT_LINK session for the total, in major units', async () => {
    const api = fakeXendit().on('POST /sessions', { status: 201, body: session() });
    const result = await api.adapter().checkout!.create!({
      ...input,
      reference: 'ORDER-123',
      description: 'Order 123',
      paymentMethods: ['card', 'gcash', 'maya'],
      returnUrls: { success: 'https://example.com/ok', cancel: 'https://example.com/back' },
      metadata: { cart: 'c_1' },
    });

    const [request] = api.requests;
    expect(request!.body).toEqual({
      reference_id: 'ORDER-123',
      session_type: 'PAY',
      mode: 'PAYMENT_LINK',
      amount: 1150.5,
      currency: 'PHP',
      country: 'PH',
      description: 'Order 123',
      allowed_payment_channels: ['CARDS', 'GCASH', 'PAYMAYA'],
      success_return_url: 'https://example.com/ok',
      cancel_return_url: 'https://example.com/back',
      metadata: { cart: 'c_1' },
    });
    // The Sessions API is unversioned, unlike payment requests and refunds.
    expect(request!.headers.has('api-version')).toBe(false);
    expect(request!.headers.get('authorization')).toMatch(/^Basic /);

    expect(result).toMatchObject({
      id: PS,
      providerSessionId: PS,
      url: 'https://dev.xen.to/kGxPCi60',
      status: 'open',
      providerStatus: 'ACTIVE',
      amount: { value: 115050, currency: 'PHP' },
      reference: 'ORDER-123',
      createdAt: new Date('2026-11-13T00:00:00Z'),
      expiresAt: new Date('2026-11-13T00:30:00Z'),
    });
    expect(result.paymentId).toBeUndefined();
  });

  it('lets Xendit offer every activated channel when no methods are chosen', async () => {
    const api = fakeXendit().on('POST /sessions', { body: session() });
    await api.adapter().checkout!.create!(input);
    expect(api.requests[0]!.body).not.toHaveProperty('allowed_payment_channels');
    expect(api.requests[0]!.body).not.toHaveProperty('items');
  });

  it('generates the required reference when none is given and never retries', async () => {
    const api = fakeXendit().on('POST /sessions', { status: 503, body: errorBody('SERVER_ERROR') });
    await expect(
      api.adapter().checkout!.create!({ ...input, idempotencyKey: 'k' }),
    ).rejects.toMatchObject({
      providerCode: 'SERVER_ERROR',
    });
    expect(api.requests).toHaveLength(1);
    expect((api.requests[0]!.body as { reference_id: string }).reference_id).toMatch(
      /^culgate-[0-9a-f-]{36}$/,
    );
  });

  it.each([
    ['an unsupported currency', { ...input, total: { value: 1000, currency: 'USD' } }],
    ['an unsupported payment method', { ...input, paymentMethods: ['crypto'] }],
    ['a reference over 64 characters', { ...input, reference: 'r'.repeat(65) }],
    ['a non-https success URL', { ...input, returnUrls: { success: 'http://example.com/ok' } }],
    ['a non-https cancel URL', { ...input, returnUrls: { cancel: 'http://example.com/back' } }],
    ['nested metadata', { ...input, metadata: { a: { b: 1 } } }],
  ])('rejects %s before calling Xendit', async (_label, bad) => {
    const api = fakeXendit();
    await expect(api.adapter().checkout!.create!(bad as never)).rejects.toThrow(ValidationError);
    expect(api.requests).toEqual([]);
  });

  it('declares more payment methods for checkout than for direct payments', () => {
    const { capabilities } = fakeXendit().adapter();
    const supports = (operation: 'checkout.create' | 'payments.create', paymentMethod: string) =>
      capabilities.check({ operation, paymentMethod }).supported;
    expect([supports('checkout.create', 'card'), supports('payments.create', 'card')]).toEqual([
      true,
      false,
    ]);
    expect([supports('checkout.create', 'maya'), supports('payments.create', 'maya')]).toEqual([
      true,
      false,
    ]);
    expect(supports('checkout.create', 'crypto')).toBe(false);
  });
});

describe('checkout.retrieve and checkout.expire', () => {
  it.each([
    ['ACTIVE', 'open'],
    ['COMPLETED', 'completed'],
    ['EXPIRED', 'expired'],
    ['CANCELED', 'cancelled'],
    ['SOMETHING_NEW', 'unknown'],
  ])('maps %s to %s', async (providerStatus, status) => {
    const api = fakeXendit().on(`GET /sessions/${PS}`, {
      body: session({ status: providerStatus }),
    });
    const result = await api.adapter().checkout!.retrieve!({ sessionId: PS });
    expect(result).toMatchObject({ status, providerStatus });
    expect(api.requests[0]!.headers.has('api-version')).toBe(false);
  });

  it('points at the payment request once the session is completed', async () => {
    const api = fakeXendit().on(`GET /sessions/${PS}`, {
      body: session({ status: 'COMPLETED', payment_request_id: PR, payment_id: PY }),
    });
    const result = await api.adapter().checkout!.retrieve!({ sessionId: PS });
    expect(result).toMatchObject({ status: 'completed', paymentId: PR });
  });

  it('cancels a session; Xendit calls the result CANCELED', async () => {
    const api = fakeXendit().on(`POST /sessions/${PS}/cancel`, {
      body: session({ status: 'CANCELED' }),
    });
    const result = await api.adapter().checkout!.expire!({ sessionId: PS });
    expect(result).toMatchObject({ status: 'cancelled', providerStatus: 'CANCELED' });
    expect(api.requests[0]!.body).toBeUndefined();
  });

  it('surfaces Xendit’s refusal to cancel a completed session', async () => {
    const api = fakeXendit().on(`POST /sessions/${PS}/cancel`, {
      status: 422,
      body: errorBody('INVALID_SESSION_STATUS', 'Session status is COMPLETED, expecting ACTIVE'),
    });
    await expect(api.adapter().checkout!.expire!({ sessionId: PS })).rejects.toMatchObject({
      providerCode: 'INVALID_SESSION_STATUS',
      httpStatus: 422,
    });
  });

  it('maps a missing session to checkout_session_not_found', async () => {
    const api = fakeXendit().on(`GET /sessions/${PS}`, {
      status: 404,
      body: errorBody('NOT_FOUND'),
    });
    await expect(api.adapter().checkout!.retrieve!({ sessionId: PS })).rejects.toMatchObject({
      code: 'checkout_session_not_found',
      providerCode: 'NOT_FOUND',
    });
  });

  it('treats an amount with too many decimals as an invalid response', async () => {
    const api = fakeXendit().on(`GET /sessions/${PS}`, { body: session({ amount: 10.005 }) });
    await expect(api.adapter().checkout!.retrieve!({ sessionId: PS })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects a malformed session id without calling Xendit', async () => {
    const api = fakeXendit();
    await expect(api.adapter().checkout!.retrieve!({ sessionId: 'ps-1/cancel' })).rejects.toThrow(
      ValidationError,
    );
    expect(api.requests).toEqual([]);
  });
});

describe('session webhooks', () => {
  const normalize = (payload: unknown) =>
    fakeXendit().adapter({ webhookToken: WEBHOOK_TOKEN }).webhooks!.normalize!({
      rawBody: JSON.stringify(payload),
      headers: {},
    }) as ProviderWebhookEvent;

  /** Shaped like the `payment_session.completed` example in Xendit's reference. */
  const completed = {
    event: 'payment_session.completed',
    business_id: '661f87c614802d6c402cd82d',
    created: '2026-12-31T23:59:59Z',
    data: {
      payment_session_id: PS,
      reference_id: 'order_12345_PAY',
      session_type: 'PAY',
      currency: 'PHP',
      amount: 10000,
      status: 'COMPLETED',
      payment_request_id: PR,
      payment_id: PY,
      payment_link_url: 'https://xen.to/kGxPCi60',
    },
  };

  it('maps payment_session.completed to checkout.completed', () => {
    expect(normalize(completed)).toEqual({
      id: `payment_session.completed:${PS}`,
      type: 'checkout.completed',
      providerEventType: 'payment_session.completed',
      resourceId: PS,
      occurredAt: new Date('2026-12-31T23:59:59Z'),
      data: {
        sessionId: PS,
        paymentId: PR,
        reference: 'order_12345_PAY',
        amount: { value: 1000000, currency: 'PHP' },
        providerStatus: 'COMPLETED',
      },
      raw: completed,
    });
  });

  it('maps payment_session.expired to checkout.expired', () => {
    const result = normalize({
      ...completed,
      event: 'payment_session.expired',
      data: { ...completed.data, status: 'EXPIRED', payment_request_id: null, payment_id: null },
    });
    expect(result).toMatchObject({
      type: 'checkout.expired',
      id: `payment_session.expired:${PS}`,
      resourceId: PS,
    });
    expect(result.data).not.toHaveProperty('paymentId');
  });
});
