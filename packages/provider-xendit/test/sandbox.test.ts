import { describe, expect, it } from 'vitest';
import { xendit, XENDIT_API_BASE_URL, XENDIT_API_VERSION } from '../src/index.js';

/**
 * Runs against the real Xendit API in TEST mode. Skipped unless both are set:
 *
 *   XENDIT_TEST_SECRET_KEY=<a TEST-mode secret key>
 *   XENDIT_SANDBOX_CONFIRM_TEST_MODE=yes
 *
 *   XENDIT_TEST_SECRET_KEY=... XENDIT_SANDBOX_CONFIRM_TEST_MODE=yes \
 *     pnpm --filter @culgate/provider-xendit test
 *
 * Xendit does not document a key prefix that distinguishes test from live
 * keys, so this suite cannot check the key itself: the second variable is
 * your confirmation that the key is a test-mode key. With a live key these
 * tests would create real payment requests.
 */
const secretKey = process.env['XENDIT_TEST_SECRET_KEY'];
const enabled = Boolean(secretKey) && process.env['XENDIT_SANDBOX_CONFIRM_TEST_MODE'] === 'yes';

describe.skipIf(!enabled)('Xendit sandbox', () => {
  const adapter = () => {
    const provider = xendit();
    const config = provider.parseConfig(
      { provider: 'xendit', secretKey, environment: 'test' },
      { accountId: 'sandbox' },
    );
    return provider.createAdapter({ accountId: 'sandbox', config });
  };
  const input = (type: string) => ({
    amount: { value: 10000, currency: 'PHP' },
    paymentMethod: { type },
    returnUrls: { success: 'https://example.com/return', cancel: 'https://example.com/cancel' },
    reference: `culgate-sandbox-${type}-${Date.now()}`,
  });

  it.each(['gcash', 'shopeepay'])(
    'creates, retrieves, and cancels a %s payment',
    async (type) => {
      const { payments } = adapter();
      const created = await payments!.create!(input(type));
      expect(created.status).toBe('requires_action');
      expect(created.checkoutUrl).toMatch(/^https:\/\//);
      expect(created.amount).toEqual({ value: 10000, currency: 'PHP' });

      const retrieved = await payments!.retrieve!({ paymentId: created.id });
      expect(retrieved).toMatchObject({ id: created.id, reference: created.reference });

      const cancelled = await payments!.cancel!({ paymentId: created.id });
      expect(cancelled.status).toBe('cancelled');
    },
    30_000,
  );

  it('refunds a simulated payment and retrieves the refund', async () => {
    const { payments, refunds } = adapter();
    const created = await payments!.create!(input('gcash'));

    // Test-mode only endpoint that completes the payment without a customer.
    const simulated = await fetch(
      `${XENDIT_API_BASE_URL}/v3/payment_requests/${created.id}/simulate`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`${secretKey}:`)}`,
          'api-version': XENDIT_API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ amount: 100 }),
      },
    );
    expect(simulated.ok).toBe(true);

    let status = created.status;
    for (let attempt = 0; attempt < 15 && status !== 'succeeded'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      status = (await payments!.retrieve!({ paymentId: created.id })).status;
    }
    expect(status).toBe('succeeded');

    const refund = await refunds!.create!({
      paymentId: created.id,
      amount: { value: 2500, currency: 'PHP' },
      reason: 'requested_by_customer',
    });
    expect(refund).toMatchObject({
      paymentId: created.id,
      amount: { value: 2500, currency: 'PHP' },
    });

    const retrieved = await refunds!.retrieve!({ refundId: refund.id });
    expect(retrieved).toMatchObject({ id: refund.id, paymentId: created.id });
  }, 90_000);

  it('reports a missing payment as not found', async () => {
    await expect(
      adapter().payments!.retrieve!({ paymentId: 'pr-00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ name: 'PaymentNotFoundError' });
  }, 30_000);
});
