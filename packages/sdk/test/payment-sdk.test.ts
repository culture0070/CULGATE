import { inspect } from 'node:util';
import { fingerprintSecret, mockProvider } from '@culgate/core/testing';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  PaymentNotFoundError,
  PaymentSDK,
  UnsupportedOperationError,
  ValidationError,
} from '../src/index.js';
import { otherProvider } from './helpers.js';

const SECRET_ONE = 'test-secret-one';
const SECRET_TWO = 'test-secret-two';

function createSdk(mock = mockProvider()) {
  const sdk = new PaymentSDK({
    providers: [mock],
    accounts: {
      'mock-one': { provider: 'mock', secretKey: SECRET_ONE, environment: 'test' },
      'mock-two': { provider: 'mock', secretKey: SECRET_TWO, environment: 'test' },
    },
  });
  return { sdk, mock };
}

describe('sprint acceptance: explicit account selection', () => {
  it('routes payments.create to the selected account only', async () => {
    const { sdk, mock } = createSdk();

    const result = await sdk.payments.create({
      account: 'mock-one',
      amount: { value: 150000, currency: 'PHP' },
      reference: 'ORDER-123',
    });

    expect(result).toMatchObject({
      accountId: 'mock-one',
      provider: 'mock',
      amount: { value: 150000, currency: 'PHP' },
      reference: 'ORDER-123',
      status: 'pending',
      providerStatus: 'mock_pending',
    });
    expect(result.providerPaymentId).toBe(result.id);
    expect(result.raw).toBeDefined();

    // The call went through the real registry -> account -> adapter path...
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({
      accountId: 'mock-one',
      operation: 'payments.create',
      credentialFingerprint: fingerprintSecret(SECRET_ONE),
    });
    // ...and the other account was never touched.
    expect(mock.callsFor('mock-two')).toEqual([]);
  });
});

describe('multiple accounts on the same provider', () => {
  it('uses each account’s own credentials', async () => {
    const { sdk, mock } = createSdk();
    const amount = { value: 1000, currency: 'PHP' };

    await sdk.payments.create({ account: 'mock-two', amount });
    await sdk.payments.create({ account: 'mock-one', amount });

    expect(mock.calls.map((call) => [call.accountId, call.credentialFingerprint])).toEqual([
      ['mock-two', fingerprintSecret(SECRET_TWO)],
      ['mock-one', fingerprintSecret(SECRET_ONE)],
    ]);
  });

  it('isolates account data: one account cannot retrieve another’s payment', async () => {
    const { sdk } = createSdk();
    const payment = await sdk.payments.create({
      account: 'mock-one',
      amount: { value: 1000, currency: 'PHP' },
    });

    await expect(
      sdk.payments.retrieve({ account: 'mock-one', paymentId: payment.id }),
    ).resolves.toMatchObject({ id: payment.id, accountId: 'mock-one' });

    const error = await sdk.payments
      .retrieve({ account: 'mock-two', paymentId: payment.id })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentNotFoundError);
    expect(error).toMatchObject({ accountId: 'mock-two', provider: 'mock' });
  });

  it('scopes idempotency keys to the account', async () => {
    const { sdk } = createSdk();
    const input = { amount: { value: 1000, currency: 'PHP' }, idempotencyKey: 'order-1' };

    const first = await sdk.payments.create({ account: 'mock-one', ...input });
    const replay = await sdk.payments.create({ account: 'mock-one', ...input });
    const otherAccount = await sdk.payments.create({ account: 'mock-two', ...input });

    expect(replay.id).toBe(first.id);
    expect(otherAccount.id).not.toBe(first.id);
  });

  it('is unaffected by later mutation of the caller’s config object', async () => {
    const mock = mockProvider();
    const accounts = {
      primary: { provider: 'mock' as const, secretKey: SECRET_ONE, environment: 'test' as const },
    };
    const sdk = new PaymentSDK({ providers: [mock], accounts });

    accounts.primary.secretKey = SECRET_TWO;
    await sdk.payments.create({ account: 'primary', amount: { value: 1, currency: 'PHP' } });

    expect(mock.calls[0]?.credentialFingerprint).toBe(fingerprintSecret(SECRET_ONE));
  });
});

