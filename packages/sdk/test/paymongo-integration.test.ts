import { mockProvider } from '@culgate/core/testing';
import { paymongo } from '@culgate/provider-paymongo';
import { describe, expect, it } from 'vitest';
import { type FetchLike, PaymentSDK, UnsupportedOperationError } from '../src/index.js';

const KEY = 'sk_test_integration_fake';

/** Minimal PayMongo stand-in: enough for one GCash payment. */
function fakeApi() {
  const calls: string[] = [];
  const intent = (status: string, extra: object = {}) => ({
    data: {
      id: 'pi_abc123',
      type: 'payment_intent',
      attributes: {
        amount: 150000,
        currency: 'PHP',
        status,
        payment_method_allowed: ['gcash'],
        metadata: { culgate_reference: 'ORDER-123' },
        created_at: 1586179682,
        updated_at: 1586179682,
        ...extra,
      },
    },
  });
  const fetch: FetchLike = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push(`${init.method} ${pathname} ${(init.headers as Headers).get('authorization')}`);
    if (pathname === '/v1/payment_intents') return Response.json(intent('awaiting_payment_method'));
    if (pathname === '/v1/payment_methods') return Response.json({ data: { id: 'pm_abc123' } });
    return Response.json(
      intent('awaiting_next_action', {
        next_action: { type: 'redirect', redirect: { url: 'https://pay.example/redirect' } },
      }),
    );
  };
  return { fetch, calls };
}

describe('PaymentSDK with the PayMongo provider', () => {
  it('routes the same call to PayMongo or the mock by account ID alone', async () => {
    const api = fakeApi();
    const mock = mockProvider();
    const sdk = new PaymentSDK({
      providers: [paymongo(), mock],
      fetch: api.fetch,
      accounts: {
        'paymongo-primary': { provider: 'paymongo', secretKey: KEY, environment: 'test' },
        'mock-primary': { provider: 'mock', secretKey: 'mock-secret', environment: 'test' },
      },
    });
    const order = {
      amount: { value: 150000, currency: 'PHP' },
      paymentMethod: { type: 'gcash' },
      reference: 'ORDER-123',
      returnUrls: { success: 'https://example.com/payment/success' },
    };

    const viaPayMongo = await sdk.payments.create({ account: 'paymongo-primary', ...order });
    const viaMock = await sdk.payments.create({ account: 'mock-primary', ...order });

    expect(viaPayMongo).toMatchObject({
      accountId: 'paymongo-primary',
      provider: 'paymongo',
      id: 'pi_abc123',
      status: 'requires_action',
      providerStatus: 'awaiting_next_action',
      reference: 'ORDER-123',
      checkoutUrl: 'https://pay.example/redirect',
    });
    expect(viaMock).toMatchObject({
      accountId: 'mock-primary',
      provider: 'mock',
      status: 'pending',
    });

    expect(api.calls).toHaveLength(3);
    expect(api.calls.every((call) => call.endsWith(`Basic ${btoa(`${KEY}:`)}`))).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  it('rejects what PayMongo cannot do before any request is sent', async () => {
    const api = fakeApi();
    const sdk = new PaymentSDK({
      providers: [paymongo()],
      fetch: api.fetch,
      accounts: { main: { provider: 'paymongo', secretKey: KEY, environment: 'test' } },
    });
    const amount = { value: 150000, currency: 'PHP' };

    await expect(sdk.payments.capture({ account: 'main', paymentId: 'pi_abc123' })).rejects.toThrow(
      UnsupportedOperationError,
    );
    await expect(
      sdk.payments.create({ account: 'main', amount: { value: 1500, currency: 'USD' } }),
    ).rejects.toThrow(/currency "USD"/);
    await expect(
      sdk.payments.create({ account: 'main', amount, paymentMethod: { type: 'card' } }),
    ).rejects.toThrow(/payment method "card"/);
    expect(api.calls).toEqual([]);
    expect(sdk.capabilities.operations('main')).not.toContain('payments.capture');
  });

  it('keeps the secret key out of SDK serialization', () => {
    const sdk = new PaymentSDK({
      providers: [paymongo()],
      accounts: { main: { provider: 'paymongo', secretKey: KEY, environment: 'test' } },
    });
    expect(JSON.stringify(sdk)).not.toContain(KEY);
  });
});
