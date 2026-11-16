import { mockProvider } from '@culgate/core/testing';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
import { xendit, xenditAccountFromEnv } from '@culgate/provider-xendit';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  type FetchLike,
  PaymentSDK,
  UnsupportedOperationError,
  ValidationError,
} from '../src/index.js';

const PAYMONGO_KEY = 'sk_test_escape_hatch_fake';
const XENDIT_KEY = 'xendit-escape-hatch-key';

function setup(reply: () => Response = () => Response.json({ data: [] })) {
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return reply();
  };
  const sdk = new PaymentSDK({
    providers: [paymongo(), xendit()],
    fetch,
    accounts: {
      // Accounts built from an environment source, as an application would.
      pm: paymongoAccountFromEnv({ env: { PAYMONGO_SECRET_KEY: PAYMONGO_KEY } }),
      xn: xenditAccountFromEnv({
        env: { XENDIT_SECRET_KEY: XENDIT_KEY, XENDIT_ENVIRONMENT: 'test' },
      }),
    },
  });
  return { sdk, calls };
}

describe('sdk.accounts.getClient().providerRequest', () => {
  it('calls the account’s own provider with its own credentials', async () => {
    const { sdk, calls } = setup();

    const paymongoClient = sdk.accounts.getClient('pm');
    const response = await paymongoClient.providerRequest<{ data: unknown[] }>({
      method: 'GET',
      path: '/v1/payments',
      query: { limit: 5 },
    });
    await sdk.accounts.getClient('xn').providerRequest({ method: 'GET', path: '/v2/invoices' });

    expect(paymongoClient).toMatchObject({ accountId: 'pm', provider: 'paymongo' });
    expect(response).toMatchObject({ status: 200, body: { data: [] } });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.paymongo.com/v1/payments?limit=5',
      'https://api.xendit.co/v2/invoices',
    ]);
    expect(calls[0]!.headers.get('authorization')).toBe(`Basic ${btoa(`${PAYMONGO_KEY}:`)}`);
    expect(calls[1]!.headers.get('authorization')).toBe(`Basic ${btoa(`${XENDIT_KEY}:`)}`);
  });

  it('lets the caller choose a Xendit API version, and sends none by default', async () => {
    const { sdk, calls } = setup();
    const client = sdk.accounts.getClient('xn');

    await client.providerRequest({
      method: 'POST',
      path: '/v3/payouts',
      headers: { 'api-version': '2025-09-01' },
      body: { reference_id: 'payout-1' },
    });
    await client.providerRequest({ method: 'GET', path: '/customers/cust-1' });

    expect(calls[0]!.headers.get('api-version')).toBe('2025-09-01');
    expect(calls[0]!.body).toEqual({ reference_id: 'payout-1' });
    expect(calls[1]!.headers.has('api-version')).toBe(false);
  });

  it('cannot be pointed at another host or given other credentials', async () => {
    const { sdk, calls } = setup();
    const client = sdk.accounts.getClient('pm');
    const attempts = [
      { method: 'GET', path: 'https://evil.example/steal' },
      { method: 'GET', path: '//evil.example/steal' },
      { method: 'GET', path: '/v1/payments/../../../etc' },
      { method: 'GET', path: '/v1/payments', baseUrl: 'https://evil.example' },
      { method: 'GET', path: '/v1/payments', headers: { Authorization: 'Basic attacker' } },
      { method: 'GET', path: '/v1/payments', headers: { Host: 'evil.example' } },
    ];
    for (const attempt of attempts) {
      await expect(client.providerRequest(attempt as never)).rejects.toThrow(ValidationError);
    }
    expect(calls).toEqual([]);
  });

  it('maps provider errors and attaches the account, without exposing the key', async () => {
    const { sdk } = setup(() =>
      Response.json(
        { errors: [{ code: 'api_key_not_found', detail: 'The API key does not exist.' }] },
        { status: 401 },
      ),
    );
    const error = await sdk.accounts
      .getClient('pm')
      .providerRequest({ method: 'GET', path: '/v1/payments' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({
      accountId: 'pm',
      provider: 'paymongo',
      providerCode: 'api_key_not_found',
    });
    expect(JSON.stringify(error) + String(error)).not.toContain(PAYMONGO_KEY);
  });

  it('is reported through capabilities and rejected when unsupported', async () => {
    const { sdk } = setup();
    expect(sdk.capabilities.supports({ account: 'pm', operation: 'provider.request' })).toBe(true);

    const restricted = new PaymentSDK({
      providers: [mockProvider({ operations: ['payments.create'] })],
      accounts: { m: { provider: 'mock', secretKey: 's', environment: 'test' } },
    });
    await expect(
      restricted.accounts.getClient('m').providerRequest({ method: 'GET', path: '/x' }),
    ).rejects.toThrow(UnsupportedOperationError);
  });

  it('requires a configured account and exposes no credentials', () => {
    const { sdk } = setup();
    expect(() => sdk.accounts.getClient('nope' as 'pm')).toThrow(/is not configured/);
    const client = sdk.accounts.getClient('pm');
    expect(JSON.stringify(client)).toBe('{"accountId":"pm","provider":"paymongo"}');
    expect(Object.isFrozen(client)).toBe(true);
  });
});
