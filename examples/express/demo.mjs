// Starts the app on a free port, drives it like a customer and a provider
// would, checks the results, and exits.

import assert from 'node:assert/strict';
import { app, fulfilled, mock } from './app.mjs';

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body, headers = {}) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: response.status, body: await response.json() };
};

try {
  // 1. The shop creates a payment.
  const created = await post('/orders/ORDER-123/pay', JSON.stringify({ amount: 150000 }));
  assert.equal(created.status, 201);
  console.log('created:', created.body);

  // 2. The customer pays; the provider sends a signed webhook.
  mock.setPaymentStatus('primary', created.body.id, 'succeeded');
  const webhook = mock.signWebhook('primary', {
    id: 'evt_1',
    type: 'mock.payment.succeeded',
    resourceId: created.body.id,
  });
  const delivered = await post('/webhooks/primary', webhook.rawBody, webhook.headers);
  assert.deepEqual(delivered, { status: 200, body: { received: true } });
  assert.equal(fulfilled.get(created.body.id), 'ORDER-123');

  // 3. The provider retries the same event: acknowledged, not processed twice.
  const redelivered = await post('/webhooks/primary', webhook.rawBody, webhook.headers);
  assert.equal(redelivered.status, 200);

  // 4. A forged webhook is refused.
  const forged = await post('/webhooks/primary', webhook.rawBody, {
    'mock-signature': '0'.repeat(64),
  });
  assert.equal(forged.status, 401);

  // 5. Bad input is rejected before reaching the provider.
  const invalid = await post('/orders/ORDER-124/pay', JSON.stringify({ amount: 10.5 }));
  assert.equal(invalid.status, 400);
  console.log('invalid amount:', invalid.body);

  console.log('Express example OK.');
} finally {
  server.close();
}
