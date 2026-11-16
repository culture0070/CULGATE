import { paymongo } from '@culgate/provider-paymongo';
import { xendit } from '@culgate/provider-xendit';
import { describe, expect, it } from 'vitest';
import { type FetchLike, PaymentSDK } from '../src/index.js';

/** Answers as PayMongo or Xendit depending on the host, recording every call. */
function fakeGateways() {
  const calls: { host: string; path: string; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const { host, pathname } = new URL(url);
    calls.push({
      host,
      path: pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (host === 'api.xendit.co') {
      return Response.json({
        payment_request_id: 'pr-123',
        reference_id: 'ORDER-123',
        currency: 'PHP',
        request_amount: 1500,
        channel_code: 'GCASH',
        status: 'REQUIRES_ACTION',
        actions: [
          { type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://xendit.example/pay' },
        ],
      });
    }
    if (pathname === '/v1/payment_methods') return Response.json({ data: { id: 'pm_123' } });
    const attached = pathname.endsWith('/attach');
    return Response.json({
      data: {
        id: 'pi_123',
        attributes: {
          amount: 150000,
          currency: 'PHP',
          status: attached ? 'awaiting_next_action' : 'awaiting_payment_method',
          payment_method_allowed: ['gcash'],
          metadata: { culgate_reference: 'ORDER-123' },
          next_action: attached
            ? { type: 'redirect', redirect: { url: 'https://paymongo.example/pay' } }
            : null,
        },
      },
    });
  };
  return { fetch, calls };
}

describe('one order, two gateways', () => {
  it('switches provider by changing only the account ID', async () => {
    const gateways = fakeGateways();
    const sdk = new PaymentSDK({
      providers: [paymongo(), xendit()],
      fetch: gateways.fetch,
      accounts: {
        'paymongo-primary': {
          provider: 'paymongo',
          secretKey: 'sk_test_paymongoKEY00000',
          environment: 'test',
        },
        'xendit-primary': {
          provider: 'xendit',
          secretKey: 'xendit-test-secret-key',
          environment: 'test',
        },
      },
    });

    // The application's own code path: identical input for both providers.
    const charge = (account: 'paymongo-primary' | 'xendit-primary') =>
      sdk.payments.create({
        account,
        amount: { value: 150000, currency: 'PHP' },
        paymentMethod: { type: 'gcash' },
        reference: 'ORDER-123',
        returnUrls: {
          success: 'https://example.com/success',
          cancel: 'https://example.com/cancel',
        },
      });

    const viaPayMongo = await charge('paymongo-primary');
    const viaXendit = await charge('xendit-primary');

    // Same normalized shape...
    for (const payment of [viaPayMongo, viaXendit]) {
      expect(payment).toMatchObject({
        amount: { value: 150000, currency: 'PHP' },
        status: 'requires_action',
        reference: 'ORDER-123',
        paymentMethod: { type: 'gcash' },
        checkoutUrl: expect.stringMatching(/^https:/),
      });
    }
    // ...with each provider's own identity and vocabulary preserved.
    expect(viaPayMongo).toMatchObject({
      accountId: 'paymongo-primary',
      provider: 'paymongo',
      id: 'pi_123',
      providerStatus: 'awaiting_next_action',
      paymentMethod: { providerType: 'gcash' },
    });
    expect(viaXendit).toMatchObject({
      accountId: 'xendit-primary',
      provider: 'xendit',
      id: 'pr-123',
      providerStatus: 'REQUIRES_ACTION',
      paymentMethod: { providerType: 'GCASH' },
    });

    // Each provider received its own amount representation.
    const sent = (host: string) => gateways.calls.find((call) => call.host === host)!.body;
    expect(sent('api.paymongo.com')).toMatchObject({ data: { attributes: { amount: 150000 } } });
    expect(sent('api.xendit.co')).toMatchObject({ request_amount: 1500 });
    expect(gateways.calls.filter((call) => call.host === 'api.xendit.co')).toHaveLength(1);
    expect(gateways.calls.filter((call) => call.host === 'api.paymongo.com')).toHaveLength(3);
  });

  it('reports each provider’s real differences through capabilities', () => {
    const sdk = new PaymentSDK({
      providers: [paymongo(), xendit()],
      accounts: {
        pm: { provider: 'paymongo', secretKey: 'sk_test_paymongoKEY00000', environment: 'test' },
        xn: {
          provider: 'xendit',
          secretKey: 'xendit-test-secret-key',
          environment: 'test',
          webhookToken: 'tok',
        },
      },
    });
    const supports = (account: 'pm' | 'xn', paymentMethod: string) =>
      sdk.capabilities.supports({ account, operation: 'payments.create', paymentMethod });

    expect([supports('pm', 'gcash'), supports('xn', 'gcash')]).toEqual([true, true]);
    expect([supports('pm', 'maya'), supports('xn', 'maya')]).toEqual([true, false]);
    expect([supports('pm', 'shopeepay'), supports('xn', 'shopeepay')]).toEqual([true, true]);
    expect([supports('pm', 'billease'), supports('xn', 'billease')]).toEqual([true, false]);
    expect(sdk.capabilities.supports({ account: 'pm', operation: 'webhooks.verify' })).toBe(false);
    expect(sdk.capabilities.supports({ account: 'xn', operation: 'webhooks.verify' })).toBe(true);
  });
});
