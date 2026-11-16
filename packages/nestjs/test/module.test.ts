import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { mockProvider } from '@culgate/core/testing';
import { InMemoryWebhookEventStore, type PaymentSDKOptions } from '@culgate/sdk';
import {
  Controller,
  Get,
  Inject,
  type INestApplication,
  Module,
  Post,
  type RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CULGATE_SDK,
  InjectPaymentSDK,
  PaymentModule,
  PaymentSDK,
  PaymentWebhookService,
} from '../src/index.js';

const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const mock = mockProvider();
const sdkOptions = () => ({
  providers: [mock],
  webhooks: { eventStore: new InMemoryWebhookEventStore() },
  accounts: {
    one: { provider: 'mock', secretKey: 'sk-one', webhookSecret: 'whsec-one', environment: 'test' },
    two: { provider: 'mock', secretKey: 'sk-two', webhookSecret: 'whsec-two', environment: 'test' },
  } as const,
});

@Controller()
class AppController {
  constructor(
    @Inject(PaymentSDK) private readonly byClass: PaymentSDK,
    @InjectPaymentSDK() private readonly byToken: PaymentSDK,
    @Inject(PaymentWebhookService) private readonly webhooks: PaymentWebhookService,
  ) {}

  @Get('accounts')
  accounts() {
    return { same: this.byClass === this.byToken, accounts: this.byClass.accounts.list() };
  }

  @Post('pay')
  pay() {
    return this.byClass.payments.create({
      account: 'one',
      amount: { value: 150000, currency: 'PHP' },
    });
  }

  @Post('webhooks/one')
  async one(@Req() request: RawBodyRequest<Request>, @Res() response: Response) {
    const result = await this.webhooks.handle('one', request);
    response.status(result.response.status).json(result.response.body);
  }

  @Post('webhooks/two')
  async two(@Req() request: RawBodyRequest<Request>, @Res() response: Response) {
    const result = await this.webhooks.handle('two', request);
    response.status(result.response.status).json(result.response.body);
  }
}

async function start(
  imports: NonNullable<Parameters<typeof Module>[0]['imports']>,
  rawBody = true,
) {
  @Module({ imports, controllers: [AppController] })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { rawBody, logger: false });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: string, headers: object = {}) => {
    const response = await fetch(base + path, {
      method,
      ...(body !== undefined && { body }),
      headers: { 'content-type': 'application/json', ...headers },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { app, call };
}

const signed = (id = 'evt_1') =>
  mock.signWebhook('one', { id, type: 'mock.payment.succeeded', resourceId: 'mock_pay_1' });

describe('PaymentModule', () => {
  it('provides one PaymentSDK under both tokens via forRoot', async () => {
    const { app, call } = await start([PaymentModule.forRoot(sdkOptions())]);

    const response = await call('GET', '/accounts');

    expect(response.body).toEqual({
      same: true,
      accounts: [
        { id: 'one', provider: 'mock', environment: 'test' },
        { id: 'two', provider: 'mock', environment: 'test' },
      ],
    });
    expect(app.get(PaymentSDK)).toBe(app.get(CULGATE_SDK));
    expect(JSON.stringify(response.body)).not.toContain('sk-one');
  });

  it('routes a payment through the injected SDK', async () => {
    const { call } = await start([PaymentModule.forRoot(sdkOptions())]);
    const response = await call('POST', '/pay');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ accountId: 'one', provider: 'mock', status: 'pending' });
  });

  it('accepts an existing PaymentSDK instance', async () => {
    const sdk = new PaymentSDK(sdkOptions());
    const { app } = await start([PaymentModule.forRoot(sdk)]);
    expect(app.get(PaymentSDK)).toBe(sdk);
  });

  it('fails at startup on invalid configuration', () => {
    expect(() =>
      PaymentModule.forRoot({
        providers: [mock],
        accounts: { bad: { provider: 'mock', environment: 'test' } as never },
      }),
    ).toThrow(/missing required config key "secretKey"/);
  });

  it('builds the SDK from injected dependencies via forRootAsync', async () => {
    const CONFIG = 'APP_CONFIG';
    @Module({ providers: [{ provide: CONFIG, useValue: sdkOptions() }], exports: [CONFIG] })
    class ConfigModule {}

    const { call } = await start([
      PaymentModule.forRootAsync({
        imports: [ConfigModule],
        inject: [CONFIG],
        useFactory: async (config: PaymentSDKOptions) => config,
      }),
    ]);

    expect((await call('GET', '/accounts')).body['accounts']).toHaveLength(2);
  });
});

describe('PaymentWebhookService with the NestJS raw body', () => {
  it('verifies the exact bytes received and dispatches', async () => {
    const { app, call } = await start([PaymentModule.forRoot(sdkOptions())]);
    const events: string[] = [];
    app
      .get(PaymentSDK)
      .webhooks.on('*', (event) => void events.push(`${event.accountId}:${event.id}`));
    const request = signed('evt_nest');

    const response = await call('POST', '/webhooks/one', request.rawBody, request.headers);

    expect(response).toEqual({ status: 200, body: { received: true } });
    expect(events).toEqual(['one:evt_nest']);
  });

  it('rejects forged, tampered, and wrong-account requests with 401', async () => {
    const { app, call } = await start([PaymentModule.forRoot(sdkOptions())]);
    const handled: unknown[] = [];
    app.get(PaymentSDK).webhooks.on('*', (event) => void handled.push(event));
    const request = signed();

    const forged = await call('POST', '/webhooks/one', request.rawBody, {
      'mock-signature': '0'.repeat(64),
    });
    const tampered = await call(
      'POST',
      '/webhooks/one',
      request.rawBody.replace('mock_pay_1', 'x'),
      request.headers,
    );
    const wrongAccount = await call('POST', '/webhooks/two', request.rawBody, request.headers);

    expect([forged.status, tampered.status, wrongAccount.status]).toEqual([401, 401, 401]);
    expect(handled).toEqual([]);
  });

  it('acknowledges a redelivery without dispatching twice', async () => {
    const { app, call } = await start([PaymentModule.forRoot(sdkOptions())]);
    let count = 0;
    app.get(PaymentSDK).webhooks.on('*', () => void count++);
    const request = signed('evt_dup');

    await call('POST', '/webhooks/one', request.rawBody, request.headers);
    const second = await call('POST', '/webhooks/one', request.rawBody, request.headers);

    expect(second.status).toBe(200);
    expect(count).toBe(1);
  });

  it('fails with a clear error when the app was created without rawBody: true', async () => {
    const { app, call } = await start([PaymentModule.forRoot(sdkOptions())], false);
    const handled: unknown[] = [];
    app.get(PaymentSDK).webhooks.on('*', (event) => void handled.push(event));
    const request = signed();

    const response = await call('POST', '/webhooks/one', request.rawBody, request.headers);

    expect(response.status).toBe(500);
    expect(handled).toEqual([]);
    expect(() => app.get(PaymentWebhookService).handle('one', { headers: {} })).toThrow(
      /rawBody: true/,
    );
  });
});
