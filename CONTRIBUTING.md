# Contributing

## Setup

Requires Node.js 22.12 or newer and pnpm.

```bash
pnpm install
pnpm check   # format check, lint, build, typecheck, tests
```

Other commands: `pnpm format` (apply formatting), `pnpm test`, `pnpm build`,
`pnpm test:consumer` (install the packed packages into a clean project and use them).

## Layout

| Path                                  | Contents                                                          |
| ------------------------------------- | ----------------------------------------------------------------- |
| `packages/core`                       | Provider-neutral contracts, models, money, errors, HTTP transport |
| `packages/sdk`                        | `PaymentSDK` and its resources                                    |
| `packages/provider-*`                 | One adapter per provider                                          |
| `packages/express`, `packages/nestjs` | Thin framework integrations                                       |
| `examples/`                           | Runnable examples                                                 |
| `docs/`                               | Guides, provider research, architecture decisions                 |

Dependency direction is enforced by lint: core imports nothing from CulGate; providers import only
core; the SDK imports only core; framework packages import only the SDK.

## Rules for changes

- **Tests come with the change.** Provider tests use payloads shaped like the provider's
  documentation, not values copied from the implementation.
- **Do not invent provider behaviour.** Read the provider's current official documentation, record
  the source and date in `docs/providers/`, and list anything unverified under "Open questions".
- **Never claim support that is not implemented and tested.** An operation a provider cannot do is
  left out of its capabilities, so the SDK raises `UnsupportedOperationError`.
- **Unknown stays unknown.** Unrecognized provider statuses map to `unknown` and unrecognized
  events to `provider.unknown`, with the original value preserved.
- **No secrets anywhere.** No credentials in logs, errors, snapshots, or fixtures. Use obviously
  fake keys in tests.
- **Money is integer minor units.** No floating-point arithmetic on amounts.
- Record significant design decisions as an ADR in `docs/decisions/`.
- Add a changeset (`pnpm changeset`) for any change users will notice.

## Sandbox tests

Tests against real provider test environments are skipped unless credentials are supplied; see the
"Open questions" section of each provider guide for the commands. Never commit credentials.
