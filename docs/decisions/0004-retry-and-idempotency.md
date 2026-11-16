# ADR 0004: Retry and idempotency policy

- **Status:** Accepted; see the 2026-11-16 note at the end
- **Date:** 2026-11-13

## Context

A payment request that times out may or may not have been processed. Retrying it blindly can charge
a customer twice. Providers differ in whether, and for which endpoints, they enforce idempotency
keys.

## Decision

The HTTP transport retries a request only when it is safe to send twice:

- `GET` requests are retried by default.
- Any other request is retried only when the adapter sets `retryable: true`, which it may do only
  when the request carries an idempotency key the provider is documented to enforce for that
  endpoint. The retry resends the identical request, key included.
- Retried conditions: connection failures and timeouts, HTTP 429, and HTTP 502/503/504. HTTP 500
  and all other 4xx responses are not retried.
- Backoff is exponential with full jitter, at most 3 attempts by default, each wait capped at 5
  seconds. A `Retry-After` longer than the cap ends retrying instead of blocking the caller.
- A caller's `AbortSignal` stops retries immediately.

`TimeoutError` and `NetworkError` are never flagged `retryable` at the error level; their message
says the outcome is unknown. Applications should retrieve the payment (or retry with the same
idempotency key where the provider supports it) rather than create a new one.

## Alternatives considered

- **Retry all requests on network errors.** Simple, and unsafe for payment creation.
- **Retry any request that has an idempotency key.** Unsafe when the provider ignores the key for
  that endpoint; the adapter, which knows the provider's documented behaviour, must decide.
- **No retries in the SDK.** Safe, but pushes boilerplate for harmless read retries onto every
  application.

## Consequences

- Each provider adapter must record, per operation, whether idempotency is enforced, and set
  `retryable` accordingly. This is part of the provider research gate.
- Applications still need reconciliation logic for ambiguous outcomes; CulGate reports them
  honestly but cannot resolve them without state.

## Note, 2026-11-16: no provider currently qualifies

The rule above lets an adapter mark a write `retryable` when the provider enforces an idempotency
key. In practice no supported provider does: Xendit documents no mechanism, and PayMongo's test
environment ignored its documented `Idempotency-Key` header (one key produced two payment intents,
two checkout sessions, and two refunds). Both adapters therefore never mark a write as retryable.
The transport rule stands for a future provider that can demonstrate enforcement; documentation
alone is no longer accepted as proof.
