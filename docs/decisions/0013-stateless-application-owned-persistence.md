# ADR 0013: Stateless SDK; the application owns persistence

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

Payment integrations need durable records: orders, payment IDs, processed webhook events. A
library could store these itself or leave them to the application.

## Decision

CulGate keeps no data between calls and requires no database, cache, or queue. It holds only
configuration and provider clients in memory.

Where behaviour needs persistence, CulGate defines a small interface and the application supplies
the implementation. Today that is `WebhookEventStore`, for webhook deduplication. An in-memory
implementation is included for tests and local development only.

Identifiers follow from this: with no store, CulGate cannot issue its own IDs, so a payment's ID is
the provider's ID and is meaningful only with its account ID.

## Alternatives considered

- **A bundled database layer.** Forces a storage choice and migrations on every application, and
  creates a second source of truth beside the application's own orders.
- **Pluggable storage for everything** (payments, refunds, events). A large surface that
  duplicates what applications already do, with consistency rules CulGate cannot enforce.

## Consequences

- Nothing to provision, migrate, or back up; CulGate works in serverless and short-lived processes.
- The provider is the source of truth for payment state, read through `retrieve`.
- Features that need memory are opt-in and only as reliable as the store the application provides.
- CulGate cannot list "all payments" or answer questions about history; applications keep their
  own records.
