# ADR 0006: Deduplicate webhooks with an application-owned atomic claim

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

Providers deliver events at least once, sometimes concurrently, and CulGate is stateless. A
"check whether processed, then mark processed" pair has a race: two workers can both pass the
check.

## Decision

Applications may supply a `WebhookEventStore` with an atomic `claim`, plus `markCompleted` and an
optional `markFailed`. `handle()` claims an event before running handlers, completes it on success,
and releases it on failure so the provider's retry is processed. A duplicate that arrives while the
first delivery is still running is acknowledged.

Events without a provider event ID are not deduplicated. CulGate does not derive an ID from a
payload hash.

An in-memory store ships for tests and development only.

CulGate makes no exactly-once claim: the guarantee is at-most-once processing per successful claim,
bounded by the store's atomicity and durability.

## Alternatives considered

- **`hasProcessed()` + `markProcessed()`.** Racy, as above.
- **Built-in persistence.** Contradicts the stateless SDK decision and forces a database choice.
- **Hash-based fallback IDs.** Two genuinely different events can share a payload, and a provider
  may vary payload bytes between retries; either way the result is wrong silently.

## Consequences

- Correct deduplication requires the application to implement a small store on its database.
- If a worker dies mid-processing, recovery depends on the store's claim timeout.
- Handlers must still be idempotent.
