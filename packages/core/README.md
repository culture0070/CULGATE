# @culgate/core

Provider-neutral contracts for CulGate: models, money utilities, the error
hierarchy, the capability model, the provider adapter contract, and the HTTP transport.

Applications normally install `@culgate/sdk`, which re-exports this package. Install
`@culgate/core` directly only to write a provider adapter.

`@culgate/core/testing` provides an in-memory mock provider and the provider contract checker, for
tests and examples.

No runtime dependencies. Requires Node.js 22.12 or newer. MIT licensed.