describe('provider selection', () => {
  it('switches provider by changing only the account ID', async () => {
    const mock = mockProvider();
    const other = otherProvider();
    const sdk = new PaymentSDK({
      providers: [mock, other],
      accounts: {
        'mock-main': { provider: 'mock', secretKey: SECRET_ONE, environment: 'test' },
        'other-main': { provider: 'other', apiKey: 'other-api-key', environment: 'test' },
      },
    });
    const order = { amount: { value: 150000, currency: 'PHP' }, reference: 'ORDER-9' };

    const viaMock = await sdk.payments.create({ account: 'mock-main', ...order });
    const viaOther = await sdk.payments.create({ account: 'other-main', ...order });

    expect(viaMock).toMatchObject({ provider: 'mock', accountId: 'mock-main', status: 'pending' });
    expect(viaOther).toMatchObject({
      provider: 'other',
      accountId: 'other-main',
      status: 'requires_action',
      providerStatus: 'REQUIRES_ACTION',
    });
    expect(mock.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(1);
  });

  it('requires an account on every operation', async () => {
    const { sdk, mock } = createSdk();
    const amount = { value: 1000, currency: 'PHP' };

    // @ts-expect-error -- `account` is required
    await expect(sdk.payments.create({ amount })).rejects.toMatchObject({
      name: 'ConfigurationError',
      code: 'account_required',
    });
    // @ts-expect-error -- unknown account IDs are rejected at compile time too
    await expect(sdk.payments.create({ account: 'mock-three', amount })).rejects.toMatchObject({
      code: 'unknown_account',
    });
    await expect(
      sdk.payments.create({ account: 'toString' as 'mock-one', amount }),
    ).rejects.toMatchObject({ code: 'unknown_account' });
    expect(mock.calls).toEqual([]);
  });
});

describe('capabilities', () => {
  it('rejects unsupported operations with a typed error before calling the provider', async () => {
    const mock = mockProvider({ operations: ['payments.create'] });
    const { sdk } = createSdk(mock);

    const error = await sdk.payments
      .retrieve({ account: 'mock-one', paymentId: 'mock_pay_1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect(error).toMatchObject({
      code: 'unsupported_operation',
      operation: 'payments.retrieve',
      accountId: 'mock-one',
      provider: 'mock',
    });
    expect(mock.calls).toEqual([]);
  });

  it('rejects unsupported currencies and payment methods contextually', async () => {
    const mock = mockProvider({ currencies: ['PHP'], paymentMethods: ['gcash'] });
    const { sdk } = createSdk(mock);

    await expect(
      sdk.payments.create({ account: 'mock-one', amount: { value: 1000, currency: 'USD' } }),
    ).rejects.toThrow(UnsupportedOperationError);
    await expect(
      sdk.payments.create({
        account: 'mock-one',
        amount: { value: 1000, currency: 'PHP' },
        paymentMethod: { type: 'card' },
      }),
    ).rejects.toThrow(/payment method "card"/);
    expect(mock.calls).toEqual([]);
  });

  it('lets callers ask before attempting', () => {
    const { sdk } = createSdk(
      mockProvider({ operations: ['payments.create', 'payments.retrieve'], currencies: ['PHP'] }),
    );

    expect(
      sdk.capabilities.supports({
        account: 'mock-one',
        operation: 'payments.create',
        currency: 'PHP',
      }),
    ).toBe(true);
    expect(sdk.capabilities.supports({ account: 'mock-one', operation: 'refunds.create' })).toBe(
      false,
    );
    expect(
      sdk.capabilities.check({
        account: 'mock-one',
        operation: 'payments.create',
        currency: 'USD',
      }),
    ).toEqual({ supported: false, reason: 'currency "USD" is not available' });
    expect(sdk.capabilities.operations('mock-one')).toEqual([
      'payments.create',
      'payments.retrieve',
    ]);
  });

  it('refuses to initialize an adapter that over-claims support', () => {
    expect(
      () =>
        new PaymentSDK({
          providers: [otherProvider({ operations: ['payments.create', 'payments.capture'] })],
          accounts: { a: { provider: 'other', apiKey: 'k', environment: 'test' } },
        }),
    ).toThrow(/declares support for "payments.capture" but does not implement it/);
  });
});

describe('input validation', () => {
  const { sdk, mock } = createSdk();
  const base = { account: 'mock-one', amount: { value: 1000, currency: 'PHP' } } as const;

  it.each([
    ['float amount', { ...base, amount: { value: 10.5, currency: 'PHP' } }],
    ['zero amount', { ...base, amount: { value: 0, currency: 'PHP' } }],
    ['unknown currency', { ...base, amount: { value: 1000, currency: 'php' } }],
    ['empty reference', { ...base, reference: '' }],
    ['non-http return URL', { ...base, returnUrls: { success: 'javascript:alert(1)' } }],
    ['relative return URL', { ...base, returnUrls: { cancel: '/cancel' } }],
    ['empty payment method type', { ...base, paymentMethod: { type: '' } }],
    ['array metadata', { ...base, metadata: [] as unknown as Record<string, unknown> }],
    ['polluting metadata key', { ...base, metadata: JSON.parse('{"__proto__":{"admin":true}}') }],
  ])('rejects %s before reaching the provider', async (_label, input) => {
    await expect(sdk.payments.create(input)).rejects.toThrow(ValidationError);
    expect(mock.calls).toEqual([]);
  });

  it('passes the adapter a sanitized copy without the account selector', async () => {
    const metadata = { orderId: 'A1' };
    await sdk.payments.create({
      ...base,
      metadata,
      returnUrls: { success: 'https://example.com/ok' },
    });

    const input = mock.calls.at(-1)?.input as Record<string, unknown>;
    expect(input).toEqual({
      amount: { value: 1000, currency: 'PHP' },
      metadata: { orderId: 'A1' },
      returnUrls: { success: 'https://example.com/ok' },
    });
    expect(input['metadata']).not.toBe(metadata);
  });
});

describe('configuration', () => {
  const mock = () => mockProvider();

  it.each([
    [
      'unregistered provider',
      { a: { provider: 'paymongo', secretKey: SECRET_ONE, environment: 'test' } },
      /Provider "paymongo" is not registered/,
    ],
    [
      'missing credential',
      { a: { provider: 'mock', environment: 'test' } },
      /Account "a" is missing required config key "secretKey"/,
    ],
    [
      'invalid environment',
      { a: { provider: 'mock', secretKey: SECRET_ONE, environment: 'production' } },
      /"environment" must be "test" or "live"/,
    ],
    ['missing provider', { a: { secretKey: SECRET_ONE, environment: 'test' } }, /"provider"/],
    [
      'invalid account ID',
      { 'bad id!': { provider: 'mock', secretKey: SECRET_ONE, environment: 'test' } },
      /Invalid account ID/,
    ],
    ['no accounts', {}, /At least one account/],
  ])('fails fast on %s without echoing secrets', (_label, accounts, message) => {
    let error: unknown;
    try {
      new PaymentSDK({ providers: [mock()], accounts: accounts as never });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toMatch(message);
    expect(inspect(error, { depth: 10 }) + JSON.stringify(error)).not.toContain(SECRET_ONE);
  });

  it('requires providers to be registered explicitly', () => {
    expect(() => new PaymentSDK({ providers: [], accounts: {} })).toThrow(ConfigurationError);
  });
});

describe('secret redaction', () => {
  it('never exposes credentials through inspection, serialization, results, or errors', async () => {
    const { sdk } = createSdk();
    const payment = await sdk.payments.create({
      account: 'mock-one',
      amount: { value: 1000, currency: 'PHP' },
    });
    const error = await sdk.payments
      .retrieve({ account: 'mock-two', paymentId: 'missing' })
      .catch((caught: unknown) => caught);

    const deep = { depth: Infinity, showHidden: true, getters: true };
    const exposed = [
      inspect(sdk, deep),
      inspect(sdk.accounts, deep),
      inspect(sdk.payments, deep),
      inspect(sdk.capabilities, deep),
      JSON.stringify(sdk),
      JSON.stringify(sdk.accounts.list()),
      JSON.stringify(sdk.accounts.get('mock-one')),
      String(sdk),
      inspect(payment, deep),
      JSON.stringify(payment),
      inspect(error, deep),
      JSON.stringify(error),
    ].join('\n');

    expect(exposed).not.toContain(SECRET_ONE);
    expect(exposed).not.toContain(SECRET_TWO);
    expect(exposed).not.toContain('secretKey');
  });

  it('describes accounts without credentials', () => {
    const { sdk } = createSdk();
    expect(sdk.accounts.list()).toEqual([
      { id: 'mock-one', provider: 'mock', environment: 'test' },
      { id: 'mock-two', provider: 'mock', environment: 'test' },
    ]);
    expect(sdk.accounts.has('mock-one')).toBe(true);
    expect(sdk.accounts.has('nope')).toBe(false);
    expect(JSON.parse(JSON.stringify(sdk))).toEqual({ accounts: sdk.accounts.list() });
  });
});
