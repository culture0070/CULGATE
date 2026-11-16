# @culgate/express

Express route handler for CulGate webhooks.

```ts
import { paymentWebhook } from '@culgate/express';

// One route per account, mounted before express.json().
app.post('/webhooks/paymongo-primary', paymentWebhook(sdk, { account: 'paymongo-primary' }));
```

It verifies the request against the raw body, normalizes and deduplicates the event, runs the
handlers registered with `sdk.webhooks.on()`, and sends the response the provider expects.

Peer dependencies: `@culgate/sdk`, `express` 4.17+ or 5. See `docs/guides/express.md` in the
repository. MIT licensed.
