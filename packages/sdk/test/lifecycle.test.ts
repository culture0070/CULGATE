import { mockProvider } from '@culgate/core/testing';
import { describe, expect, it } from 'vitest';
import {
  PaymentNotFoundError,
  PaymentSDK,
  ProviderError,
  RefundError,
  UnsupportedOperationError,
  ValidationError,
} from '../src/index.js';

function setup(mock = mockProvider()) {
  const sdk = new PaymentSDK({
    providers: [mock],
    accounts: {
      'mock-one': { provider: 'mock', secretKey: 'test-secret-one', environment: 'test' },
      'mock-two': { provider: 'mock', secretKey: 'test-secret-two', environment: 'test' },
    },
  });
  const pay = (value = 150000) =>
    sdk.payments.create({ account: 'mock-one', amount: { value, currency: 'PHP' } });
  return { sdk, mock, pay };
}

describe('payments.cancel', () => {
  it('cancels a pending payment', async () => {
    const { sdk, pay } = setup();
    const payment = await pay();
    const cancelled = await sdk.payments.cancel({ account: 'mock-one', paymentId: payment.id });
    expect(cancelled).toMatchObject({
      id: payment.id,
      accountId: 'mock-one',
      provider: 'mock',
      status: 'cancelled',
      providerStatus: 'mock_cancelled',
    });
  });

  it('surfaces the provider’s refusal for a completed payment', async () => {
    const { sdk, mock, pay } = setup();
    const payment = await pay();
    mock.setPaymentStatus('mock-one', payment.id, 'succeeded');

    const error = await sdk.payments
      .cancel({ account: 'mock-one', paymentId: payment.id })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      httpStatus: 409,
      providerCode: 'payment_not_cancellable',
      accountId: 'mock-one',
      provider: 'mock',
    });
  });
});

describe('payments.capture', () => {
  it('does not treat an authorized payment as succeeded until captured', async () => {
    const { sdk, mock, pay } = setup();
    const payment = await pay();
    mock.setPaymentStatus('mock-one', payment.id, 'authorized');
    expect(
      (await sdk.payments.retrieve({ account: 'mock-one', paymentId: payment.id })).status,
    ).toBe('authorized');

    const captured = await sdk.payments.capture({ account: 'mock-one', paymentId: payment.id });
    expect(captured).toMatchObject({ status: 'succeeded', amount: { value: 150000 } });
  });

  it('supports partial capture', async () => {
    const { sdk, mock, pay } = setup();
    const payment = await pay();
    mock.setPaymentStatus('mock-one', payment.id, 'authorized');
    const captured = await sdk.payments.capture({
      account: 'mock-one',
      paymentId: payment.id,
      amount: { value: 100000, currency: 'PHP' },
    });
    expect(captured.amount).toEqual({ value: 100000, currency: 'PHP' });
  });

  it('rejects capturing a payment that is not authorized', async () => {
    const { sdk, pay } = setup();
    const payment = await pay();
    await expect(
      sdk.payments.capture({ account: 'mock-one', paymentId: payment.id }),
    ).rejects.toMatchObject({ providerCode: 'payment_not_capturable' });
  });
});

