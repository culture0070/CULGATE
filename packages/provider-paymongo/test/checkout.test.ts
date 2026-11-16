import { createHmac } from 'node:crypto';
import { type ProviderWebhookEvent, ValidationError } from '@culgate/core';
import { describe, expect, it } from 'vitest';
import { paymongo } from '../src/index.js';
import { errorBody, fakePayMongo, TEST_KEY } from './helpers.js';

const CS = 'cs_CbFCTDfxvMFNjwjVi26Uzhtj';
const PI = 'pi_1Pb5ED9RDLCSsWMwXT5W6Q3K';

const input = {
  lineItems: [
    { name: 'T-shirt', quantity: 2, amount: { value: 50000, currency: 'PHP' } },
    {
      name: 'Shipping',
      quantity: 1,
      amount: { value: 15000, currency: 'PHP' },
      description: 'Standard',
    },
  ],
  total: { value: 115000, currency: 'PHP' },
};

/** The v2 create response carries only these attributes. */
const createResponse = {
  data: {
    id: CS,
    type: 'checkout_session',
    attributes: {
      checkout_url: 'https://checkout.paymongo.com/cs_CbFCTDfxvMFNjwjVi26Uzhtj_client_abc',
      livemode: false,
      created_at: 1767225600,
      updated_at: 1767225600,
    },
  },
  has_more: false,
};

function session(attributes: Record<string, unknown> = {}) {
  return {
    data: {
      id: CS,
      type: 'checkout_session',
      attributes: {
        checkout_url: createResponse.data.attributes.checkout_url,
        client_key: 'cs_client_abc',
        line_items: [
          { amount: 50000, currency: 'PHP', name: 'T-shirt', quantity: 2 },
          { amount: 15000, currency: 'PHP', name: 'Shipping', quantity: 1 },
        ],
        livemode: false,
        metadata: { cart: 'c_1' },
        payment_intent: null,
        payment_method_types: ['card', 'gcash'],
        payments: [],
        reference_number: 'ORDER-123',
        status: 'active',
        created_at: 1767225600,
        updated_at: 1767225600,
        ...attributes,
      },
    },
  };
}

const paidAttributes = {
  payment_intent: {
    id: PI,
    type: 'payment_intent',
    attributes: { amount: 115000, currency: 'PHP', status: 'succeeded' },
  },
  payments: [
    {
      id: 'pay_failedAttempt',
      type: 'payment',
      attributes: {
        amount: 115000,
        currency: 'PHP',
        status: 'failed',
        payment_intent_id: 'pi_earlier',
      },
    },
    {
      id: 'pay_JMg1rgaUtg5U79rRSjiDUvLr',
      type: 'payment',
      attributes: { amount: 115000, currency: 'PHP', status: 'paid', payment_intent_id: PI },
    },
  ],
};

