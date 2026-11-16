# ADR 0003: Payment IDs are provider IDs

- **Status:** Accepted (revisit before first public release)
- **Date:** 2026-11-13

## Context

The plan's `Payment` model has both `id` and `providerPaymentId` and asks for "a stable internal ID
strategy". CulGate is stateless: it has no store in which to map an ID it invents back to a
provider resource.

## Decision

`Payment.id` equals `providerPaymentId`, and is only meaningful together with `accountId`. All
operations that take a `paymentId` also take `account`. The same applies to refunds.

## Alternatives considered

- **Self-describing composite ID** (e.g. encoding account + provider ID). Removes the need to pass
  `account` on retrieval, but bakes application-defined account IDs into stored identifiers, so
  renaming an account would orphan them, and it contradicts explicit per-operation account
  selection.
- **Random internal ID.** Impossible to resolve without persistence.

## Consequences

- Applications store `(accountId, payment.id)` together.
- `id` and `providerPaymentId` are redundant for now; `id` is kept so a future ID strategy would not
  change the field applications already use.