describe('refunds', () => {
  async function paid() {
    const context = setup();
    const payment = await context.pay();
    context.mock.setPaymentStatus('mock-one', payment.id, 'succeeded');
    return { ...context, payment };
  }

  it('refunds in full when no amount is given', async () => {
    const { sdk, payment } = await paid();
    const refund = await sdk.refunds.create({
      account: 'mock-one',
      paymentId: payment.id,
      reason: 'requested_by_customer',
    });

    expect(refund).toMatchObject({
      accountId: 'mock-one',
      provider: 'mock',
      paymentId: payment.id,
      amount: { value: 150000, currency: 'PHP' },
      status: 'succeeded',
      providerStatus: 'mock_succeeded',
      reason: 'requested_by_customer',
    });
    expect(refund.providerRefundId).toBe(refund.id);
    expect(
      (await sdk.payments.retrieve({ account: 'mock-one', paymentId: payment.id })).status,
    ).toBe('refunded');
  });

  it('tracks partial refunds and refuses to exceed the balance', async () => {
    const { sdk, payment } = await paid();
    const refundOf = (value: number) =>
      sdk.refunds.create({
        account: 'mock-one',
        paymentId: payment.id,
        amount: { value, currency: 'PHP' },
      });
    const status = async () =>
      (await sdk.payments.retrieve({ account: 'mock-one', paymentId: payment.id })).status;

    await refundOf(50000);
    expect(await status()).toBe('partially_refunded');

    const error = await refundOf(100001).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RefundError);
    expect(error).toMatchObject({ providerCode: 'refund_exceeds_balance', accountId: 'mock-one' });

    await refundOf(100000);
    expect(await status()).toBe('refunded');
  });

  it('does not refund twice when the same idempotency key is retried', async () => {
    const { sdk, payment } = await paid();
    const input = {
      account: 'mock-one',
      paymentId: payment.id,
      amount: { value: 50000, currency: 'PHP' },
      idempotencyKey: 'refund-1',
    } as const;

    const first = await sdk.refunds.create(input);
    const replay = await sdk.refunds.create(input);
    expect(replay.id).toBe(first.id);

    // Only 50000 was refunded, so the remaining 100000 is still refundable.
    await expect(
      sdk.refunds.create({
        ...input,
        amount: { value: 100000, currency: 'PHP' },
        idempotencyKey: 'refund-2',
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('refuses to refund an unpaid payment', async () => {
    const { sdk, pay } = setup();
    const payment = await pay();
    await expect(
      sdk.refunds.create({ account: 'mock-one', paymentId: payment.id }),
    ).rejects.toMatchObject({ name: 'RefundError', providerCode: 'payment_not_refundable' });
  });

  it('retrieves refunds, isolated per account', async () => {
    const { sdk, payment } = await paid();
    const refund = await sdk.refunds.create({ account: 'mock-one', paymentId: payment.id });

    await expect(
      sdk.refunds.retrieve({ account: 'mock-one', refundId: refund.id }),
    ).resolves.toMatchObject({ id: refund.id, accountId: 'mock-one' });
    await expect(
      sdk.refunds.retrieve({ account: 'mock-two', refundId: refund.id }),
    ).rejects.toMatchObject({
      name: 'RefundError',
      code: 'refund_not_found',
      accountId: 'mock-two',
    });
    // Another account cannot refund this payment either.
    await expect(
      sdk.refunds.create({ account: 'mock-two', paymentId: payment.id }),
    ).rejects.toThrow(PaymentNotFoundError);
  });

  it.each([
    ['missing paymentId', { account: 'mock-one' }],
    ['zero amount', { account: 'mock-one', paymentId: 'p', amount: { value: 0, currency: 'PHP' } }],
    [
      'float amount',
      { account: 'mock-one', paymentId: 'p', amount: { value: 1.5, currency: 'PHP' } },
    ],
    ['empty reason', { account: 'mock-one', paymentId: 'p', reason: '' }],
  ])('validates input: %s', async (_label, input) => {
    const { sdk, mock } = setup();
    await expect(sdk.refunds.create(input as never)).rejects.toThrow(ValidationError);
    expect(mock.calls).toEqual([]);
  });
});

describe('unsupported operations', () => {
  it.each([
    [
      'payments.cancel',
      (sdk: PaymentSDK) => sdk.payments.cancel({ account: 'mock-one', paymentId: 'p' }),
    ],
    [
      'payments.capture',
      (sdk: PaymentSDK) => sdk.payments.capture({ account: 'mock-one', paymentId: 'p' }),
    ],
    [
      'refunds.create',
      (sdk: PaymentSDK) => sdk.refunds.create({ account: 'mock-one', paymentId: 'p' }),
    ],
    [
      'refunds.retrieve',
      (sdk: PaymentSDK) => sdk.refunds.retrieve({ account: 'mock-one', refundId: 'r' }),
    ],
  ] as const)(
    '%s fails with UnsupportedOperationError and never reaches the provider',
    async (operation, call) => {
      const { sdk, mock } = setup(
        mockProvider({ operations: ['payments.create', 'payments.retrieve'] }),
      );
      const error = await call(sdk as unknown as PaymentSDK).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnsupportedOperationError);
      expect(error).toMatchObject({ operation, accountId: 'mock-one', provider: 'mock' });
      expect(mock.calls).toEqual([]);
    },
  );
});
