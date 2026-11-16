import type { WebhookEventStore } from '@culgate/core';
import { mockProvider } from '@culgate/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  type CulGateWebhookEvent,
  InMemoryWebhookEventStore,
  PaymentSDK,
  UnsupportedOperationError,
  WebhookVerificationError,
} from '../src/index.js';

const SECRET_ONE = 'whsec-account-one';
const SECRET_TWO = 'whsec-account-two';

function setup(webhooks: { eventStore?: WebhookEventStore; maxBodyBytes?: number } = {}) {
  const mock = mockProvider();
  const sdk = new PaymentSDK({
    providers: [mock],
    webhooks,
    accounts: {
      one: {
        provider: 'mock',
        secretKey: 'sk-one',
        webhookSecret: SECRET_ONE,
        environment: 'test',
      },
      two: {
        provider: 'mock',
        secretKey: 'sk-two',
        webhookSecret: SECRET_TWO,
        environment: 'test',
      },
      'no-webhooks': { provider: 'mock', secretKey: 'sk-three', environment: 'test' },
    },
  });
  const paid = (id: string | null = 'evt_1', resourceId = 'mock_pay_1') =>
    mock.signWebhook('one', {
      ...(id !== null && { id }),
      type: 'mock.payment.succeeded',
      resourceId,
      occurredAt: new Date('2026-11-13T00:00:00Z'),
      data: { paymentId: resourceId },
    });
  return { sdk, mock, paid };
}

