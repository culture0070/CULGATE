# Provider compatibility

What each provider adapter supports today. The PayMongo adapter's payments, refunds, and checkout
were verified against PayMongo's test environment on 2026-11-16. The Xendit adapter, and both
providers' webhooks, are implemented from official documentation and **not yet verified**; see
each provider's guide.

| Capability                                       | PayMongo                                                            | Xendit                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------- |
| `payments.create`                                | Yes                                                                 | Yes                                                     |
| `payments.retrieve`                              | Yes                                                                 | Yes                                                     |
| `payments.cancel`                                | Yes                                                                 | Yes                                                     |
| `payments.capture`                               | No                                                                  | No                                                      |
| `refunds.create` (full, partial)                 | Yes                                                                 | Yes                                                     |
| `refunds.retrieve`                               | Yes                                                                 | Yes                                                     |
| `checkout.create` / `retrieve` / `expire`        | Yes                                                                 | Yes                                                     |
| Checkout methods                                 | `card`, `gcash`, `maya`, `grabpay`, `shopeepay`, `billease`, `qrph` | `card`, `gcash`, `maya`, `grabpay`, `shopeepay`, `qrph` |
| Checkout shows line items                        | Yes                                                                 | No (total and description only)                         |
| Checkout expires by itself                       | Never                                                               | After 30 minutes                                        |
| Webhooks                                         | Yes (HMAC signature)                                                | Yes (shared token, no signature)                        |
| Provider-specific requests (escape hatch)        | Yes                                                                 | Yes                                                     |
| Config from environment variables                | Yes                                                                 | Yes (`XENDIT_ENVIRONMENT` required)                     |
| Currencies                                       | PHP                                                                 | PHP                                                     |
| `gcash` (direct)                                 | Yes                                                                 | Yes                                                     |
| `maya` (direct)                                  | Yes                                                                 | No (unverified)                                         |
| `grabpay` (direct)                               | Yes                                                                 | No (unverified)                                         |
| `shopeepay` (direct)                             | Yes                                                                 | Yes                                                     |
| `billease` (direct)                              | Yes                                                                 | No                                                      |
| Cards                                            | Through checkout only                                               | Through checkout only                                   |
| Idempotency key enforced                         | **No** (documented, but ignored in the sandbox)                     | **No**                                                  |
| Automatic retry of creates                       | Never                                                               | Never                                                   |
| Provider event ID in webhooks                    | Yes                                                                 | Derived from payment/refund IDs                         |
| Payment statuses reported                        | No `failed`/`expired` (see guide)                                   | Full set                                                |
| Refund reason                                    | Code, or text in `notes`                                            | Code, or text in metadata                               |
| Key/environment mismatch detected                | Yes, at startup                                                     | No                                                      |
| Verified against the provider's test environment | Payments, refunds, checkout (2026-11-16); webhooks not yet          | Not yet                                                 |
| Underlying payment resource                      | Payment Intent (`pi_`)                                              | Payment Request (`pr-`)                                 |
| API calls per `payments.create`                  | 3                                                                   | 1                                                       |

Differences that affect portable application code:

- **Direct payments: `gcash` and `shopeepay` work on both providers.** `maya`, `grabpay`, and
  `billease` are PayMongo-only for now. Hosted checkout covers more on both. Check
  `sdk.capabilities.supports({ account, operation, paymentMethod })` before offering a method.
- **Do not retry creates.** Neither provider protects you from duplicates, so CulGate sends each
  create once. After a timeout, reconcile by `reference` before trying again.
- **A failed customer attempt looks different.** PayMongo returns the payment to `pending`; Xendit
  reports `failed`. Do not wait for `failed` as the only signal to let a customer try again.
- **Xendit webhooks are not tamper-evident.** Always confirm with `payments.retrieve`.

Guides: [PayMongo](paymongo.md) · [Xendit](xendit.md)
