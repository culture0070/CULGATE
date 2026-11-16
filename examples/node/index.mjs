// Plain Node.js: payments, refunds, hosted checkout, capabilities, and errors.
//
// This runs against CulGate's in-memory mock provider, so it needs no
// credentials. To use a real gateway, change the two marked lines:
//
//   import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
//   providers: [paymongo()],
//   accounts: { store: paymongoAccountFromEnv() },   // reads PAYMONGO_SECRET_KEY

import assert from 'node:assert/strict';
import { PaymentSDK, UnsupportedOperationError } from '@culgate/sdk';
import { mockProvider } from '@culgate/core/testing';

const mock = mockProvider({ paymentMethods: ['gcash', 'card'] });

const sdk = new PaymentSDK({
  providers: [mock], // <- change for a real gateway
  accounts: {
    // Two merchant accounts on the same provider, each with its own credentials.
    store: { provider: 'mock', secretKey: 'mock-secret-store', environment: 'test' }, // <- change
    marketplace: { provider: 'mock', secretKey: 'mock-secret-marketplace', environment: 'test' },
  },
});

console.log('Accounts:', sdk.accounts.list());

// 1. Create a payment on an explicitly chosen account. Amounts are minor units.
const payment = await sdk.payments.create({
  account: 'store',
  amount: { value: 150000, currency: 'PHP' }, // PHP 1,500.00
  paymentMethod: { type: 'gcash' },
  reference: 'ORDER-123',
  returnUrls: { success: 'https://example.com/return' },
  idempotencyKey: 'order-123-payment',
});
console.log(`Payment ${payment.id} on "${payment.accountId}" is ${payment.status}`);
assert.equal(payment.status, 'pending'); // created is NOT paid

// 2. The customer pays (simulated here). Always read the current status back.
mock.setPaymentStatus('store', payment.id, 'succeeded');
const paid = await sdk.payments.retrieve({ account: 'store', paymentId: payment.id });
console.log(`After the customer paid: ${paid.status}`);
assert.equal(paid.status, 'succeeded');

// 3. Refund part of it.
const refund = await sdk.refunds.create({
  account: 'store',
  paymentId: payment.id,
  amount: { value: 50000, currency: 'PHP' },
  reason: 'requested_by_customer',
});
console.log(`Refund ${refund.id}: ${refund.status}, PHP ${refund.amount.value / 100}`);

// 4. Accounts are isolated: another account cannot see this payment.
await assert.rejects(sdk.payments.retrieve({ account: 'marketplace', paymentId: payment.id }), {
  name: 'PaymentNotFoundError',
});
console.log('The "marketplace" account cannot see the "store" payment.');

// 5. Hosted checkout: the customer picks a method on the provider's page.
const session = await sdk.checkout.create({
  account: 'store',
  lineItems: [
    { name: 'T-shirt', quantity: 2, amount: { value: 50000, currency: 'PHP' } },
    { name: 'Shipping', quantity: 1, amount: { value: 15000, currency: 'PHP' } },
  ],
  reference: 'ORDER-124',
  returnUrls: { success: 'https://example.com/thanks', cancel: 'https://example.com/cart' },
});
console.log(`Checkout ${session.id}: send the customer to ${session.url}`);
assert.deepEqual(session.amount, { value: 115000, currency: 'PHP' });

// 6. Ask what an account can do before offering it...
const offersCrypto = sdk.capabilities.supports({
  account: 'store',
  operation: 'payments.create',
  paymentMethod: 'crypto',
});
console.log('Can "store" take crypto?', offersCrypto);

// ...because an unsupported request fails with a typed error, never silently.
try {
  await sdk.payments.create({
    account: 'store',
    amount: { value: 1000, currency: 'PHP' },
    paymentMethod: { type: 'crypto' },
  });
} catch (error) {
  assert.ok(error instanceof UnsupportedOperationError);
  console.log(`Rejected as expected: ${error.message}`);
}

// 7. Credentials never appear in anything the SDK exposes.
assert.ok(!JSON.stringify(sdk).includes('mock-secret'));
console.log('Done.');
