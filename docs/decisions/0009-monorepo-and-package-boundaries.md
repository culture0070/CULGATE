# ADR 0009: One repository, separately installable packages

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

Applications should install only the providers and framework integrations they use, yet the
contracts, adapters, and SDK must evolve together.

## Decision

A pnpm workspace with one package per concern: `core` (contracts), `sdk` (public API), one
`provider-*` package per gateway, and one package per framework. Dependencies point one way:

```text
express, nestjs  ->  sdk  ->  core  <-  provider-*
```

Core imports no other CulGate package. Providers and the SDK import only core. Framework packages
import only the SDK, as a peer dependency. Lint rules enforce this. All packages share one version
number and are released together.

## Alternatives considered

- **A single package** containing every provider. Simplest to install, but every application would
  carry every provider and its dependencies, and adding a provider would change everyone's install.
- **Separate repositories.** Independent releases, at the cost of coordinating every contract
  change across repositories.
- **Independent version numbers per package.** More flexible, but users would need a compatibility
  table; one shared version makes "same version works together" the whole rule.

## Consequences

- Unused providers are never installed or loaded.
- A contract change and the adapters that implement it land in one commit and one release.
- Third parties can publish providers that depend only on `@culgate/core`.
- A fix to one package releases all of them.
