# Errors and retries

Every error CulGate throws extends `PaymentSDKError`.

```ts
import { PaymentSDKError, ProviderError, UnsupportedOperationError } from '@culgate/sdk';

try {
  await sdk.payments.create(input);
} catch (error) {
  if (error instanceof UnsupportedOperationError) {
    // this account cannot do this; choose another method or account
  } else if (error instanceof ProviderError) {
    log.warn({ code: error.code, providerCode: error.providerCode, requestId: error.requestId });
  } else if (error instanceof PaymentSDKError) {
    // configuration, validation, network...
  } else {
    throw error;
  }
}
```

## Error types

| Class                       | When                                                     | `retryable`      |
| --------------------------- | -------------------------------------------------------- | ---------------- |
| `ConfigurationError`        | Bad SDK or account configuration, unknown account        | No               |
| `ValidationError`           | Your input was rejected before any request; see `issues` | No               |
| `UnsupportedOperationError` | The account's provider cannot do this; see `reason`      | No               |
| `AuthenticationError`       | The provider rejected the credentials                    | No               |
| `RateLimitError`            | HTTP 429; see `retryAfterMs`                             | Yes              |
| `PaymentNotFoundError`      | No such payment on that account                          | No               |
| `RefundError`               | The provider refused or cannot find a refund             | Varies           |
| `ProviderError`             | Any other provider response; see `providerCode`          | 502/503/504 only |
| `TimeoutError`              | No response in time. **The outcome is unknown.**         | No               |
| `NetworkError`              | No response at all. **The outcome is unknown.**          | No               |
| `WebhookVerificationError`  | A webhook could not be authenticated or parsed           | No               |

Fields on every error: `code` (stable CulGate code), `message`, `provider`, `accountId`,
`retryable`, `details`, `cause`. Provider errors add `httpStatus`, `providerCode` (the provider's
own code, verbatim) and `requestId` when the provider sends one.

Branch on `code` and `providerCode`, not on message text. Messages can include the provider's own
explanation, which is written for developers; do not show it to customers. `JSON.stringify(error)`
gives a safe summary without the stack or `cause`.

## What CulGate retries for you

- **Reads** (`retrieve`) are attempted up to 3 times in total, with exponential backoff and jitter on
  connection failures, timeouts, HTTP 429, and HTTP 502/503/504.
- **Writes** (`create`, `cancel`, refunds) are sent **once**. Neither supported provider reliably
  enforces idempotency keys, so CulGate never repeats a write for you.
- HTTP 500 and other 4xx responses are never retried.

## After a timeout on a write

`TimeoutError` and `NetworkError` on a create mean the provider may or may not have processed it.
Creating again blindly can charge a customer twice.

Do not create again yet. Look for the payment by your `reference` in the provider's dashboard or
your records, or wait for its webhook, and create again only once you know the first attempt did
not go through. On PayMongo, an error from a partly completed `payments.create` carries
`details.paymentIntentId`, the payment intent that already exists.

See [Idempotency and reconciliation](idempotency.md).

## Rate limits

On `RateLimitError`, wait `retryAfterMs` when it is set, otherwise back off. CulGate already does
this for reads, within a 5-second cap per wait; a longer provider-requested wait is surfaced to you
instead of blocking your request.

## Timeouts

Every provider request has a timeout: 30 seconds by default, configurable per account with
`timeoutMs`. A `payments.create` on PayMongo is three requests, each with its own timeout.
