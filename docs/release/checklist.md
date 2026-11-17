# Release checklist

Status of the definition of done for the first public release, as of 2026-11-17.

**Verified** means covered by an automated check that passes. **Documented** means written down
but dependent on something outside this repository.

## Done

| Requirement                                                           | Evidence                                                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo builds from a clean checkout                                 | `pnpm check`                                                                                                                                                     |
| All packages have correct metadata and exports                        | `pnpm test:consumer` installs the packed tarballs and uses them from ESM, CommonJS, and TypeScript                                                               |
| Core has no provider or framework dependencies                        | Lint boundary rules; consumer test asserts core has no dependencies                                                                                              |
| Multiple accounts per provider work                                   | SDK tests                                                                                                                                                        |
| Every operation requires explicit account selection                   | SDK tests, including compile-time checks                                                                                                                         |
| Capability matrix is accurate and documented                          | Per-adapter capability tests; [compatibility matrix](../providers/compatibility.md)                                                                              |
| Payment and refund mappings preserve unknown states                   | Status-mapping tests in both adapters                                                                                                                            |
| Money conversion is safe for supported currency exponents             | Core money tests; Xendit round-trip tests                                                                                                                        |
| Raw request body is preserved in framework examples                   | Express and NestJS tests and examples run against real HTTP servers                                                                                              |
| Webhook normalization preserves original event type and raw payload   | Adapter webhook tests                                                                                                                                            |
| Duplicate and out-of-order webhook behaviour is documented and tested | SDK webhook tests; [webhook guide](../guides/webhooks.md)                                                                                                        |
| Atomic event-store integration is available                           | `WebhookEventStore`; concurrency test                                                                                                                            |
| No exactly-once guarantee is claimed                                  | Webhook guide, ADR 0006                                                                                                                                          |
| Idempotency behaviour is documented per provider and operation        | [Idempotency guide](../guides/idempotency.md)                                                                                                                    |
| Unsafe payment retries are prevented                                  | Transport and adapter retry tests                                                                                                                                |
| Account credentials are isolated and redacted                         | SDK and adapter redaction tests; provider contract checker                                                                                                       |
| Provider escape hatch is restricted against arbitrary URL access      | Escape-hatch tests; ADR 0007                                                                                                                                     |
| NestJS integration works                                              | NestJS package tests and example                                                                                                                                 |
| Express integration works                                             | Express package tests and example                                                                                                                                |
| Plain Node.js example works                                           | `examples/node`, run in CI                                                                                                                                       |
| Clean consumer installation from packed packages works                | `pnpm test:consumer`                                                                                                                                             |
| PayMongo payments, refunds, and checkout verified against its sandbox | Sandbox suite (9 tests) plus a manual paid-payment and refund run, 2026-11-16; results in the [PayMongo guide](../providers/paymongo.md#verified-in-the-sandbox) |
| Dependency review                                                     | `pnpm audit` clean for runtime and development dependencies                                                                                                      |
| Security review                                                       | [Self-review](security-review.md); no critical or high findings open                                                                                             |
| Documentation matches the implementation                              | Guides written against the code; examples and README flows executed                                                                                              |

## Not done: needs provider test credentials

These cannot be completed from this repository alone.

| Requirement                                            | What is needed                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PayMongo webhooks verified                             | One real test-mode delivery to a running endpoint, to confirm the signature encoding and the checkout event envelope. Payments, refunds, and checkout were verified on 2026-11-16     |
| Xendit adapter verified against test mode              | Run the sandbox suite with a Xendit **test** secret key, and resolve the open questions in the [Xendit guide](../providers/xendit.md)                                                 |
| Webhook verification confirmed against real deliveries | One real test-mode webhook from each provider to a running endpoint (the Express example works for this). Confirms PayMongo's signature encoding and Xendit's token on session events |

```bash
PAYMONGO_TEST_SECRET_KEY=sk_test_... pnpm --filter @culgate/provider-paymongo test
```

```bash
XENDIT_TEST_SECRET_KEY=... XENDIT_SANDBOX_CONFIRM_TEST_MODE=yes pnpm --filter @culgate/provider-xendit test
```

Until these pass, the provider and framework packages keep `"private": true` and the README
describes the adapters as unverified.

## Not done: release mechanics

Each of these needs a decision or an account, and none has been started.

| Step                                                                            | Notes                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Create the Git remote and push                                                  | The repository has no remote and no commits yet                                          |
| Confirm the `@culgate` npm scope is available and claim it                      | Not checked                                                                              |
| Add `repository`, `homepage`, and `bugs` to each `package.json`                 | Needs the repository URL                                                                 |
| Add a security contact                                                          | `SECURITY.md` points to private vulnerability reporting on the repository                |
| Remove `"private": true` from the packages to be published                      | After sandbox verification                                                               |
| `pnpm changeset version`, review the changelogs                                 | An initial changeset exists for `core` and `sdk`; add the others when they become public |
| Configure npm publishing with provenance and 2FA                                | Publish in dependency order: core, sdk, providers, frameworks                            |
| Verify installation from npm in a clean project, tag, and publish release notes |                                                                                          |
| Independent security review                                                     | Recommended before `1.0.0`                                                               |

## Deliberately out of scope for the first release

- Customers, invoices, and payouts. No provider-neutral contracts exist for them; use the
  [escape hatch](../guides/escape-hatch.md).
- Listing payments or refunds.
- `payments.capture` on PayMongo and Xendit (cards-only at both providers).
- Direct card payments (cards go through hosted checkout).
- Currencies other than PHP, and countries other than the Philippines.
- A Python SDK.
