# ADR 0001: Providers are registered explicitly

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

The plan requires that `@culgate/sdk` depend only on `@culgate/core` and that provider packages not
be mandatory dependencies. Its examples, however, construct `new PaymentSDK({ accounts })` with
`provider: 'paymongo'` and never say how the SDK finds the PayMongo adapter.

## Decision

Applications pass provider definitions to the SDK:

```ts
new PaymentSDK({ providers: [paymongo(), xendit()], accounts: { ... } });
```

Account config types are inferred from the registered providers, so each account's credential
fields are type-checked against its provider, and account IDs are type-checked on every operation.

## Alternatives considered

- **SDK depends on every provider package.** Simplest call site, but makes all providers mandatory
  and breaks the dependency direction in the plan.
- **Dynamic `import()` by provider name.** Hides a dependency from bundlers and type checkers and
  turns a missing package into a runtime failure.
- **Global registry with side-effect imports.** Order-dependent and hostile to tree shaking and
  testing.

## Consequences

- One extra line at initialization compared with the plan's sketch.
- Unused providers are never installed, bundled, or loaded.
- Third parties can ship providers without changes to CulGate.