describe('manual verification and parsing', () => {
  it('verifies and normalizes a signed request', async () => {
    const { sdk, paid } = setup();
    const request = paid();

    await expect(sdk.webhooks.verify({ account: 'one', ...request })).resolves.toBeUndefined();
    const event = await sdk.webhooks.parse({ account: 'one', ...request });

    expect(event).toEqual({
      id: 'evt_1',
      accountId: 'one',
      provider: 'mock',
      type: 'payment.succeeded',
      providerEventType: 'mock.payment.succeeded',
      resourceId: 'mock_pay_1',
      occurredAt: new Date('2026-11-13T00:00:00Z'),
      data: { paymentId: 'mock_pay_1' },
      raw: JSON.parse(request.rawBody),
    });
  });

  it('accepts the raw body as bytes', async () => {
    const { sdk, paid } = setup();
    const request = paid();
    await expect(
      sdk.webhooks.parse({ account: 'one', ...request, rawBody: Buffer.from(request.rawBody) }),
    ).resolves.toMatchObject({ id: 'evt_1' });
  });

  it.each([
    [
      'modified body',
      (r: ReturnType<ReturnType<typeof setup>['paid']>) => ({
        ...r,
        rawBody: r.rawBody.replace('mock_pay_1', 'mock_pay_2'),
      }),
      'invalid_signature',
    ],
    [
      're-serialized body',
      (r: ReturnType<ReturnType<typeof setup>['paid']>) => ({
        ...r,
        rawBody: JSON.stringify(JSON.parse(r.rawBody), null, 1),
      }),
      'invalid_signature',
    ],
    [
      'missing signature',
      (r: ReturnType<ReturnType<typeof setup>['paid']>) => ({ ...r, headers: {} }),
      'missing_signature',
    ],
    [
      'forged signature',
      (r: ReturnType<ReturnType<typeof setup>['paid']>) => ({
        ...r,
        headers: { 'mock-signature': 'f'.repeat(64) },
      }),
      'invalid_signature',
    ],
  ])('rejects a %s', async (_label, tamper, code) => {
    const { sdk, paid } = setup();
    const error = await sdk.webhooks
      .verify({ account: 'one', ...tamper(paid()) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(error).toMatchObject({ code, accountId: 'one', provider: 'mock' });
  });

  it('rejects a request signed with another account’s secret', async () => {
    const { sdk, paid } = setup();
    // Signed for account "one", delivered to account "two"'s endpoint.
    await expect(sdk.webhooks.verify({ account: 'two', ...paid() })).rejects.toMatchObject({
      code: 'invalid_signature',
      accountId: 'two',
    });
  });

  it('rejects a parsed object in place of the raw body', async () => {
    const { sdk, paid } = setup();
    const request = paid();
    await expect(
      sdk.webhooks.verify({
        account: 'one',
        headers: request.headers,
        rawBody: JSON.parse(request.rawBody),
      }),
    ).rejects.toMatchObject({ name: 'WebhookVerificationError', code: 'raw_body_required' });
  });

  it('does not normalize a request that fails verification', async () => {
    const { sdk } = setup();
    // Not JSON at all: a parse attempt would report invalid_payload instead.
    await expect(
      sdk.webhooks.parse({
        account: 'one',
        rawBody: 'not json',
        headers: { 'mock-signature': 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature' });
  });

  it('is unsupported on an account without a webhook secret', async () => {
    const { sdk, paid } = setup();
    expect(
      sdk.capabilities.supports({ account: 'no-webhooks', operation: 'webhooks.verify' }),
    ).toBe(false);
    expect(sdk.capabilities.supports({ account: 'one', operation: 'webhooks.verify' })).toBe(true);
    await expect(sdk.webhooks.verify({ account: 'no-webhooks', ...paid() })).rejects.toThrow(
      UnsupportedOperationError,
    );
  });

  it('requires an explicit, known account', async () => {
    const { sdk, paid } = setup();
    await expect(sdk.webhooks.handle({ ...paid() } as never)).rejects.toMatchObject({
      code: 'account_required',
    });
    await expect(
      sdk.webhooks.handle({ account: 'nope' as 'one', ...paid() }),
    ).rejects.toMatchObject({
      code: 'unknown_account',
    });
  });
});

describe('managed handling', () => {
  it('dispatches to type-specific and wildcard handlers and acknowledges', async () => {
    const { sdk, paid } = setup();
    const seen: string[] = [];
    sdk.webhooks.on('payment.succeeded', (event) => void seen.push(`typed:${event.id}`));
    sdk.webhooks.on('*', (event) => void seen.push(`any:${event.id}`));
    sdk.webhooks.on('payment.failed', () => void seen.push('wrong'));

    const result = await sdk.webhooks.handle({ account: 'one', ...paid() });

    expect(result).toMatchObject({
      status: 'processed',
      response: { status: 200, body: { received: true } },
      event: { id: 'evt_1', accountId: 'one', type: 'payment.succeeded' },
    });
    expect(seen).toEqual(['typed:evt_1', 'any:evt_1']);
  });

  it('awaits asynchronous handlers and supports unsubscribing', async () => {
    const { sdk, paid } = setup();
    const order: string[] = [];
    const off = sdk.webhooks.on('*', () => void order.push('removed'));
    sdk.webhooks.on('*', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('slow');
    });
    off();

    await sdk.webhooks.handle({ account: 'one', ...paid() });
    expect(order).toEqual(['slow']);
  });

  it.each([
    ['a forged signature', { 'mock-signature': '0'.repeat(64) }, 401, 'invalid_signature'],
    ['a missing signature', {}, 401, 'missing_signature'],
  ])('rejects %s without running handlers', async (_label, headers, status, code) => {
    const { sdk, paid } = setup();
    const handler = vi.fn();
    sdk.webhooks.on('*', handler);

    const result = await sdk.webhooks.handle({ account: 'one', rawBody: paid().rawBody, headers });

    expect(result).toMatchObject({
      status: 'rejected',
      response: { status, body: { error: code } },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an oversized body before verification', async () => {
    const { sdk, mock } = setup({ maxBodyBytes: 256 });
    const big = mock.signWebhook('one', {
      type: 'mock.payment.succeeded',
      data: { pad: 'x'.repeat(1000) },
    });
    const result = await sdk.webhooks.handle({ account: 'one', ...big });
    expect(result).toMatchObject({ status: 'rejected', response: { status: 413 } });
  });

  it('rejects an authentic but malformed payload with 400', async () => {
    const { sdk } = setup();
    // Correctly signed, but the body is not JSON.
    const { createHmac } = await import('node:crypto');
    const rawBody = 'definitely not json';
    const signature = createHmac('sha256', SECRET_ONE).update(rawBody).digest('hex');
    const result = await sdk.webhooks.handle({
      account: 'one',
      rawBody,
      headers: { 'mock-signature': signature },
    });
    expect(result).toMatchObject({
      status: 'rejected',
      response: { status: 400, body: { error: 'invalid_payload' } },
    });
  });

  it('delivers unknown event types as provider.unknown with the original type and payload', async () => {
    const { sdk, mock } = setup();
    const events: CulGateWebhookEvent[] = [];
    sdk.webhooks.on('provider.unknown', (event) => void events.push(event));
    const request = mock.signWebhook('one', {
      id: 'evt_x',
      type: 'mock.dispute.opened',
      data: { a: 1 },
    });

    const result = await sdk.webhooks.handle({ account: 'one', ...request });

    expect(result.status).toBe('processed');
    expect(events[0]).toMatchObject({
      type: 'provider.unknown',
      providerEventType: 'mock.dispute.opened',
      raw: JSON.parse(request.rawBody),
    });
  });

  it('asks the provider to retry when a handler throws', async () => {
    const { sdk, paid } = setup();
    const boom = new Error('database unavailable');
    const after = vi.fn();
    sdk.webhooks.on('payment.succeeded', () => {
      throw boom;
    });
    sdk.webhooks.on('*', after);

    const result = await sdk.webhooks.handle({ account: 'one', ...paid() });

    expect(result).toMatchObject({ status: 'failed', error: boom, response: { status: 500 } });
    expect(after).not.toHaveBeenCalled();
    expect(JSON.stringify(result.response)).not.toContain('database');
  });
});

describe('deduplication with an event store', () => {
  it('processes a redelivered event once', async () => {
    const { sdk, paid } = setup({ eventStore: new InMemoryWebhookEventStore() });
    const handler = vi.fn();
    sdk.webhooks.on('*', handler);

    const first = await sdk.webhooks.handle({ account: 'one', ...paid() });
    const second = await sdk.webhooks.handle({ account: 'one', ...paid() });

    expect(first.status).toBe('processed');
    expect(second).toMatchObject({ status: 'duplicate', response: { status: 200 } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one of many concurrent deliveries process the event', async () => {
    const { sdk, paid } = setup({ eventStore: new InMemoryWebhookEventStore() });
    let running = 0;
    let processed = 0;
    sdk.webhooks.on('*', async () => {
      running++;
      expect(running).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      processed++;
      running--;
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => sdk.webhooks.handle({ account: 'one', ...paid() })),
    );

    expect(results.filter((result) => result.status === 'processed')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'duplicate')).toHaveLength(19);
    expect(processed).toBe(1);
  });

  it('scopes event IDs to the account', async () => {
    const { sdk, mock } = setup({ eventStore: new InMemoryWebhookEventStore() });
    const handler = vi.fn();
    sdk.webhooks.on('*', handler);
    const event = { id: 'evt_same', type: 'mock.payment.succeeded' };

    await sdk.webhooks.handle({ account: 'one', ...mock.signWebhook('one', event) });
    const other = await sdk.webhooks.handle({ account: 'two', ...mock.signWebhook('two', event) });

    expect(other.status).toBe('processed');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when a handler fails, so the retry is processed', async () => {
    const { sdk, paid } = setup({ eventStore: new InMemoryWebhookEventStore() });
    let attempts = 0;
    sdk.webhooks.on('*', () => {
      if (++attempts === 1) throw new Error('transient');
    });

    expect((await sdk.webhooks.handle({ account: 'one', ...paid() })).status).toBe('failed');
    expect((await sdk.webhooks.handle({ account: 'one', ...paid() })).status).toBe('processed');
    expect((await sdk.webhooks.handle({ account: 'one', ...paid() })).status).toBe('duplicate');
    expect(attempts).toBe(2);
  });

  it('reports the store calls it makes', async () => {
    const store = {
      claim: vi.fn(async () => true),
      markCompleted: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    };
    const { sdk, paid } = setup({ eventStore: store });
    const key = { accountId: 'one', provider: 'mock', eventId: 'evt_1' };

    await sdk.webhooks.handle({ account: 'one', ...paid() });
    expect(store.claim).toHaveBeenCalledWith(key);
    expect(store.markCompleted).toHaveBeenCalledWith(key);

    const error = new Error('nope');
    sdk.webhooks.on('*', () => {
      throw error;
    });
    await sdk.webhooks.handle({ account: 'one', ...paid() });
    expect(store.markFailed).toHaveBeenCalledWith({ ...key, error });
  });

  it('does not consult the store for unauthentic requests', async () => {
    const store = { claim: vi.fn(async () => true), markCompleted: vi.fn(async () => {}) };
    const { sdk, paid } = setup({ eventStore: store });
    await sdk.webhooks.handle({ account: 'one', rawBody: paid().rawBody, headers: {} });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('cannot deduplicate an event without a provider event ID, and does not pretend to', async () => {
    const store = { claim: vi.fn(async () => true), markCompleted: vi.fn(async () => {}) };
    const { sdk, paid } = setup({ eventStore: store });
    const handler = vi.fn();
    sdk.webhooks.on('*', handler);

    const first = await sdk.webhooks.handle({ account: 'one', ...paid(null) });
    const second = await sdk.webhooks.handle({ account: 'one', ...paid(null) });

    expect([first.status, second.status]).toEqual(['processed', 'processed']);
    expect(first.status === 'processed' && first.event.id).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('processes every delivery when no store is configured', async () => {
    const { sdk, paid } = setup();
    const handler = vi.fn();
    sdk.webhooks.on('*', handler);
    await sdk.webhooks.handle({ account: 'one', ...paid() });
    await sdk.webhooks.handle({ account: 'one', ...paid() });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('out-of-order delivery', () => {
  it('delivers events in arrival order without reordering, so handlers must fetch current state', async () => {
    const { sdk, mock } = setup({ eventStore: new InMemoryWebhookEventStore() });
    const payment = await sdk.payments.create({
      account: 'one',
      amount: { value: 1000, currency: 'PHP' },
    });
    mock.setPaymentStatus('one', payment.id, 'succeeded');

    const statuses: string[] = [];
    sdk.webhooks.on('*', async (event) => {
      // The recommended pattern: treat the event as a signal, then read the truth.
      const current = await sdk.payments.retrieve({
        account: event.accountId as 'one',
        paymentId: event.resourceId!,
      });
      statuses.push(`${event.type} -> ${current.status}`);
    });

    const at = (id: string, type: string, iso: string) =>
      mock.signWebhook('one', { id, type, resourceId: payment.id, occurredAt: new Date(iso) });
    // "succeeded" arrives before the older "processing" event.
    await sdk.webhooks.handle({
      account: 'one',
      ...at('evt_2', 'mock.payment.succeeded', '2026-11-13T00:00:10Z'),
    });
    await sdk.webhooks.handle({
      account: 'one',
      ...at('evt_1', 'mock.payment.processing', '2026-11-13T00:00:05Z'),
    });

    expect(statuses).toEqual(['payment.succeeded -> succeeded', 'payment.processing -> succeeded']);
  });
});

describe('InMemoryWebhookEventStore', () => {
  const key = { accountId: 'a', provider: 'mock', eventId: 'evt_1' };

  it('lets a stale claim be retaken after the TTL, but never a completed one', async () => {
    let now = 0;
    const store = new InMemoryWebhookEventStore({ claimTtlMs: 1000, now: () => now });

    expect(await store.claim(key)).toBe(true);
    expect(await store.claim(key)).toBe(false);
    now = 999;
    expect(await store.claim(key)).toBe(false);
    now = 1000; // the first worker is presumed dead
    expect(await store.claim(key)).toBe(true);

    await store.markCompleted(key);
    now = 1_000_000;
    expect(await store.claim(key)).toBe(false);
  });

  it('does not confuse keys that concatenate to the same string', async () => {
    const store = new InMemoryWebhookEventStore();
    expect(await store.claim({ accountId: 'a:b', provider: 'c', eventId: 'd' })).toBe(true);
    expect(await store.claim({ accountId: 'a', provider: 'b:c', eventId: 'd' })).toBe(true);
  });
});
