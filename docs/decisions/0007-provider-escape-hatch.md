# ADR 0007: Provider escape hatch with a fixed destination

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

A unified API cannot cover every provider feature, and blocking access to the rest would push
applications to build a second, hand-rolled client holding the same credentials. But a generic
"send an authenticated request" function is a classic source of server-side request forgery and
credential leakage if the caller, or data the caller passes through, can influence where the
request goes.

## Decision

`sdk.accounts.getClient(account).providerRequest(input)` sends a request through the same HTTP
client the adapter uses, under these rules:

- The destination is the adapter's base URL. `input` has a closed set of fields; there is no way
  to supply a host or full URL, and unknown fields are rejected rather than ignored.
- `path` must be absolute and already normalized. The built URL is compared with the expected
  origin and path, so traversal, encoded traversal, and parser tricks fail closed.
- Redirects are refused.
- Credentials are applied after caller headers, and caller-supplied credential or
  connection-control headers are rejected outright.
- Header names and values are validated against injection.
- Only `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Only `GET` is retried.
- Responses are returned raw; errors use the provider's normal error mapping.
- It is a capability (`provider.request`) like any other operation.

## Alternatives considered

- **No escape hatch.** Safer in isolation, but moves the risk into application code that
  duplicates credentials and transport, without these protections.
- **Expose the adapter's HTTP client directly.** Leaks an internal type into the public API and
  lets callers opt writes into automatic retries.
- **Allow a per-call base URL from an allowlist.** More flexible, more to get wrong; a second
  provider host can be added to an adapter deliberately if one is ever needed.
- **Silently strip forbidden headers.** A stripped `Authorization` hides a caller's mistaken
  belief that they are using different credentials; rejecting makes it visible.

## Consequences

- Provider features outside the unified API are reachable with the account's credentials and
  without a second client.
- Calls made this way are provider-specific by construction and are labelled so in the API docs.
- Provider APIs on a different host than the adapter's base URL are not reachable.
