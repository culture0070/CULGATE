# Security review

- **Date:** 2026-11-16
- **Scope:** all `@culgate/*` packages at their current state, before a first release.
- **Reviewer:** the implementer. This is a structured self-review, not an independent audit; an
  outside review is recommended before a `1.0.0` release.

## Result

No critical or high findings are open. The items under [Accepted risks](#accepted-risks) are known
limitations, most of them inherited from how the providers work, and each is documented where a
user would meet it.

## What was checked

| Area                                                   | Result                            | Evidence                                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials in logs, errors, serialization, inspection | No exposure found                 | SDK and per-provider tests assert keys, encoded keys, and webhook secrets are absent from `JSON.stringify`, `util.inspect`, results, and errors; `assertProviderContract` checks every adapter object |
| Credentials sent to another host                       | Not possible through the API      | One fixed HTTPS base URL per adapter; paths validated and compared after URL parsing; redirects refused; credentials applied after caller headers                                                     |
| Server-side request forgery through the escape hatch   | Not possible through the API      | Closed input shape; absolute URLs, `//host`, traversal (plain and percent-encoded), embedded queries, and control characters rejected before sending                                                  |
| Header injection                                       | Rejected                          | Header names and values validated; credential and connection headers refused                                                                                                                          |
| Webhook authenticity                                   | Verified before any parsing       | `verify` always precedes `normalize`; raw bytes required; constant-time comparison; test and live signatures are not interchangeable                                                                  |
| Webhook account confusion                              | Prevented                         | Account comes from the route, never the payload; a request signed for one account is rejected on another's route                                                                                      |
| Duplicate processing                                   | At most once per successful claim | Atomic claim interface; 20 concurrent deliveries process once in tests                                                                                                                                |
| Duplicate charges from retries                         | Prevented by default              | Writes are always sent once; neither provider was found to enforce idempotency keys                                                                                                                   |
| Misreporting payment state                             | Guarded                           | Unknown statuses map to `unknown`; only confirmed provider success maps to `succeeded`; a paid checkout requires a `paid` payment                                                                     |
| Money handling                                         | Exact                             | Integer minor units; string/`BigInt` conversion; excess precision rejected in both directions                                                                                                         |
| Wrong-account requests                                 | Prevented                         | Required, compile-time-checked account on every operation; one adapter per account from a frozen config copy                                                                                          |
| Input validation and prototype pollution               | Guarded                           | Inputs validated before any request; metadata copied with `__proto__`/`constructor`/`prototype` rejected; lookups use `Object.hasOwn` or `Map`                                                        |
| Path injection through resource IDs                    | Rejected                          | IDs must be plain tokens before being placed in a path                                                                                                                                                |
| Request body limits                                    | Enforced                          | 1 MiB default in the SDK and in the Express handler's own reader                                                                                                                                      |
| Dependencies                                           | Minimal                           | Core has none; providers depend on `zod` only; frameworks are peers                                                                                                                                   |
| Dependency audit                                       | Clean                             | `pnpm audit`: no known vulnerabilities in runtime or development dependencies (a `minimatch` advisory in the linter's dependencies was resolved by an override on 2026-11-17)                         |
| Published contents                                     | Build output only                 | The consumer test fails on anything but `dist/*.js`, `dist/*.d.ts`, `package.json`, `LICENSE`, `README.md`; no source maps, tests, or fixtures                                                        |

## Accepted risks

| #   | Risk                                                                                                                                                                                         | Severity                                | Why it is accepted / what to do                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | **Only PayMongo's payments, refunds, and checkout have run against a real test environment** (2026-11-16). Xendit and both providers' webhooks follow documentation that has gaps.           | High for a release, not a code defect   | Provider packages stay unpublished until verified.                                                                  |
| 2   | **Xendit webhooks are authenticated by a shared token, not a signature.** The body is not tamper-evident, and a leaked token allows forged events.                                           | Medium (provider design)                | Documented. Handlers should confirm with `retrieve` before fulfilling.                                              |
| 3   | **A Xendit live key cannot be told apart from a test key**, so an account marked `test` could move real money.                                                                               | Medium (provider design)                | Documented in the configuration and Xendit guides; `XENDIT_ENVIRONMENT` is required, never guessed.                 |
| 4   | **No working idempotency on either provider.** Xendit documents none; PayMongo's sandbox ignored its documented header. A blind retry after a timeout can create a second payment or refund. | Medium (provider behaviour)             | CulGate never retries writes; the idempotency guide describes reconciliation.                                       |
| 5   | **Webhook replay.** PayMongo's timestamp tolerance is off by default, and Xendit has no timestamp. A captured request can be replayed.                                                       | Low with an event store, medium without | Use a `WebhookEventStore`; enable the PayMongo tolerance once verified.                                             |
| 6   | **Provider error text can appear in error messages.** A provider's `detail` could echo part of a request.                                                                                    | Low                                     | Documented: log `code`/`providerCode`, do not show messages to customers.                                           |
| 7   | **`raw` payloads contain customer data.**                                                                                                                                                    | Low                                     | Documented in several guides: do not log them wholesale.                                                            |
| 8   | **Response bodies are not size-limited.** A provider could return a very large body.                                                                                                         | Low                                     | Requests go only to the provider's TLS host and have a timeout.                                                     |
| 9   | **`InMemoryWebhookEventStore` grows without bound and is per-process.**                                                                                                                      | Low                                     | Named and documented as development-only.                                                                           |
| 10  | **The `baseUrl` provider option sends credentials to the given URL.**                                                                                                                        | Low                                     | Code-level option for tests against a local mock server; documented as such. HTTPS is required except for loopback. |
| 11  | **CI actions are pinned by tag, not commit hash.**                                                                                                                                           | Low                                     | Pin to hashes when the repository is public and release automation is added.                                        |

## Not covered

- Penetration testing against a deployed application.
- The providers' own systems.
- Publishing pipeline security (provenance, npm 2FA): to be set up at release time.
