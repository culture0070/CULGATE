import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { OrdersService } from './orders.service.js';
import { mock } from './payments.js';

const demo = process.argv.includes('--demo');

// `rawBody: true` keeps the exact request bytes, which webhook verification needs.
const app = await NestFactory.create(AppModule, {
  rawBody: true,
  logger: demo ? false : undefined,
});

if (!demo) {
  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  console.log(`Listening on http://localhost:${port}`);
  console.log('POST /orders/:orderId/pay   {"amount": 150000}');
  console.log('POST /webhooks/primary      (provider webhooks)');
} else {
  // Drive the app like a customer and a provider would, check, and exit.
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  try {
    const created = await post('/orders/ORDER-123/pay', JSON.stringify({ amount: 150000 }));
    assert.equal(created.status, 201);
    console.log('created:', created.body);
    const paymentId = created.body['id'] as string;

    mock.setPaymentStatus('primary', paymentId, 'succeeded');
    const webhook = mock.signWebhook('primary', {
      id: 'evt_1',
      type: 'mock.payment.succeeded',
      resourceId: paymentId,
    });
    const headers = webhook.headers as Record<string, string>;

    const delivered = await post('/webhooks/primary', webhook.rawBody, headers);
    assert.deepEqual(delivered, { status: 200, body: { received: true } });
    assert.equal(app.get(OrdersService).fulfilled.get(paymentId), 'ORDER-123');

    const forged = await post('/webhooks/primary', webhook.rawBody, {
      'mock-signature': '0'.repeat(64),
    });
    assert.equal(forged.status, 401);

    console.log('NestJS example OK.');
  } finally {
    await app.close();
  }
}
