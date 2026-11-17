# CulGate

> One interface. Multiple payment gateways.

CulGate (short for **Culture-Gate**) is a payment factory for Node.js: one place in your code
that produces the right payment gateway client for each merchant account, behind a single typed
API. Your application calls the same functions for payments, refunds, hosted checkout, and
webhooks, and names the account to use on every call. CulGate translates the call for that
account's provider, currently PayMongo or Xendit, and keeps the provider's real capabilities and
statuses visible instead of hiding them.

It is a library, not a service: it runs in your process with your credentials and stores nothing.

## Status

**Pre-release.** The SDK is complete and tested. The PayMongo adapter's payments, refunds, and
checkout have been verified against PayMongo's test environment. The Xendit adapter and both
providers' webhooks are implemented from official documentation and tested against documented
payloads, but **not yet verified against the real services**. No package is published yet. See the
[release checklist](docs/release/checklist.md).

## Example

```ts
import { PaymentSDK } from '@culgate/sdk';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
import { xendit, xenditAccountFromEnv } from '@culgate/provider-xendit';

const sdk = new PaymentSDK({
  providers: [paymongo(), xendit()],
  accounts: {
    'paymongo-primary': paymongoAccountFromEnv(), // PAYMONGO_SECRET_KEY, ...
    'xendit-primary': xenditAccountFromEnv(), // XENDIT_SECRET_KEY, XENDIT_ENVIRONMENT, ...
  },
});

const payment = await sdk.payments.create({
  account: 'paymongo-primary', // change this to 'xendit-primary' to switch gateway
  amount: { value: 150000, currency: 'PHP' }, // PHP 1,500.00, in centavos
  paymentMethod: { type: 'gcash' },
  reference: 'ORDER-123',
  returnUrls: { success: 'https://example.com/return' },
});

// 'requires_action' is not paid. Send the customer to payment.checkoutUrl,
// then confirm with a webhook or sdk.payments.retrieve().
```

New to CulGate? Read the [usage guide](docs/guides/usage-guide.md): it walks through every step
with examples. To try it without credentials, run one of the [examples](examples/), which use an
in-memory mock provider.

## What it does

| Area                                               | API                                         | Guide                                                              |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| Payments                                           | `sdk.payments.create / retrieve / cancel`   | [Payment lifecycle](docs/guides/payments.md)                       |
| Refunds, full and partial                          | `sdk.refunds.create / retrieve`             | [Refunds](docs/guides/refunds.md)                                  |
| Hosted checkout, including cards                   | `sdk.checkout.create / retrieve / expire`   | [Hosted checkout](docs/guides/checkout.md)                         |
| Webhooks: verify, normalize, deduplicate, dispatch | `sdk.webhooks.on / verify / parse / handle` | [Webhooks](docs/guides/webhooks.md)                                |
| Ask what an account supports                       | `sdk.capabilities.supports`                 | [Compatibility](docs/providers/compatibility.md)                   |
| Provider-specific requests                         | `sdk.accounts.getClient().providerRequest`  | [Escape hatch](docs/guides/escape-hatch.md)                        |
| Several accounts, several providers                | `accounts: { ... }`                         | [Configuration](docs/guides/configuration.md)                      |
| Express and NestJS                                 | `@culgate/express`, `@culgate/nestjs`       | [Express](docs/guides/express.md), [NestJS](docs/guides/nestjs.md) |

## Provider support

|                                       | PayMongo                                               | Xendit                                       |
| ------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Direct e-wallet payments              | GCash, Maya, GrabPay, ShopeePay, BillEase              | GCash, ShopeePay                             |
| Hosted checkout                       | Card, GCash, Maya, GrabPay, ShopeePay, BillEase, QR Ph | Card, GCash, Maya, GrabPay, ShopeePay, QR Ph |
| Refunds, full and partial             | Yes                                                    | Yes                                          |
| Cancel a payment                      | Yes                                                    | Yes                                          |
| Capture an authorized payment         | No                                                     | No                                           |
| Webhooks                              | Signed (HMAC)                                          | Shared token                                 |
| Idempotency key enforced              | No                                                     | No                                           |
| Verified against the test environment | Payments, refunds, checkout                            | Not yet                                      |
| Currency                              | PHP                                                    | PHP                                          |

An unsupported operation throws `UnsupportedOperationError` before anything is sent; it never
silently does nothing. The full matrix, with the differences that matter for portable code, is in
[Provider compatibility](docs/providers/compatibility.md).

## Principles

- **Every call names its account.** No default account, no automatic routing.
- **Only `succeeded` means paid.** `pending`, `requires_action`, `processing`, and `authorized` are
  different states, and an unrecognized provider status is `unknown`, never a guess.
- **Money is an integer in minor units.** No floating-point arithmetic on amounts.
- **Nothing is hidden.** Results carry the provider's own status, IDs, and full payload alongside
  the normalized fields.
- **Safe by default.** Credentials never appear in logs, errors, or serialized objects; writes are
  never retried, because neither provider guarantees idempotency; webhooks are verified against the raw
  request body.

## Packages

| Package                      | Purpose                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `@culgate/sdk`               | `PaymentSDK`; re-exports `@culgate/core`                                        |
| `@culgate/core`              | Contracts, models, money, errors; `@culgate/core/testing` has the mock provider |
| `@culgate/provider-paymongo` | PayMongo adapter                                                                |
| `@culgate/provider-xendit`   | Xendit adapter                                                                  |
| `@culgate/express`           | `paymentWebhook` route handler                                                  |
| `@culgate/nestjs`            | `PaymentModule`, injectable SDK, webhook service                                |

Requirements: Node.js 22.12 or newer. The packages are ES modules; CommonJS applications can
`require()` them. Server-side only: never ship secret keys to a browser.

## Documentation

**Guides**

- **[Usage guide: start here](docs/guides/usage-guide.md)** (step by step, with examples)
- [Accounts, environment variables, and secrets](docs/guides/configuration.md)
- [Payment lifecycle](docs/guides/payments.md)
- [Refunds](docs/guides/refunds.md)
- [Hosted checkout](docs/guides/checkout.md)
- [Webhooks](docs/guides/webhooks.md)
- [Errors and retries](docs/guides/errors-and-retries.md)
- [Idempotency and reconciliation](docs/guides/idempotency.md)
- [Express integration and raw body](docs/guides/express.md)
- [NestJS integration and raw body](docs/guides/nestjs.md)
- [Provider-specific requests (escape hatch)](docs/guides/escape-hatch.md)

**Providers**

- [Compatibility matrix](docs/providers/compatibility.md)
- [PayMongo](docs/providers/paymongo.md)
- [Xendit](docs/providers/xendit.md)

**Reference**

- [API reference](docs/api/README.md)
- [Architecture overview](docs/architecture/overview.md)
- [Architecture decision records](docs/decisions/)
- [Examples](examples/)

**Project**

- [Versioning and migration policy](docs/release/versioning.md)
- [Security policy](SECURITY.md) and [security review](docs/release/security-review.md)
- [Release checklist](docs/release/checklist.md)
- [Contributing](CONTRIBUTING.md)

## Development

```bash
pnpm install
pnpm check          # format check, lint, build, typecheck, tests (including the examples)
pnpm test:consumer  # install the packed packages into a clean project and use them
```

## License

[MIT](LICENSE)