describe('checkout.create', () => {
  it('creates a v2 checkout session with per-unit line items', async () => {
    const api = fakePayMongo().on('POST /v2/checkout_sessions', { body: createResponse });
    const result = await api.adapter().checkout!.create!({
      ...input,
      reference: 'ORDER-123',
      description: 'Order 123',
      paymentMethods: ['card', 'gcash'],
      returnUrls: { success: 'https://example.com/ok', cancel: 'https://example.com/back' },
      metadata: { cart: 'c_1' },
      idempotencyKey: 'order-123-checkout',
    });

    const [request] = api.requests;
    expect(request!.body).toEqual({
      data: {
        attributes: {
          line_items: [
            { name: 'T-shirt', quantity: 2, amount: 50000, currency: 'PHP' },
            {
              name: 'Shipping',
              quantity: 1,
              amount: 15000,
              currency: 'PHP',
              description: 'Standard',
            },
          ],
          payment_method_types: ['card', 'gcash'],
          success_url: 'https://example.com/ok',
          cancel_url: 'https://example.com/back',
          description: 'Order 123',
          reference_number: 'ORDER-123',
          metadata: { cart: 'c_1' },
        },
      },
    });
    expect(request!.headers.get('authorization')).toBe(`Basic ${btoa(`${TEST_KEY}:`)}`);
    expect(request!.headers.get('idempotency-key')).toBe('order-123-checkout');

    expect(result).toEqual({
      id: CS,
      providerSessionId: CS,
      url: createResponse.data.attributes.checkout_url,
      status: 'open',
      amount: { value: 115000, currency: 'PHP' },
      reference: 'ORDER-123',
      metadata: { cart: 'c_1' },
      createdAt: new Date(1767225600 * 1000),
      raw: createResponse,
    });
  });

  it('offers the documented methods when none are chosen', async () => {
    const api = fakePayMongo().on('POST /v2/checkout_sessions', { body: createResponse });
    await api.adapter().checkout!.create!(input);
    expect(api.requests[0]!.body).toMatchObject({
      data: { attributes: { payment_method_types: ['card', 'gcash', 'qrph'] } },
    });
  });

  it('does not retry a failed create, even with an idempotency key', async () => {
    const api = fakePayMongo().on('POST /v2/checkout_sessions', {
      status: 503,
      body: errorBody('internal_server_error'),
    });
    await expect(
      api.adapter().checkout!.create!({ ...input, idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ httpStatus: 503 });
    expect(api.requests).toHaveLength(1);
  });

  it.each([
    ['an unsupported payment method', { ...input, paymentMethods: ['crypto'] }],
    ['a non-string metadata value', { ...input, metadata: { count: 2 } }],
  ])('rejects %s before calling PayMongo', async (_label, bad) => {
    const api = fakePayMongo();
    await expect(api.adapter().checkout!.create!(bad as never)).rejects.toThrow(ValidationError);
    expect(api.requests).toEqual([]);
  });

  it('declares different payment methods for checkout than for direct payments', () => {
    const { capabilities } = fakePayMongo().adapter();
    const supports = (operation: 'checkout.create' | 'payments.create', paymentMethod: string) =>
      capabilities.check({ operation, paymentMethod }).supported;
    expect([supports('checkout.create', 'card'), supports('payments.create', 'card')]).toEqual([
      true,
      false,
    ]);
    expect([supports('checkout.create', 'qrph'), supports('payments.create', 'qrph')]).toEqual([
      true,
      false,
    ]);
    expect([supports('checkout.create', 'gcash'), supports('payments.create', 'gcash')]).toEqual([
      true,
      true,
    ]);
  });
});

describe('checkout.retrieve', () => {
  it('reports an unpaid active session as open, with the total from its line items', async () => {
    const api = fakePayMongo().on(`GET /v1/checkout_sessions/${CS}`, { body: session() });
    const result = await api.adapter().checkout!.retrieve!({ sessionId: CS });
    expect(result).toMatchObject({
      id: CS,
      status: 'open',
      providerStatus: 'active',
      amount: { value: 115000, currency: 'PHP' },
      reference: 'ORDER-123',
      metadata: { cart: 'c_1' },
      url: expect.stringContaining('checkout.paymongo.com'),
    });
    expect(result.paymentId).toBeUndefined();
  });

  it('reports a session with a paid payment as completed, although PayMongo still says active', async () => {
    const api = fakePayMongo().on(`GET /v1/checkout_sessions/${CS}`, {
      body: session(paidAttributes),
    });
    const result = await api.adapter().checkout!.retrieve!({ sessionId: CS });
    expect(result).toMatchObject({ status: 'completed', providerStatus: 'active', paymentId: PI });
  });

  it('does not treat failed attempts as completion', async () => {
    const api = fakePayMongo().on(`GET /v1/checkout_sessions/${CS}`, {
      body: session({ payments: [paidAttributes.payments[0]] }),
    });
    const result = await api.adapter().checkout!.retrieve!({ sessionId: CS });
    expect(result.status).toBe('open');
    expect(result.paymentId).toBeUndefined();
  });

  it.each([
    ['expired', 'expired'],
    ['something_new', 'unknown'],
  ])('maps status %s to %s', async (providerStatus, status) => {
    const api = fakePayMongo().on(`GET /v1/checkout_sessions/${CS}`, {
      body: session({ status: providerStatus }),
    });
    expect(await api.adapter().checkout!.retrieve!({ sessionId: CS })).toMatchObject({
      status,
      providerStatus,
    });
  });

  it('maps a missing session to checkout_session_not_found', async () => {
    await expect(
      fakePayMongo().adapter().checkout!.retrieve!({ sessionId: CS }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'checkout_session_not_found',
      httpStatus: 404,
    });
  });

  it('rejects a malformed session id without calling PayMongo', async () => {
    const api = fakePayMongo();
    await expect(api.adapter().checkout!.retrieve!({ sessionId: 'cs_1/expire' })).rejects.toThrow(
      ValidationError,
    );
    await expect(api.adapter().checkout!.expire!({ sessionId: '../payments' })).rejects.toThrow(
      ValidationError,
    );
    expect(api.requests).toEqual([]);
  });
});

describe('checkout.expire', () => {
  it('expires the session through the expire endpoint', async () => {
    const api = fakePayMongo().on(`POST /v1/checkout_sessions/${CS}/expire`, {
      body: session({ status: 'expired' }),
    });
    const result = await api.adapter().checkout!.expire!({ sessionId: CS });
    expect(result).toMatchObject({ status: 'expired', providerStatus: 'expired' });
    expect(api.requests[0]!.body).toBeUndefined();
  });

  it('surfaces PayMongo’s refusal for a paid session', async () => {
    const api = fakePayMongo().on(`POST /v1/checkout_sessions/${CS}/expire`, {
      status: 400,
      body: errorBody('not_allowed', 'Checkout session already has a paid payment.'),
    });
    await expect(api.adapter().checkout!.expire!({ sessionId: CS })).rejects.toMatchObject({
      name: 'ProviderError',
      providerCode: 'not_allowed',
      httpStatus: 400,
    });
  });
});

describe('checkout webhook', () => {
  const SECRET = 'whsk_culgate_fake_secret';
  const adapter = () => {
    const provider = paymongo();
    const config = provider.parseConfig(
      { provider: 'paymongo', secretKey: TEST_KEY, environment: 'test', webhookSecret: SECRET },
      { accountId: 'a' },
    );
    return provider.createAdapter({ accountId: 'a', config });
  };

  it('maps checkout_session.payment.paid to checkout.completed', () => {
    const body = JSON.stringify({
      data: {
        id: 'evt_checkout1',
        type: 'event',
        attributes: {
          type: 'checkout_session.payment.paid',
          livemode: false,
          created_at: 1767225700,
          data: session(paidAttributes).data,
        },
      },
    });
    const signature = createHmac('sha256', SECRET).update(`1767225700.${body}`).digest('hex');
    const request = {
      rawBody: body,
      headers: { 'paymongo-signature': `t=1767225700,te=${signature},li=` },
    };

    const webhooks = adapter().webhooks!;
    expect(() => webhooks.verify!(request)).not.toThrow();
    expect(webhooks.normalize!(request) as ProviderWebhookEvent).toMatchObject({
      id: 'evt_checkout1',
      type: 'checkout.completed',
      providerEventType: 'checkout_session.payment.paid',
      resourceId: CS,
      data: {
        sessionId: CS,
        paymentId: PI,
        reference: 'ORDER-123',
        amount: { value: 115000, currency: 'PHP' },
        providerStatus: 'active',
      },
    });
  });
});
