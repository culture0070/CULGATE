# Provider-specific requests (escape hatch)

The unified API covers what PayMongo and Xendit have in common. When you need something only one
provider offers, you can call that provider's API directly through the account's client, with the
account's credentials applied for you.

```ts
const client = sdk.accounts.getClient('xendit-primary');

const response = await client.providerRequest<{ payment_link_url: string }>({
  method: 'POST',
  path: '/sessions',
  body: {
    reference_id: 'ORDER-123',
    session_type: 'PAY',
    mode: 'PAYMENT_LINK',
    amount: 1500,
    currency: 'PHP',
    country: 'PH',
  },
});

response.status; // 201
response.body.payment_link_url;
```

**This is not portable.** Paths, request bodies, amounts, statuses, and errors are the provider's
own. CulGate does not validate, convert, or normalize anything here: a Xendit amount is in pesos,
a PayMongo amount is in centavos, and the type you pass to `providerRequest<T>` is your claim, not
a check. Code written against the escape hatch must be rewritten to change provider. Use the
unified resources when they cover the need.

## What you can set

| Field       | Notes                                                           |
| ----------- | --------------------------------------------------------------- |
| `method`    | `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`                      |
| `path`      | Absolute path on the provider's API, for example `/v1/payments` |
| `query`     | Object of strings, numbers, or booleans                         |
| `body`      | Sent as JSON                                                    |
| `headers`   | Extra headers such as a provider API version or idempotency key |
| `timeoutMs` | Defaults to the account's timeout                               |
| `signal`    | An `AbortSignal` to cancel the request                          |

The response is `{ status, headers, body, requestId? }`. Non-2xx responses throw the same errors as
the rest of CulGate (`AuthenticationError`, `RateLimitError`, `ProviderError` with `providerCode`).

## What you cannot set

These are fixed by the account, by design:

- **The host.** Requests go only to the provider's API base URL. A full URL, `//host` path,
  `baseUrl`/`url`/`host` field, path traversal (`..`, including percent-encoded), or a query string
  embedded in `path` is rejected before anything is sent.
- **Credentials.** The account's key is applied last. `Authorization`, `Proxy-*`, `Cookie`,
  `Host`, and connection-control headers are rejected if you supply them.
- **Redirects.** Never followed, so the key cannot be forwarded to another host.
- **Retries.** `GET` is retried on transient failures; every other method is sent exactly once,
  because CulGate cannot know whether your call is safe to repeat. If the provider supports an
  idempotency header for the endpoint, send it yourself in `headers` and retry in your own code.

## Provider notes

- **Xendit:** unified calls send `api-version: 2024-11-11`. Escape-hatch calls send **no**
  `api-version`, because other Xendit products use other versions; add the header the endpoint's
  documentation asks for.
- **PayMongo:** request bodies use the `{ data: { attributes: { ... } } }` envelope, except newer
  endpoints such as Payment Links, which take top-level fields. Follow the endpoint's reference.

## Checking availability

```ts
sdk.capabilities.supports({ account: 'xendit-primary', operation: 'provider.request' });
```
