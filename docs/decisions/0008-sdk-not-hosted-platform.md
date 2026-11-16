# ADR 0008: An SDK, not a hosted orchestration platform

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

A single interface over several payment gateways can be delivered as a hosted service that
applications call, or as a library that runs inside the application.

## Decision

CulGate is a library. It runs in the application's process with the application's credentials and
talks directly to the provider. There is no CulGate server, account, or stored data.

## Alternatives considered

- **Hosted orchestration service.** Enables central routing, dashboards, and stored state, but it
  would hold every merchant's provider credentials and sit in the path of every payment: a
  high-value target, a new point of failure, and a compliance scope of its own.
- **Self-hosted service.** Same operational burden moved to each user, for little gain over a
  library.

## Consequences

- No new party sees credentials or payment data, and there is no CulGate outage to plan for.
- CulGate cannot offer anything that needs shared state: automatic failover between providers,
  cross-application reporting, or stored payment records. Applications own their orders, payment
  records, and reconciliation.
- Routing between providers is an application decision, made per call by choosing an account.
