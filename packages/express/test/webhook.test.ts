import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mockProvider } from '@culgate/core/testing';
import { InMemoryWebhookEventStore, PaymentSDK, type WebhookHandleResult } from '@culgate/sdk';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { paymentWebhook } from '../src/index.js';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function setup() {
  const mock = mockProvider();
  const sdk = new PaymentSDK({
    providers: [mock],
    webhooks: { eventStore: new InMemoryWebhookEventStore() },
    accounts: {
      one: {
        provider: 'mock',
        secretKey: 'sk-one',
        webhookSecret: 'whsec-one',
        environment: 'test',
      },
      two: {
        provider: 'mock',
        secretKey: 'sk-two',
        webhookSecret: 'whsec-two',
        environment: 'test',
      },
    },
  });
  const events: string[] = [];
  sdk.webhooks.on('*', (event) => void events.push(`${event.accountId}:${event.type}:${event.id}`));
  // Whitespace and key order a JSON round-trip would not preserve.
  const signed = (id = 'evt_1') =>
    mock.signWebhook('one', { id, type: 'mock.payment.succeeded', resourceId: 'mock_pay_1' });
  return { sdk, mock, events, signed };
}

async function serve(configure: (app: Express) => void) {
  const app = express();
  const errors: unknown[] = [];
  configure(app);
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    errors.push(error);
    res.status(500).json({ error: 'internal' });
  };
  app.use(onError);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, request: { rawBody: string; headers: object }) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: request.rawBody,
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  return { post, errors };
}

describe('paymentWebhook', () => {
  it('works as a one-line route with no body parser', async () => {
    const { sdk, events, signed } = setup();
    const { post } = await serve((app) => {
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one' }));
    });

    const response = await post('/webhooks/one', signed());

    expect(response).toEqual({ status: 200, body: { received: true } });
    expect(events).toEqual(['one:payment.succeeded:evt_1']);
  });

  it('works behind express.raw()', async () => {
    const { sdk, events, signed } = setup();
    const { post } = await serve((app) => {
      app.post(
        '/webhooks/one',
        express.raw({ type: '*/*' }),
        paymentWebhook(sdk, { account: 'one' }),
      );
    });
    expect((await post('/webhooks/one', signed())).status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('works when mounted before a global express.json()', async () => {
    const { sdk, events, signed } = setup();
    const { post } = await serve((app) => {
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one' }));
      app.use(express.json());
    });
    expect((await post('/webhooks/one', signed())).status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('works after a global express.json() that preserves the raw bytes', async () => {
    const { sdk, events, signed } = setup();
    const { post } = await serve((app) => {
      app.use(
        express.json({
          verify: (req, _res, buffer) => {
            (req as { rawBody?: Buffer }).rawBody = buffer;
          },
        }),
      );
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one' }));
    });
    expect((await post('/webhooks/one', signed())).status).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('fails loudly, without dispatching, when express.json() consumed the body', async () => {
    const { sdk, events, signed } = setup();
    const { post, errors } = await serve((app) => {
      app.use(express.json());
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one' }));
    });

    const response = await post('/webhooks/one', signed());

    expect(response.status).toBe(500);
    expect(errors[0]).toMatchObject({ name: 'ConfigurationError', code: 'raw_body_unavailable' });
    expect(events).toEqual([]);
  });

  it('answers 401 to a forged or unsigned request and does not dispatch', async () => {
    const { sdk, events, signed } = setup();
    const { post } = await serve((app) => {
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one' }));
    });
    const request = signed();

    const forged = await post('/webhooks/one', {
      ...request,
      headers: { 'mock-signature': '0'.repeat(64) },
    });
    const unsigned = await post('/webhooks/one', { ...request, headers: {} });
    const tampered = await post('/webhooks/one', {
      ...request,
      rawBody: request.rawBody.replace('mock_pay_1', 'mock_pay_2'),
    });

    expect(forged).toEqual({ status: 401, body: { error: 'invalid_signature' } });
    expect(unsigned).toEqual({ status: 401, body: { error: 'missing_signature' } });
    expect(tampered.status).toBe(401);
    expect(events).toEqual([]);
  });

  it('binds each route to its own account', async () => {
    const { sdk, events, signed } = setup();
    const { post } = await serve((app) => {
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one' }));
      app.post('/webhooks/two', paymentWebhook(sdk, { account: 'two' }));
    });
    // A request signed for account "one" must not be accepted on account "two"'s route.
    expect((await post('/webhooks/two', signed())).status).toBe(401);
    expect((await post('/webhooks/one', signed())).status).toBe(200);
    expect(events).toEqual(['one:payment.succeeded:evt_1']);
  });

  it('acknowledges a redelivery without dispatching twice', async () => {
    const { sdk, events, signed } = setup();
    const results: WebhookHandleResult['status'][] = [];
    const { post } = await serve((app) => {
      app.post(
        '/webhooks/one',
        paymentWebhook(sdk, {
          account: 'one',
          onResult: (result) => void results.push(result.status),
        }),
      );
    });

    expect((await post('/webhooks/one', signed())).status).toBe(200);
    expect((await post('/webhooks/one', signed())).status).toBe(200);

    expect(results).toEqual(['processed', 'duplicate']);
    expect(events).toHaveLength(1);
  });

  it('answers 500 when a handler fails, so the provider retries', async () => {
    const { sdk, signed } = setup();
    sdk.webhooks.on('payment.succeeded', () => {
      throw new Error('database unavailable');
    });
    const { post } = await serve((app) => {
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one' }));
    });
    expect(await post('/webhooks/one', signed())).toEqual({
      status: 500,
      body: { error: 'handler_failed' },
    });
  });

  it('rejects an oversized body with 413', async () => {
    const { sdk, mock, events } = setup();
    const { post } = await serve((app) => {
      app.post('/webhooks/one', paymentWebhook(sdk, { account: 'one', maxBodyBytes: 512 }));
    });
    const big = mock.signWebhook('one', {
      type: 'mock.payment.succeeded',
      data: { pad: 'x'.repeat(5000) },
    });
    expect(await post('/webhooks/one', big)).toEqual({
      status: 413,
      body: { error: 'payload_too_large' },
    });
    expect(events).toEqual([]);
  });

  it('passes configuration errors to Express error handling', async () => {
    const { sdk, signed } = setup();
    const { post, errors } = await serve((app) => {
      app.post('/webhooks/x', paymentWebhook(sdk, { account: 'missing' as 'one' }));
    });
    expect((await post('/webhooks/x', signed())).status).toBe(500);
    expect(errors[0]).toMatchObject({ code: 'unknown_account' });
  });
});
