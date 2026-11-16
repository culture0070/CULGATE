# ADR 0012: Capabilities are declared per account and checked before every call

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

Providers do not support the same operations, currencies, or payment methods, and support can
depend on how an account is configured. A unified API that hides this either fails late, with a
confusing provider error, or pretends to succeed.

## Decision

Each adapter exposes `capabilities`: the list of operations it supports, and a
`check({ operation, currency, paymentMethod, country })` function returning supported or a reason.
An adapter instance belongs to one account, so the answer can depend on that account's
configuration; for example, webhook operations exist only when a webhook secret is configured, and
checkout and direct payments have different payment-method lists.

The SDK:

- verifies at startup that every declared operation is implemented, so a false claim fails
  initialization;
- checks capabilities before every call and throws `UnsupportedOperationError`, with the reason,
  before any provider code runs;
- exposes the same check to applications as `sdk.capabilities.supports()`.

The `Operation` union lists only operations that have a provider-neutral contract. An operation is
added when its contract is, not before.

## Alternatives considered

- **Optional adapter methods only.** "Is the method there?" cannot express "yes, but not in USD".
- **A static table per provider brand.** Cannot reflect account configuration.
- **Let the provider reject it.** Costs a network call, yields provider-specific errors, and for
  some operations risks a partial side effect.

## Consequences

- Unsupported operations fail the same way on every provider, before anything is sent.
- Applications can ask before offering a payment method.
- A capability describes what the adapter implements, not what a merchant's account has enabled at
  the provider; the provider can still refuse a call that CulGate allowed.
