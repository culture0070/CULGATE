import { describe, expect, it } from 'vitest';
import { paymongo } from '../src/index.js';

/**
 * Runs against the real PayMongo sandbox. Skipped unless
 * PAYMONGO_TEST_SECRET_KEY is set to a TEST secret key (sk_test_...).
 *
 *   PAYMONGO_TEST_SECRET_KEY=sk_test_... pnpm --filter @culgate/provider-paymongo test
 *
 * It creates test-mode payment intents only; no money moves.
 */
const secretKey = process.env['PAYMONGO_TEST_SECRET_KEY'];
const enabled = typeof secretKey === 'string' && secretKey.startsWith('sk_test_');

describe.skipIf(!enabled)('PayMongo sandbox', () => {
  const adapter = () => {
    const provider = paymongo();
    const config = provider.parseConfig(
      { provider: 'paymongo', secretKey, environment: 'test' },
      { accountId: 'sandbox' },
    );
    return provider.createAdapter({ accountId: 'sandbox', config });
  };

  it('creates, retrieves, and cancels a GCash payment', async () => {
    const { payments } = adapter();
    const created = await payments!.create!({
      amount: { value: 10000, currency: 'PHP' },
      paymentMethod: { type: 'gcash' },
      returnUrls: { success: 'https://example.com/return' },
      reference: `culgate-sandbox-${Date.now()}`,
      idempotencyKey: `culgate-sandbox-${Date.now()}`,
    });
    expect(created.status).toBe('requires_action');
    expect(created.checkoutUrl).toMatch(/^https:\/\//);

    const retrieved = await payments!.retrieve!({ paymentId: created.id });
    expect(retrieved).toMatchObject({ id: created.id, reference: created.reference });

    const cancelled = await payments!.cancel!({ paymentId: created.id });
    expect(cancelled.status).toBe('cancelled');
  }, 30_000);

  it('creates, retrieves, and expires a checkout session', async () => {
    const { checkout } = adapter();
    const created = await checkout!.create!({
      lineItems: [{ name: 'Sandbox item', quantity: 2, amount: { value: 5000, currency: 'PHP' } }],
      total: { value: 10000, currency: 'PHP' },
      reference: `culgate-sandbox-${Date.now()}`,
      paymentMethods: ['card', 'gcash'],
      returnUrls: { success: 'https://example.com/ok', cancel: 'https://example.com/back' },
    });
    expect(created.status).toBe('open');
    expect(created.url).toMatch(/^https:\/\/checkout\.paymongo\.com\//);

    const retrieved = await checkout!.retrieve!({ sessionId: created.id });
    expect(retrieved).toMatchObject({
      id: created.id,
      status: 'open',
      providerStatus: 'active',
      amount: { value: 10000, currency: 'PHP' },
      reference: created.reference,
    });

    const expired = await checkout!.expire!({ sessionId: created.id });
    expect(expired.status).toBe('expired');
    await expect(checkout!.expire!({ sessionId: created.id })).rejects.toMatchObject({
      name: 'ProviderError',
      httpStatus: 400,
    });
  }, 30_000);

  it.each(['maya', 'grabpay', 'shopeepay', 'billease'])(
    'creates a %s payment',
    async (type) => {
      const { payments } = adapter();
      const created = await payments!.create!({
        amount: { value: 10000, currency: 'PHP' },
        paymentMethod: { type },
        returnUrls: { success: 'https://example.com/return' },
      });
      expect(created.status).toBe('requires_action');
      expect(created.checkoutUrl).toMatch(/^https:\/\//);
      await payments!.cancel!({ paymentId: created.id });
    },
    30_000,
  );

  it('reports a missing checkout session as not found', async () => {
    await expect(
      adapter().checkout!.retrieve!({ sessionId: 'cs_culgateDoesNotExist00000' }),
    ).rejects.toMatchObject({ code: 'checkout_session_not_found' });
  }, 30_000);

  it('reports a missing payment as not found', async () => {
    await expect(
      adapter().payments!.retrieve!({ paymentId: 'pi_culgateDoesNotExist000000' }),
    ).rejects.toMatchObject({ name: 'PaymentNotFoundError' });
  }, 30_000);

  it('reports a missing refund as not found (verifies the refund retrieve path)', async () => {
    await expect(
      adapter().refunds!.retrieve!({ refundId: 'ref_culgateDoesNotExist00000' }),
    ).rejects.toMatchObject({ code: 'refund_not_found' });
  }, 30_000);
});
