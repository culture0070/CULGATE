# Express integration

`@culgate/express` is one function, `paymentWebhook`, that turns `sdk.webhooks.handle()` into an
Express route. Everything else (payments, refunds) you call on the SDK directly from your own
routes; there is nothing Express-specific about it.

```ts
import express from 'express';
import { paymentWebhook } from '@culgate/express';

const app = express();

// One route per account. Mount webhook routes BEFORE express.json().
app.post('/webhooks/paymongo-primary', paymentWebhook(sdk, { account: 'paymongo-primary' }));
app.post('/webhooks/xendit-primary', paymentWebhook(sdk, { account: 'xendit-primary' }));

app.use(express.json()); // for the rest of your API
```

Register handlers once at startup with `sdk.webhooks.on(...)`; see the
[webhook guide](webhooks.md).

## Raw body

Signature verification needs the exact bytes the provider sent. `paymentWebhook` gets them from
the first of these that applies:

1. **No body parser ran for the route** (the setup above). The handler reads the request stream
   itself, up to `maxBodyBytes` (default 1 MiB; larger bodies get `413`).
2. **`express.raw()` or `express.text()` on the route**, so `req.body` is a `Buffer` or string:

   ```ts
   app.post('/webhooks/x', express.raw({ type: '*/*' }), paymentWebhook(sdk, { account: 'x' }));
   ```

3. **A global `express.json()` that keeps the bytes** in `req.rawBody`:

   ```ts
   app.use(
     express.json({
       verify: (req, _res, buf) => {
         req.rawBody = buf;
       },
     }),
   );
   ```

If `express.json()` already consumed the body and nothing kept the bytes, the handler does **not**
fall back to re-serializing `req.body` (that would fail verification unpredictably). It passes a
`ConfigurationError` with code `raw_body_unavailable` to your Express error handler, and no
handler runs.

## Options

| Option         | Purpose                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `account`      | Required. The CulGate account this route receives webhooks for.                                                                         |
| `maxBodyBytes` | Limit when the handler reads the stream itself. Default 1 MiB.                                                                          |
| `onResult`     | Called with every outcome (`processed`, `duplicate`, `rejected`, `failed`) before the response is sent. Use it for logging and metrics. |

## Responses

The handler sends `result.response` as JSON: `200` for processed and duplicate events, `401`/`400`/
`413` for rejected ones, `500` when one of your handlers threw (so the provider retries).
Configuration errors, such as an unknown account, go to `next(error)`.
