# Hosted checkout

A checkout session is a payment page hosted by the provider. You send the customer to its URL;
they choose a payment method (including cards) and pay there. Your server never sees card details.

Use `sdk.checkout` when you want the provider's page. Use `sdk.payments.create` when you have
already chosen the payment method yourself and only need the redirect for that one e-wallet.

A checkout session is **not** a payment. It is a separate resource with its own ID and status, and
a payment exists only once the customer pays.

## Create a session

```ts
const session = await sdk.checkout.create({
  account: 'paymongo-primary',
  lineItems: [
    { name: 'T-shirt', quantity: 2, amount: { value: 50000, currency: 'PHP' } }, // PHP 500.00 each
    { name: 'Shipping', quantity: 1, amount: { value: 15000, currency: 'PHP' } },
  ],
  reference: 'ORDER-123',
  paymentMethods: ['card', 'gcash'], // optional
  returnUrls: {
    success: 'https://example.com/orders/123/thanks',
    cancel: 'https://example.com/cart',
  },
});

session.url; // redirect the customer here
session.amount; // { value: 115000, currency: 'PHP' }, the total
session.status; // 'open'
```

- `amount` on a line item is the price of **one unit**, in minor units. CulGate computes the total.
- All line items must use the same currency.
- Store `session.id` together with the account ID and your order.
- `paymentMethods` is optional. When omitted, the provider's default selection applies (see the
  table below). Ask before offering one:
  `sdk.capabilities.supports({ account, operation: 'checkout.create', paymentMethod: 'card' })`.

## Find out what happened

**Do not fulfil an order because the customer reached your success URL.** Anyone can open that
URL. Confirm through a webhook, or by retrieving the session.

```ts
sdk.webhooks.on('checkout.completed', async (event) => {
  const session = await sdk.checkout.retrieve({
    account: event.accountId,
    sessionId: event.resourceId!,
  });
  if (session.status === 'completed') await fulfilOrder(session.reference, session.paymentId);
});
```

| Status      | Meaning                                             |
| ----------- | --------------------------------------------------- |
| `open`      | The customer can still pay                          |
| `completed` | The provider reports a successful payment           |
| `expired`   | No longer payable (timed out, or you expired it)    |
| `cancelled` | No longer payable (you cancelled it; Xendit's term) |
| `unknown`   | A provider status CulGate does not recognize        |

When a session is `completed`, `session.paymentId` is the CulGate payment ID of the payment that
was made. Use it with `sdk.payments.retrieve` and `sdk.refunds.create` on the same account:

```ts
await sdk.refunds.create({
  account,
  paymentId: session.paymentId!,
  reason: 'requested_by_customer',
});
```

## Close a session

```ts
await sdk.checkout.expire({ account, sessionId: session.id });
```

This stops an open session from accepting payment. The resulting status is `expired` on PayMongo
and `cancelled` on Xendit. Both providers refuse to close a session that has been paid.

## Provider differences

|                                  | PayMongo                                                            | Xendit                                                                  |
| -------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Provider resource                | Checkout Session (v2), `cs_…`                                       | Payment Session (`PAYMENT_LINK`), `ps-…`                                |
| Line items on the hosted page    | Yes                                                                 | **No**: only the total and description are sent                         |
| `paymentMethods` accepted        | `card`, `gcash`, `maya`, `grabpay`, `shopeepay`, `billease`, `qrph` | `card`, `gcash`, `maya`, `grabpay`, `shopeepay`, `qrph`                 |
| When `paymentMethods` is omitted | `card`, `gcash`, `qrph` are offered                                 | Every channel activated on your Xendit account                          |
| Expires by itself                | **Never**; stays open until you expire it                           | After 30 minutes                                                        |
| Expiry webhook                   | None                                                                | `checkout.expired`                                                      |
| Completion webhook               | `checkout.completed`                                                | `checkout.completed`, and also `payment.succeeded` for the same payment |
| Return URLs                      | Any http(s) URL                                                     | Must be `https`                                                         |
| `reference` length               | Not documented                                                      | At most 64 characters                                                   |
| Idempotency key                  | Sent, but not enforced by PayMongo                                  | Not supported                                                           |
| `providerStatus` after payment   | Still `active` (CulGate reads the payments)                         | `COMPLETED`                                                             |

Things that follow from these:

- **PayMongo sessions never expire on their own.** If an order is abandoned or its price changes,
  call `checkout.expire`, or the old link stays payable indefinitely.
- **On Xendit, the customer does not see your line items**, only the total and `description`.
  Put what they need to recognize the order in `description`.
- **On Xendit, one payment produces two events** (`checkout.completed` and `payment.succeeded`).
  Make fulfilment idempotent per order, not per event.
- A PayMongo session can have several failed attempts before a paid one. CulGate reports
  `completed` only when a payment is `paid`.

PayMongo checkout (create, retrieve, expire) was verified against PayMongo's test environment on
2026-11-16; a completed session and its webhook were not. Xendit checkout is implemented from
documentation and not yet verified. PayMongo does not validate the method list, so an unknown
method is accepted and simply not shown.
