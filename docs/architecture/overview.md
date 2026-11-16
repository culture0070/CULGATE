# Architecture overview

_Status: reflects Phase 1 (core contracts, SDK routing, HTTP transport, mock provider)._

## Package boundaries

```text
@culgate/express ─┐
@culgate/nestjs ──┴──> @culgate/sdk ──────────────┐
                       @culgate/provider-paymongo ├──> @culgate/core
                       @culgate/provider-xendit ──┘
```

- **`@culgate/core`** has no runtime dependencies and imports no other CulGate package. It owns the
  canonical models, money utilities, error hierarchy, capability types, the provider adapter
  contract, and the provider registry.
- **Provider packages** depend only on core and implement its contract.
- **`@culgate/sdk`** depends only on core. It never imports a concrete provider; applications pass
  provider definitions in ([ADR 0001](../decisions/0001-explicit-provider-registration.md)).

- **`@culgate/express` and `@culgate/nestjs`** depend only on the SDK (as a peer) and their
  framework. They adapt requests to `sdk.webhooks.handle()` and register the SDK for injection;
  they contain no payment or provider logic.

These rules are enforced by `no-restricted-imports` in `eslint.config.js`.

## Request flow

```text
sdk.payments.create({ account, ... })
  1. validate input                 (ValidationError; nothing leaves the process)
  2. AccountManager.resolve(account)(ConfigurationError if missing/unknown; no default account)
  3. adapter.capabilities.check()   (UnsupportedOperationError before any provider code runs)
  4. adapter.payments.create()      (the adapter bound to that one account's credentials)
  5. stamp accountId + provider     (done by the SDK, so an adapter cannot mislabel ownership)
```

Steps 3–4 live in one function (`packages/sdk/src/dispatch.ts`) that every resource method uses.
The mock provider goes through exactly this path.

## Providers and adapters

A `ProviderDefinition` is registered once per SDK. For each configured account the SDK calls
`parseConfig` (provider-specific credential validation) and then `createAdapter`, producing one
adapter per account. Two accounts on the same provider get two adapters with separate credentials
and state.

An adapter declares `capabilities.operations` and implements the matching methods. At startup the
SDK verifies every declared operation is implemented, so a false capability claim fails
initialization instead of a customer's payment.

`capabilities.check({ operation, currency, paymentMethod, country })` is contextual and per
account. `createStaticCapabilities` is a simple allow-list helper; real adapters may implement
richer logic.

## Credentials

- The SDK passes a frozen copy of each account's config to its provider and retains only
  `{ id, provider, environment }`.
- SDK internals use `#private` fields; `JSON.stringify(sdk)` and `util.inspect(sdk)` reveal account
  IDs, provider names, and environments only.
- Configuration errors name the offending key, never its value.
- Adapters must keep credentials out of enumerable properties, results, and errors. This is tested
  for the mock and will be part of the shared adapter contract suite.

## Money

`Money` is `{ value, currency }` with `value` a non-negative safe integer in the ISO 4217 minor
unit. `toDecimalString` / `fromDecimal` convert to and from major-unit decimals using string and
`BigInt` operations only, and reject excess precision instead of rounding. Provider-specific
deviations from ISO exponents belong in the provider adapter.

## Identifiers

CulGate is stateless, so it cannot mint its own durable payment IDs. `Payment.id` is the provider's
payment ID and is only meaningful together with `accountId`
([ADR 0003](../decisions/0003-payment-ids-are-provider-ids.md)).

## HTTP transport

`createHttpClient` in core is what provider adapters use to call their API. One client is bound to
one account and one fixed base URL.

- **Destination is fixed.** Paths must be absolute, already normalized, and stay under the base
  URL; traversal, encoded traversal, embedded queries, and control characters are rejected before
  anything is sent. Redirects are refused, so credentials are never forwarded to another host.
- **Authentication is applied last**, so per-request headers cannot override it.
- **Every request has a timeout.** A timeout or connection failure raises `TimeoutError` /
  `NetworkError`, whose message states that the outcome is unknown.
- **Retries are opt-in for writes.** GETs are retried; a write is retried only when the adapter
  marks it `retryable` because it carries a provider-enforced idempotency key
  ([ADR 0004](../decisions/0004-retry-and-idempotency.md)).
- **Errors and logs carry no bodies or headers.** The default error is status-based; adapters
  supply `mapError` to add provider codes.

The SDK passes an optional application `fetch` and `logger` to every adapter.

## Provider contract checker

`assertProviderContract` (`@culgate/core/testing`) is a framework-agnostic check each provider's
test suite runs: required config keys fail with a `ConfigurationError` that names the key and
echoes no value; every declared operation is implemented; undeclared operations are reported
unsupported with a reason; and the adapter object exposes no configured secret. Behavioural checks
against recorded provider responses will be added with the first real adapter.

## Webhooks

`sdk.webhooks` takes `{ account, rawBody, headers }` from the application. For the chosen account
it checks the webhook capability, calls the adapter's `verify`, and only then `normalize`; the
result is stamped with the account like every other model. `handle()` adds deduplication through
an application-supplied atomic event store and dispatches to registered handlers, returning the
HTTP response to send. See the [webhook guide](../guides/webhooks.md),
[ADR 0005](../decisions/0005-webhook-verification.md) and
[ADR 0006](../decisions/0006-atomic-webhook-event-claims.md).

## Provider escape hatch

`sdk.accounts.getClient(account).providerRequest()` sends a provider-specific request through the
adapter's own HTTP client, so the fixed destination, refused redirects, and credential handling
described above apply unchanged. It adds a closed input shape and rejects caller-supplied
credential headers. See [ADR 0007](../decisions/0007-provider-escape-hatch.md).

## Checkout sessions

`sdk.checkout` creates provider-hosted payment pages. A session is modelled as its own resource,
separate from a payment, with its own statuses; when it completes, `paymentId` links it to the
payment so the existing payment and refund operations apply. Each adapter declares its checkout
payment methods separately from its direct-payment methods.

## Not built yet

Customers, invoices, and payouts. Operations are added to the `Operation` union
only when a provider-neutral contract for them exists.
