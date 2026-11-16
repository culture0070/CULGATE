import { mockProvider } from '@culgate/core/testing';
import { describe, expect, it } from 'vitest';
import { PaymentSDK, UnsupportedOperationError, ValidationError } from '../src/index.js';

function setup(mock = mockProvider()) {
  const sdk = new PaymentSDK({
    providers: [mock],
    accounts: {
      one: { provider: 'mock', secretKey: 'sk-one', environment: 'test' },
      two: { provider: 'mock', secretKey: 'sk-two', environment: 'test' },
    },
  });
  return { sdk, mock };
}

const cart = [
  { name: 'T-shirt', quantity: 2, amount: { value: 50000, currency: 'PHP' } },
  {
    name: 'Shipping',
    quantity: 1,
    amount: { value: 15000, currency: 'PHP' },
    description: 'Standard',
  },
];

describe('checkout.create', () => {
  it('creates a hosted session for the selected account and totals the line items', async () => {
    const { sdk, mock } = setup();
    const session = await sdk.checkout.create({
      account: 'one',
      lineItems: cart,
      reference: 'ORDER-123',
      returnUrls: { success: 'https://example.com/ok', cancel: 'https://example.com/back' },
      metadata: { cart: 'c_1' },
    });

    expect(session).toMatchObject({
      accountId: 'one',
      provider: 'mock',
      status: 'open',
      providerStatus: 'mock_open',
      amount: { value: 115000, currency: 'PHP' }, // 2 x 500.00 + 150.00
      reference: 'ORDER-123',
      metadata: { cart: 'c_1' },
    });
    expect(session.url).toMatch(/^https:\/\//);
    expect(session.providerSessionId).toBe(session.id);
    expect(session.paymentId).toBeUndefined();
    expect(mock.callsFor('two')).toEqual([]);
    expect(mock.calls[0]).toMatchObject({ accountId: 'one', operation: 'checkout.create' });
    expect((mock.calls[0]!.input as { total: unknown }).total).toEqual({
      value: 115000,
      currency: 'PHP',
    });
  });

  it.each([
    ['no line items', { lineItems: [] }],
    ['a zero quantity', { lineItems: [{ ...cart[0], quantity: 0 }] }],
    ['a fractional quantity', { lineItems: [{ ...cart[0], quantity: 1.5 }] }],
    ['a float amount', { lineItems: [{ ...cart[0], amount: { value: 10.5, currency: 'PHP' } }] }],
    ['a zero amount', { lineItems: [{ ...cart[0], amount: { value: 0, currency: 'PHP' } }] }],
    ['a nameless item', { lineItems: [{ ...cart[0], name: '' }] }],
    [
      'mixed currencies',
      { lineItems: [cart[0], { ...cart[1], amount: { value: 100, currency: 'USD' } }] },
    ],
    [
      'a total beyond safe integers',
      {
        lineItems: [
          { name: 'x', quantity: Number.MAX_SAFE_INTEGER, amount: { value: 2, currency: 'PHP' } },
        ],
      },
    ],
    ['more than 100 items', { lineItems: Array.from({ length: 101 }, () => cart[0]) }],
    ['an empty paymentMethods list', { lineItems: cart, paymentMethods: [] }],
    ['a repeated payment method', { lineItems: cart, paymentMethods: ['card', 'card'] }],
    ['a non-http return URL', { lineItems: cart, returnUrls: { success: 'javascript:alert(1)' } }],
  ])('rejects %s before reaching the provider', async (_label, input) => {
    const { sdk, mock } = setup();
    await expect(sdk.checkout.create({ account: 'one', ...input } as never)).rejects.toThrow(
      ValidationError,
    );
    expect(mock.calls).toEqual([]);
  });

  it('rejects any requested payment method the provider does not offer', async () => {
    const { sdk, mock } = setup(mockProvider({ paymentMethods: ['card', 'gcash'] }));
    const error = await sdk.checkout
      .create({ account: 'one', lineItems: cart, paymentMethods: ['card', 'crypto'] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect(error).toMatchObject({
      operation: 'checkout.create',
      accountId: 'one',
      reason: expect.stringContaining('"crypto"'),
    });
    expect(mock.calls).toEqual([]);
  });

  it('is rejected when the provider has no checkout', async () => {
    const { sdk } = setup(mockProvider({ operations: ['payments.create'] }));
    expect(sdk.capabilities.supports({ account: 'one', operation: 'checkout.create' })).toBe(false);
    await expect(sdk.checkout.create({ account: 'one', lineItems: cart })).rejects.toThrow(
      UnsupportedOperationError,
    );
  });
});

describe('checkout lifecycle', () => {
  it('reports the payment once the customer pays, and that payment can be refunded', async () => {
    const { sdk, mock } = setup();
    const session = await sdk.checkout.create({
      account: 'one',
      lineItems: cart,
      reference: 'ORDER-9',
    });

    // An open session is not a payment.
    expect((await sdk.checkout.retrieve({ account: 'one', sessionId: session.id })).status).toBe(
      'open',
    );

    const paymentId = mock.completeCheckout('one', session.id);
    const completed = await sdk.checkout.retrieve({ account: 'one', sessionId: session.id });
    expect(completed).toMatchObject({ status: 'completed', paymentId });

    const payment = await sdk.payments.retrieve({
      account: 'one',
      paymentId: completed.paymentId!,
    });
    expect(payment).toMatchObject({
      status: 'succeeded',
      amount: { value: 115000 },
      reference: 'ORDER-9',
    });

    const refund = await sdk.refunds.create({
      account: 'one',
      paymentId: completed.paymentId!,
      amount: { value: 15000, currency: 'PHP' },
    });
    expect(refund).toMatchObject({ status: 'succeeded', paymentId });
  });

  it('expires an open session, and refuses to expire a paid one', async () => {
    const { sdk, mock } = setup();
    const open = await sdk.checkout.create({ account: 'one', lineItems: cart });
    await expect(
      sdk.checkout.expire({ account: 'one', sessionId: open.id }),
    ).resolves.toMatchObject({
      status: 'expired',
    });

    const paid = await sdk.checkout.create({ account: 'one', lineItems: cart });
    mock.completeCheckout('one', paid.id);
    await expect(sdk.checkout.expire({ account: 'one', sessionId: paid.id })).rejects.toMatchObject(
      {
        name: 'ProviderError',
        providerCode: 'session_not_open',
        accountId: 'one',
      },
    );
  });

  it('isolates sessions per account', async () => {
    const { sdk } = setup();
    const session = await sdk.checkout.create({ account: 'one', lineItems: cart });
    await expect(
      sdk.checkout.retrieve({ account: 'two', sessionId: session.id }),
    ).rejects.toMatchObject({
      code: 'checkout_session_not_found',
      accountId: 'two',
    });
  });

  it('returns the same session for a repeated idempotency key', async () => {
    const { sdk } = setup();
    const input = { account: 'one', lineItems: cart, idempotencyKey: 'order-1-checkout' } as const;
    const first = await sdk.checkout.create(input);
    const replay = await sdk.checkout.create(input);
    expect(replay.id).toBe(first.id);
  });
});
