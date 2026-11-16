# Xendit provider

- **Package:** `@culgate/provider-xendit`
- **API:** Payments API v3 (Payment Requests, Payments, Refunds), `api-version: 2024-11-11`
- **Researched:** 2026-11-13, from Xendit's official documentation only (URLs at the end)
- **Verification status:** implemented from documentation and tested against documented payloads.
  **Not yet verified against Xendit test mode.** See [Open questions](#open-questions).

## Usage

```ts
import { PaymentSDK } from '@culgate/sdk';
import { xendit } from '@culgate/provider-xendit';

const sdk = new PaymentSDK({
  providers: [xendit()],
  accounts: {
    'xendit-primary': {
      provider: 'xendit',
      secretKey: process.env.XENDIT_SECRET_KEY!,
      webhookToken: process.env.XENDIT_WEBHOOK_TOKEN, // optional; enables webhooks
      environment: 'test',
    },
  },
});

const payment = await sdk.payments.create({
  account: 'xendit-primary',
  amount: { value: 150000, currency: 'PHP' }, // PHP 1,500.00
  paymentMethod: { type: 'gcash' },
  returnUrls: { success: 'https://example.com/success', cancel: 'https://example.com/cancel' },
  reference: 'ORDER-123',
});
// payment.status === 'requires_action'; send the customer to payment.checkoutUrl
```

**The key decides the mode.** Xendit issues separate test and live keys but documents no prefix
that tells them apart, so CulGate cannot check that `secretKey` matches `environment`. A live key
on an account marked `test` will move real money.

## Compatibility matrix

| CulGate operation                       | Supported                | Xendit API                                               |
| --------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `payments.create`                       | Yes                      | `POST /v3/payment_requests`                              |
| `payments.retrieve`                     | Yes                      | `GET /v3/payment_requests/{id}`                          |
| `payments.cancel`                       | Yes                      | `POST /v3/payment_requests/{id}/cancel`                  |
| `payments.capture`                      | **No**                   | See [Not supported](#not-supported)                      |
| `refunds.create`                        | Yes                      | `GET /v3/payment_requests/{id}`, then `POST /v3/refunds` |
| `refunds.retrieve`                      | Yes                      | `GET /v3/refunds/{id}`, then `GET /v3/payments/{id}`     |
| `checkout.create`                       | Yes                      | `POST /sessions` (`mode: PAYMENT_LINK`)                  |
| `checkout.retrieve`                     | Yes                      | `GET /sessions/{id}`                                     |
| `checkout.expire`                       | Yes                      | `POST /sessions/{id}/cancel`                             |
| `webhooks.verify`, `webhooks.normalize` | Yes, with `webhookToken` | `x-callback-token` header                                |
| `provider.request` (escape hatch)       | Yes                      | Any path on the API host                                 |

| Dimension       | Supported                                                  |
| --------------- | ---------------------------------------------------------- |
| Currency        | `PHP`                                                      |
| Payment methods | `gcash` (Xendit `GCASH`), `shopeepay` (Xendit `SHOPEEPAY`) |
| Amount range    | PHP 1.00 to 100,000.00 per Xendit's channel pages          |

## How CulGate concepts map

- **A CulGate payment is a Xendit Payment Request.** `Payment.id` is the `pr-...` ID. The Payment
  (`py-...`) made against it is `latest_payment_id` in `payment.raw`.
- **Amounts.** Xendit uses JSON numbers in major units (`1500.5` for PHP 1,500.50). CulGate converts
  from and to integer minor units through decimal strings and verifies the round trip; a response
  amount with more decimals than the currency allows is reported as an invalid response, never
  rounded.
- **Country** is required by Xendit and derived from the channel (GCash and ShopeePay: `PH`).
- **`reference`** maps to `reference_id`, which Xendit requires. When you pass none, CulGate sends
  a generated `culgate-<uuid>` and does not report it back as your reference.
- **Return URLs.** `returnUrls.success` is required and becomes `success_return_url`.
  `failure_return_url` is `returnUrls.cancel`, or the success URL when no cancel URL is given.
- **`checkoutUrl`** is the `REDIRECT_CUSTOMER` / `WEB_URL` action. Deep links stay in `raw`.
- **`metadata`**: up to 50 keys, keys up to 40 characters, values string/number/boolean/null up to
  500 characters. Anything else is rejected, not coerced.
- **Refunds target the Payment** (`py-...`) behind the request; `refunds.create` looks it up.
  Omitting `amount` requests a full refund. Xendit requires a reason code (`FRAUDULENT`,
  `DUPLICATE`, `REQUESTED_BY_CUSTOMER`, `CANCELLATION`, `OTHERS`, matched case-insensitively); any
  other text is sent as `OTHERS` with the text in refund metadata under `culgate_reason`.

### Payment status

| Xendit request status           | CulGate status    |
| ------------------------------- | ----------------- |
| `REQUIRES_ACTION`               | `requires_action` |
| `ACCEPTING_PAYMENTS`, `PENDING` | `pending`         |
| `AUTHORIZED`                    | `authorized`      |
| `SUCCEEDED`                     | `succeeded`       |
| `FAILED`                        | `failed`          |
| `CANCELED`                      | `cancelled`       |
| `EXPIRED`                       | `expired`         |
| anything else                   | `unknown`         |

The request stays `SUCCEEDED` after a refund, so this adapter never reports `partially_refunded`
or `refunded`; use the refund's own status. Refund statuses `PENDING`, `SUCCEEDED`, `FAILED` map
one-to-one.

### Errors

Xendit returns `{ "error_code", "message" }`.

| Condition                                      | CulGate error                                            |
| ---------------------------------------------- | -------------------------------------------------------- |
| HTTP 401 or `INVALID_API_KEY`                  | `AuthenticationError`                                    |
| `DATA_NOT_FOUND` / 404 on a payment            | `PaymentNotFoundError`                                   |
| Not found on a refund                          | `RefundError`, code `refund_not_found`                   |
| Any rejection of `POST /v3/refunds`            | `RefundError`                                            |
| HTTP 429 `RATE_LIMIT_EXCEEDED`                 | `RateLimitError`, `retryAfterMs` from `Rate-Limit-Reset` |
| Everything else (including 403 business rules) | `ProviderError`                                          |

`providerCode` holds Xendit's `error_code`.

## Idempotency: not available

Xendit documents **no idempotency header** for Payment Requests v3 or Refunds v3. Therefore:

- `idempotencyKey` on `payments.create` is **not enforced**. Calling twice creates two payment
  requests.
- Creates and refunds are **never retried automatically**, including after a timeout.
- After a timeout on `payments.create`, check your Xendit dashboard or records by `reference`
  before trying again.
- For refunds, `idempotencyKey` is sent as the refund's `reference_id` for traceability. Xendit
  can answer a repeat with `DUPLICATE_ERROR`, but does not document that as a guarantee.

This differs from PayMongo, where the key is enforced. Code that relies on idempotent retries is
not portable to Xendit accounts.

## Checkout

`sdk.checkout` uses Xendit Payment Sessions with `session_type: PAY` and `mode: PAYMENT_LINK`. See
the [checkout guide](../guides/checkout.md).

- Only the **total** and `description` are sent. Xendit's `items` require a product type and
  category per item, which CulGate does not model, so the hosted page does not list line items.
- Currency is `PHP` (country `PH`).
- `paymentMethods` becomes `allowed_payment_channels` (`CARDS`, `GCASH`, `PAYMAYA`, `GRABPAY`,
  `SHOPEEPAY`, `QRPH`). Omit it to offer every channel activated on your Xendit account. A channel
  that is not activated is rejected by Xendit with `INVALID_PAYMENT_CHANNEL`.
- `reference` is sent as `reference_id` (at most 64 characters; generated when omitted).
- Return URLs must be `https`.
- Sessions expire 30 minutes after creation.
- `paymentId` on a completed session is its `payment_request_id`.
- The Sessions API takes no `api-version` header and documents no idempotency mechanism: creates
  are never retried.
- Webhooks `payment_session.completed` and `payment_session.expired` become `checkout.completed`
  and `checkout.expired`. A paid session also produces `payment.capture`
  (`payment.succeeded`) for the same payment.

## Webhooks

Set the account's `webhookToken` to the webhook verification token from the Xendit dashboard, and
point the dashboard's Payments API webhook URLs at a route dedicated to this account. See the
[webhook guide](../guides/webhooks.md).

**Verification is a shared token, not a signature.** Xendit sends the token in
`x-callback-token`; CulGate compares it in constant time. Because nothing is computed over the
body, the token proves origin only as long as it stays secret, and the body is not
tamper-evident. Treat events as signals and confirm with `payments.retrieve` before fulfilling.
The token belongs to the Xendit account, so do not reuse one Xendit account's URL for another.

**Event mapping.**

| Xendit event                               | CulGate event       | `resourceId`       |
| ------------------------------------------ | ------------------- | ------------------ |
| `payment.capture`                          | `payment.succeeded` | Payment request ID |
| `payment.failure`                          | `payment.failed`    | Payment request ID |
| `payment.expiry`, `payment_request.expiry` | `payment.expired`   | Payment request ID |
| `refund.succeeded`                         | `refund.succeeded`  | Refund ID          |
| `refund.failed`                            | `refund.failed`     | Refund ID          |
| everything else                            | `provider.unknown`  | —                  |

`payment.authorization` (manual-capture cards), payment-token events, and callbacks from older
Xendit products arrive as `provider.unknown` with the original payload.

**Event IDs are derived.** Xendit's payloads carry no event ID. Following Xendit's guidance that
`payment_id` and `capture_id` identify a unique payment event, CulGate builds the ID as
`<event>:<payment_id>[:<capture_id>]`, and `<event>:<refund_id>` for refunds. An event without a
`payment_id` has no ID and is not deduplicated.

**Delivery.** Success is any 2xx. Xendit retries up to six times over about 24 hours and states
that events may arrive in any order.

## Not supported

- **`payments.capture`.** Manual capture is cards-only in Xendit; CulGate does not create card
  payments.
- **Cards through `payments.create`.** Require card data or tokenization on the client. Use checkout.
- **Maya (`PAYMAYA`) and GrabPay (`GRABPAY`) through `payments.create`.** The channels exist, but
  Xendit documents their request properties only in an interactive widget. Excluded until
  confirmed in test mode. Both are available through [checkout](#checkout).
- **Other countries and channels** (Indonesian e-wallets, QR, virtual accounts, direct debit).
- **Invoices, customers, payouts.** No CulGate contracts yet.
- **xenPlatform** (`for-user-id`, `with-split-rule`).

## Open questions

To be settled in Xendit test mode before this provider is advertised as supported:

```bash
XENDIT_TEST_SECRET_KEY=... XENDIT_SANDBOX_CONFIRM_TEST_MODE=yes pnpm --filter @culgate/provider-xendit test
```

1. **Channel properties.** `success_return_url` and `failure_return_url` are shown in examples for
   GCash and ShopeePay; whether both are required, and whether `cancel_return_url` exists, is not
   stated.
2. **`latest_payment_id` for e-wallets.** The docs do not say it is populated for non-card channels
   after payment. Refunds depend on it.
3. **`api-version` header.** Marked required for refunds but not for payment requests; the adapter
   always sends `2024-11-11`.
4. **Idempotency.** Whether an undocumented idempotency header is honoured.
5. **Webhook token scope.** Whether test and live modes use different tokens.
6. **Webhook event ID.** Whether deliveries carry an ID header that could replace the derived ID.
7. **`payment.expiry` and `payment_request.expiry` payloads** are not documented.
8. **`country`** is optional in the schema but described as required in the v3 migration guide; the
   adapter always sends it.
9. **Key prefixes** for test and live keys are not documented.

10. **Refunding a checkout payment.** `refunds.create` looks up `latest_payment_id` on the
    session's payment request; that this is populated for session-created requests is not stated.
11. **Session webhooks and `x-callback-token`.** The token is documented for webhooks in general,
    not specifically for session events.
12. **Session metadata limits** are stated two ways (50 keys/500 characters, and 20 keys/80
    characters). CulGate enforces the looser one and lets Xendit reject the rest.
13. **Channel codes in `allowed_payment_channels`** for the Philippines are taken from the channel
    pages; the session reference lists them only in an interactive widget.

## Sources

All read on 2026-11-13 from `docs.xendit.co` (`developers.xendit.co` redirects there).

- Setup and keys: `/apidocs`, `/apidocs/introduction`, `/docs/api-keys`, `/apidocs/rate-limits`
- Payment Requests: `/apidocs/create-payment-request`, `/apidocs/get-payment-request`,
  `/apidocs/cancel-payment-request`, `/apidocs/simulate-payment-test-mode`,
  `/docs/pay-one-off-payment`, `/docs/payments-api-features`
- Payments: `/apidocs/get-payment`, `/apidocs/capture-payment`, `/apidocs/cancel-payment`
- Refunds: `/apidocs/create-a-refund`, `/apidocs/get-a-refund`,
  `/apidocs/list-refunds-for-a-payment`, `/docs/refund-payment-request`
- Channels: `/docs/available-payment-methods`, `/docs/gcash`, `/docs/maya`, `/docs/grabpay`,
  `/docs/shopeepay`
- Webhooks: `/docs/handling-webhooks`, `/docs/payments-api-webhooks`,
  `/apidocs/payment-webhook-notification`, `/apidocs/refund-webhook-notification`,
  `/apidocs/webhook-behavior`, `/docs/integration-security`
- Migration notes: `/docs/migrate-payment-api-v2-to-v3`, `/docs/migrate-direct-per-method-apis-to-v3`
- For later phases: `/apidocs/create-session`, `/apidocs/create-customer-request`,
  `/apidocs/create-payout-v3`
