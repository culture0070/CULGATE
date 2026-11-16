# PayMongo provider

- **Package:** `@culgate/provider-paymongo`
- **Researched:** 2026-11-13, from PayMongo's official documentation only (URLs at the end)
- **Verification status:** payments, refunds, and checkout (create, retrieve, expire) were
  verified against PayMongo's test environment on 2026-11-16. **Webhook verification has not been
  confirmed against a real delivery**, and nothing has run in live mode. See
  [Verified in the sandbox](#verified-in-the-sandbox) and [Open questions](#open-questions).

## Usage

```ts
import { PaymentSDK } from '@culgate/sdk';
import { paymongo } from '@culgate/provider-paymongo';

const sdk = new PaymentSDK({
  providers: [paymongo()],
  accounts: {
    'paymongo-primary': {
      provider: 'paymongo',
      secretKey: process.env.PAYMONGO_SECRET_KEY!, // sk_test_... or sk_live_...
      environment: 'test',
    },
  },
});

const payment = await sdk.payments.create({
  account: 'paymongo-primary',
  amount: { value: 150000, currency: 'PHP' },
  paymentMethod: { type: 'gcash' },
  returnUrls: { success: 'https://example.com/payment/return' },
  reference: 'ORDER-123',
  idempotencyKey: 'order-123-payment',
});
// payment.status === 'requires_action'; send the customer to payment.checkoutUrl
```

The secret key's prefix must match `environment` (`sk_test_` / `sk_live_`); a mismatch or a public
key fails at startup.

## Compatibility matrix

| CulGate operation                       | Supported                 | PayMongo API                                                            |
| --------------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `payments.create`                       | Yes                       | `POST /v1/payment_intents`, `POST /v1/payment_methods`, `POST …/attach` |
| `payments.retrieve`                     | Yes                       | `GET /v1/payment_intents/{id}`                                          |
| `payments.cancel`                       | Yes                       | `POST /v1/payment_intents/{id}/cancel`                                  |
| `payments.capture`                      | **No**                    | See [Not supported](#not-supported)                                     |
| `refunds.create`                        | Yes                       | `GET /v1/payment_intents/{id}`, then `POST /v1/refunds`                 |
| `refunds.retrieve`                      | Yes                       | `GET /v1/refunds/{id}`, then `GET /v1/payments/{id}`                    |
| `checkout.create`                       | Yes                       | `POST /v2/checkout_sessions`                                            |
| `checkout.retrieve`                     | Yes                       | `GET /v1/checkout_sessions/{id}`                                        |
| `checkout.expire`                       | Yes                       | `POST /v1/checkout_sessions/{id}/expire`                                |
| `webhooks.verify`, `webhooks.normalize` | Yes, with `webhookSecret` | `Paymongo-Signature` header                                             |
| `provider.request` (escape hatch)       | Yes                       | Any path on the API host                                                |

| Dimension                | Supported                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Currency                 | `PHP` only (the only currency PayMongo documents)                                           |
| Payment methods (direct) | `gcash`, `maya` (`paymaya`), `grabpay` (`grab_pay`), `shopeepay` (`shopee_pay`), `billease` |
| Minimum amount           | 100 centavos (PHP 1.00)                                                                     |

## How CulGate concepts map

- **A CulGate payment is a PayMongo Payment Intent.** `Payment.id` is the `pi_...` ID. PayMongo's
  separate Payment resource (`pay_...`) appears inside `payment.raw`.
- **`payments.create` is three API calls**: create the intent, create a payment method of the
  requested type, attach it with `return_url`. The attach response carries
  `next_action.redirect.url`, returned as `checkoutUrl`.
  - `paymentMethod.type` and `returnUrls.success` are required. PayMongo has a single return URL;
    `returnUrls.cancel` is not used.
  - If the second or third call fails, the intent already exists. The thrown error's
    `details.paymentIntentId` names it so it can be retrieved, retried, or cancelled.
- **`reference`** has no PayMongo field. It is stored in intent metadata as `culgate_reference`
  and restored on retrieval.
- **`metadata`** values must be strings (PayMongo's rule); other types are rejected, not coerced.
  Keys starting with `PYM_` are reserved by PayMongo.
- **Refunds target the paid Payment** behind the intent. `refunds.create` looks it up. PayMongo
  requires an amount, so when you omit `amount` CulGate sends what is still refundable: the
  payment amount less its refunds that have not failed. PayMongo requires a reason code
  (`duplicate`, `fraudulent`, `requested_by_customer`, `others`); any other text is sent as
  `others` with the text in `notes`.
- **The return URL gets a query parameter.** PayMongo appends `?payment_intent_id=pi_...` to your
  `returnUrls.success` for most methods when it sends the customer back.

### Payment status

| PayMongo intent status    | CulGate status    | Notes                                                        |
| ------------------------- | ----------------- | ------------------------------------------------------------ |
| `awaiting_payment_method` | `pending`         | Also the state after a failed attempt; see below             |
| `awaiting_next_action`    | `requires_action` | Customer must complete the redirect                          |
| `processing`              | `processing`      | Transient; PayMongo suggests re-querying after 1–2 seconds   |
| `awaiting_capture`        | `authorized`      | Only for manual-capture card intents created outside CulGate |
| `succeeded`               | `succeeded`       |                                                              |
| `cancelled`               | `cancelled`       |                                                              |
| anything else             | `unknown`         | Original value is always in `providerStatus`                 |

PayMongo has **no failed intent status**: a failed or expired attempt returns the intent to
`awaiting_payment_method`. This adapter therefore never reports `failed` or `expired` for a
payment, and never reports `partially_refunded`/`refunded` (the intent stays `succeeded`; use the
refund's own status).

### Refund status

`pending`, `processing`, `succeeded`, `failed` map one-to-one; anything else is `unknown`. Refunds
are created `pending` and complete later.

### Errors

PayMongo returns `{ "errors": [{ "code", "detail", "source": { "pointer" } }] }`.

| Condition                                                                                                                   | CulGate error                          |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| HTTP 401, or codes `api_key_required`, `authentication_invalid`, `api_key_not_found`, `secret_key_required`, `unauthorized` | `AuthenticationError`                  |
| `resource_not_found` (documented with 404 and with 400) on a payment                                                        | `PaymentNotFoundError`                 |
| Not found on a refund                                                                                                       | `RefundError`, code `refund_not_found` |
| Any rejection of `POST /v1/refunds`                                                                                         | `RefundError`                          |
| HTTP 429                                                                                                                    | `RateLimitError`                       |
| Everything else                                                                                                             | `ProviderError`                        |

`providerCode` holds PayMongo's first error code; `details.errors` lists every code, pointer, and
sub-code. `requestId` is PayMongo's `x-request-id`.

`account_not_activated` is a plain `ProviderError` unless it comes with HTTP 401: PayMongo also
returns it with HTTP 400 when a payment method (for example QR Ph) is not enabled for the
merchant, which is not a credentials problem.

## Idempotency: not enforced

PayMongo documents an `Idempotency-Key` header for resource creation. **In the test environment on
2026-11-16 it had no effect**: the same key and body produced two payment intents, two checkout
sessions, and two refunds. Whether live mode behaves differently is unknown.

CulGate still sends the header when you pass `idempotencyKey` (`<key>:pi` and `<key>:pm` for the
two resources a payment creates, `<key>` for refunds and checkout), so you benefit if PayMongo
enforces it. But nothing relies on it:

- No create, attach, cancel, or refund is ever retried automatically.
- After a timeout, reconcile before trying again; see the
  [idempotency guide](../guides/idempotency.md).

Because of the suffixes, the key may be at most 252 characters for `payments.create`.

## Not supported

- **`payments.capture`.** PayMongo's hold-then-capture is for Visa/Mastercard on specifically
  enabled merchant accounts, and requires a manual-capture card intent. CulGate does not create
  card payments directly, so there is nothing it could capture.
- **Cards through `payments.create`.** Creating a card payment method requires raw card details,
  which CulGate does not handle (PCI scope). Use [checkout](#checkout) for cards.
- **QR Ph through `payments.create`.** It returns a QR image rather than a redirect URL, which
  needs a model field CulGate does not have yet. It is available through checkout, if enabled on
  your PayMongo account.
- **Direct online banking (`dob`) and Brankas.** Require bank details CulGate does not model.
- **Payment Links, Customers, payouts.** No CulGate contracts yet.

## Checkout

`sdk.checkout` uses PayMongo Checkout Sessions v2. See the [checkout guide](../guides/checkout.md).

- Line items are sent as given; `amount` is per unit in centavos.
- `payment_method_types` is required by PayMongo. CulGate accepts `card`, `gcash`, `maya`,
  `grabpay`, `shopeepay`, `billease`, and `qrph`, and sends `card`, `gcash`, and `qrph` when you
  choose none. **PayMongo does not validate this list**: the sandbox accepted an arbitrary string.
  A method that is not enabled on your account is simply not offered on the page.
- `reference` is sent as `reference_number`.
- The create response contains only the URL and timestamps, so the returned session's amount,
  reference, and metadata are what you sent.
- Session status is only ever `active` or `expired`. CulGate reports `completed` when one of the
  session's payments is `paid`, and returns that payment's Payment Intent ID as `paymentId`.
- **A session never expires by itself.** Call `checkout.expire` to close one.
- `Idempotency-Key` is sent when you pass `idempotencyKey`, but PayMongo's sandbox ignored it, and
  the create is never retried.
- Sessions are created through v2 and read and expired through the v1 endpoints; PayMongo has no
  v2 retrieve route.
- Webhook `checkout_session.payment.paid` becomes `checkout.completed`. PayMongo sends no event
  when a session expires.

## Webhooks

Create a webhook in PayMongo pointing at a URL dedicated to this account, and put its signing
secret (`whsk_...`) in the account's `webhookSecret`. Each PayMongo webhook has its own secret, and
a test-mode webhook only receives test-mode events. See the [webhook guide](../guides/webhooks.md)
for handling.

**Verification.** PayMongo sends `Paymongo-Signature: t=<timestamp>,te=<test signature>,li=<live
signature>`. The signature is HMAC-SHA256, keyed with the webhook secret, over
`<t>.<raw request body>`. The adapter compares `te` for a `test` account and `li` for a `live`
account, and rejects an event whose `livemode` contradicts the account's environment.

A timestamp tolerance is **off by default**: PayMongo recommends checking `t` but documents no
tolerance and does not say whether retried deliveries carry a fresh timestamp, so a default could
reject legitimate retries. Enable it with
`paymongo({ webhooks: { timestampToleranceSeconds: 300 } })` once verified for your account, and
use an event store to stop replays either way.

**Event mapping.**

| PayMongo event                                   | CulGate event       | `resourceId`                           |
| ------------------------------------------------ | ------------------- | -------------------------------------- |
| `payment.paid`                                   | `payment.succeeded` | Payment intent ID (payment ID if none) |
| `payment.failed`                                 | `payment.failed`    | Payment intent ID (payment ID if none) |
| `payment.refund.updated`, status `succeeded`     | `refund.succeeded`  | Refund ID                              |
| `payment.refund.updated`, status `failed`        | `refund.failed`     | Refund ID                              |
| `payment.refund.updated`, `pending`/`processing` | `refund.pending`    | Refund ID                              |
| everything else                                  | `provider.unknown`  | —                                      |

`payment.refunded`, `link.payment.paid`, `qrph.expired` and all
other events arrive as `provider.unknown` with the original type and payload, because their
payloads are undocumented or concern resources CulGate does not model yet. Refund events identify
the payment by PayMongo's `pay_...` ID (`data.providerPaymentId`), not the CulGate payment ID.

**Delivery.** PayMongo counts a delivery as successful only on HTTP 200–209 **with a JSON body**
(CulGate's suggested response is JSON), times out after 30 seconds, retries up to 12 times, and
disables a webhook after 3 consecutive events exhaust their retries. Duplicates happen; ordering
is not documented. The event `id` (`evt_...`) is used for deduplication.

## Verified in the sandbox

Confirmed against PayMongo's test environment on 2026-11-16, with a test secret key:

| What                                                                      | Result                                                                                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments.create` for `gcash`, `maya`, `grabpay`, `shopeepay`, `billease` | Works with only a `type`; no billing details needed. Returns `awaiting_next_action` and a redirect URL                                                          |
| ShopeePay's type name                                                     | `shopee_pay`. `shopeepay` is rejected                                                                                                                           |
| `payments.retrieve`, `payments.cancel`                                    | Work on `api.paymongo.com`. A second cancel is refused with `resource_cancelled_state`; a paid intent with `resource_succeeded_state`                           |
| A paid payment                                                            | After authorizing on the test page the intent is `succeeded` and `payments[0]` has `id`, `status: "paid"`, `amount`, `payment_intent_id`, and a `refunds` array |
| `refunds.create`, partial and with a free-text reason                     | Works; created `pending`, `succeeded` moments later. `requested_by_customer` is accepted                                                                        |
| Refund above the refundable amount                                        | Refused with `parameter_above_maximum`                                                                                                                          |
| `refunds.retrieve`                                                        | Works at `/v1/refunds/{id}` (and at `/refunds/{id}`)                                                                                                            |
| After refunds                                                             | The intent stays `succeeded` and the payment stays `paid`                                                                                                       |
| Minimum amount                                                            | 100 centavos. 99 is refused with `parameter_below_minimum`                                                                                                      |
| Timestamps                                                                | Unix seconds                                                                                                                                                    |
| Not found                                                                 | HTTP 404 with `resource_not_found`; `not_found` on checkout endpoints                                                                                           |
| Invalid key                                                               | HTTP 401 with `api_key_not_found`                                                                                                                               |
| Request ID                                                                | `x-request-id` response header                                                                                                                                  |
| Checkout create (v2), retrieve and expire (v1)                            | Work. The v1 endpoints serve v2-created sessions. A second expire is refused with HTTP 400                                                                      |
| Checkout `payment_method_types`                                           | Not validated; any string is accepted                                                                                                                           |
| `Idempotency-Key`                                                         | **Ignored** for payment intents, checkout sessions, and refunds                                                                                                 |
| QR Ph                                                                     | Refused with `account_not_activated` (HTTP 400) on an account without it enabled                                                                                |

## Open questions

1. **Webhook signature encoding.** The adapter expects 64 hex characters, which the documented
   examples imply but do not state. This needs one real test-mode delivery to confirm.
2. **Webhook retries:** whether the event `id` and the signature timestamp stay the same across
   retries of one event. Deduplication assumes the `id` does.
3. **`checkout_session.payment.paid` envelope.** The events reference and the hosted-checkout
   guide show two different envelopes. CulGate handles the standard event envelope; the other
   would arrive as `provider.unknown`. A paid checkout session has not been observed.
4. **`payment.refunded` and non-enveloped payloads.** Some documented examples show a bare
   resource without the event envelope; those are delivered as `provider.unknown` without an ID.
5. **Idempotency in live mode.** Ignored in the sandbox; live behaviour is unknown.
6. **Rate limits and the HTTP 429 format** are not documented and were not triggered.
7. **Which intent statuses can be cancelled** beyond `awaiting_payment_method` and
   `awaiting_next_action`, which were confirmed.
8. **Live mode.** Nothing has been run with a live key.

To rerun the automated part:

```bash
PAYMONGO_TEST_SECRET_KEY=sk_test_... pnpm --filter @culgate/provider-paymongo test
```

The paid-payment and refund checks need a person to click "Authorize" on PayMongo's test page, so
they are not in the automated suite.

## Sources

All read on 2026-11-13 from `docs.paymongo.com` (`developers.paymongo.com` redirects there).

- API keys and authentication: `/docs/account-settings-api-keys`
- Error handling: `/docs/developer-tools-error-handling`, `/docs/payment-acceptance-errors-pipm`,
  `/docs/payment-acceptance-errors-refund`
- Idempotency: `/reference/idempotent-requests`
- Payment Intents: `/reference/create-a-paymentintent`, `/reference/retrieve-a-paymentintent`,
  `/reference/attach-to-paymentintent`, `/reference/the-payment-intent-object`,
  `/reference/cancel_payment_intent-1`, `/reference/capture_payment_intent-1`
- Payment Methods: `/reference/create-a-paymentmethod`, `/reference/the-payment-method-object`
- Payments: `/reference/retrieve-a-payment`, `/reference/list-all-payments`
- Refunds: `/docs/payment-acceptance-refunds`, `/reference/create-a-refund`,
  `/reference/retrieve-a-refund`, `/reference/list-all-refunds`
- Guides: `/docs/payment-acceptance-key-concepts`, `/docs/payment-acceptance-e-wallets`,
  `/docs/payment-acceptance-hold-then-capture`, `/docs/payment-acceptance-testing`
- Webhooks: `/docs/developer-tools-webhook-setup-management`, `/docs/developer-tools-webhooks-events`,
  `/docs/developer-tools-retry-logic`, `/docs/developer-tools-best-practices`,
  `/reference/webhook-resource`
- Checkout, links, customers (for later phases): `/reference/create_checkout_sessions_2`,
  `/reference/checkout-session-resource`, `/reference/payment-links`, `/reference/create_customers`
