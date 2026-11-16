# Webhooks

CulGate verifies a provider's webhook request, normalizes it into a `CulGateWebhookEvent`, and
optionally deduplicates and dispatches it. It does not receive HTTP requests itself: your
application passes in the raw body and headers, or you use the [Express](express.md) or
[NestJS](nestjs.md) package to do that for you.

## Rules that keep you safe

1. **Bind each webhook URL to one account.** Register a separate URL per account with the provider
   (for example `/webhooks/paymongo-primary`) and pass that account ID yourself. Never read the
   account from the request body.
2. **Pass the raw body.** Signatures cover the exact bytes received. A body that was JSON-parsed
   and re-serialized will not verify. Passing a parsed object is rejected with
   `raw_body_required`.
3. **Write idempotent handlers.** Providers retry, so the same event can arrive more than once.
4. **Treat an event as a signal, not the truth.** Events can arrive late or out of order. On
   receipt, call `payments.retrieve` and act on the current status.
5. **Acknowledge quickly.** Do slow work on a queue; return `result.response` promptly.

CulGate does not provide exactly-once processing. With an event store it processes an event at
most once per successful claim, which is only as reliable as the store you supply.

## Managed handling

```ts
import express from 'express';

sdk.webhooks.on('payment.succeeded', async (event) => {
  const payment = await sdk.payments.retrieve({
    account: 'paymongo-primary',
    paymentId: event.resourceId!,
  });
  if (payment.status === 'succeeded') await fulfilOrder(payment.reference);
});
sdk.webhooks.on('provider.unknown', (event) => log.info(event.providerEventType));

app.post(
  '/webhooks/paymongo-primary',
  express.raw({ type: '*/*' }), // keeps the body as a Buffer for this route
  async (req, res) => {
    const result = await sdk.webhooks.handle({
      account: 'paymongo-primary',
      rawBody: req.body,
      headers: req.headers,
    });
    res.status(result.response.status).json(result.response.body);
  },
);
```

`handle` never throws for an unauthentic request or a failing handler. It returns:

| `result.status` | Meaning                                                                      | Response |
| --------------- | ---------------------------------------------------------------------------- | -------- |
| `processed`     | Verified; every handler completed                                            | 200      |
| `duplicate`     | Verified; the event store says it is done or in progress                     | 200      |
| `rejected`      | Signature missing or wrong (401), malformed body (400), body too large (413) | 4xx      |
| `failed`        | Verified, but a handler threw; the provider should retry                     | 500      |

Responses are JSON, because PayMongo only counts a delivery as successful when it gets a 2xx
status **with a JSON body**. Configuration mistakes (unknown account, an account without a webhook
secret) throw instead, since retrying cannot fix them.

Handlers run in registration order: handlers for the event's type, then `'*'` handlers. The first
one to throw stops the rest. `on()` returns a function that removes the handler.

## Manual handling

```ts
await sdk.webhooks.verify({ account, rawBody, headers }); // throws WebhookVerificationError
const event = await sdk.webhooks.parse({ account, rawBody, headers }); // verify + normalize
```

`parse` never looks inside the body before verification succeeds, and it does not dispatch or
deduplicate.

## The event

```ts
interface CulGateWebhookEvent {
  id?: string; // provider event ID, when there is a stable one
  accountId: string;
  provider: string;
  type: WebhookEventType; // e.g. 'payment.succeeded', 'checkout.completed', 'provider.unknown'
  resourceId?: string; // payment or refund ID
  occurredAt?: Date;
  data: unknown; // WebhookPaymentData, WebhookRefundData or WebhookCheckoutData
  providerEventType: string; // the provider's own name, verbatim
  raw: unknown; // the full parsed payload
}
```

Events CulGate cannot classify are delivered as `provider.unknown` with `providerEventType` and
`raw` intact; nothing is dropped.

## Deduplication

Supply a `WebhookEventStore` to skip redelivered events:

```ts
const sdk = new PaymentSDK({ providers, accounts, webhooks: { eventStore } });
```

```ts
interface WebhookEventStore {
  claim(key: { accountId; provider; eventId }): Promise<boolean>;
  markCompleted(key): Promise<void>;
  markFailed?(key & { error? }): Promise<void>;
}
```

- `claim` must be **atomic**: for concurrent calls with the same key, exactly one gets `true`. In
  SQL this is an `INSERT` guarded by a unique key on `(account_id, provider, event_id)`, treating a
  unique-violation as `false`. A separate "have I seen it?" query followed by an insert is not
  atomic and will double-process under load.
- After `markFailed`, `claim` should succeed again so the provider's retry is processed.
- A claim held too long (the worker crashed before completing) should become claimable again
  after a timeout you choose.
- While one delivery is being processed, a concurrent duplicate is acknowledged with 200. If the
  first then fails, that delivery returns 500 and the provider retries it.

`InMemoryWebhookEventStore` is for tests and local development only: it is lost on restart and not
shared between processes.

**Events without an ID are not deduplicated.** When a provider sends no stable event ID, CulGate
runs your handlers on every delivery rather than invent an ID from a payload hash, which could
wrongly merge two distinct events. Idempotent handlers cover this case.

## Limits

Bodies over 1 MiB are rejected before verification; change this with `webhooks.maxBodyBytes`. Also
limit body size in your HTTP server, since CulGate only sees the body after it was read.

## PayMongo

Set `webhookSecret` (the `whsk_...` value of the webhook you created in PayMongo) on the account.
Each PayMongo webhook has its own secret, and test webhooks only receive test events. See the
[PayMongo guide](../providers/paymongo.md#webhooks) for the event mapping and caveats.
