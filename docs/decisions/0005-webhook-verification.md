# ADR 0005: Webhook verification on raw bytes, bound to an explicit account

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

Webhook endpoints are public. Signatures are computed over the exact bytes sent, and each merchant
account has its own signing secret. Frameworks commonly parse JSON before application code runs,
which destroys the original bytes.

## Decision

- Webhook APIs take `{ account, rawBody, headers }`. `rawBody` must be a string or bytes; a parsed
  object is rejected with a specific error rather than re-serialized.
- The account is chosen by the application from the route, never from the payload. The request is
  verified with that account's secret only.
- The adapter contract separates `verify` from `normalize`, and the SDK never calls `normalize`
  (or parses the body at all) before `verify` succeeds.
- Verification failures raise `WebhookVerificationError` with a machine-readable `code`. The
  managed `handle()` converts them into a response instead of throwing.
- Webhook support is a per-account capability: an account without a webhook secret reports
  `webhooks.verify` as unsupported.
- Signature comparison is constant-time.
- Timestamp-tolerance checks are provider-specific and opt-in where the provider does not document
  retry timestamps (see the PayMongo guide).

## Alternatives considered

- **Resolve the account by trying every configured secret.** Convenient with one URL, but it turns
  one secret's compromise into the ability to post events to any account and hides
  misconfiguration.
- **Accept parsed bodies and re-serialize.** Works only by accident of key order and whitespace.
- **`verify()` returning a boolean.** Loses the reason, and a forgotten `if` silently accepts
  forged events; throwing fails closed.

## Consequences

- Applications must configure raw-body access per framework; the guides show how.
- One webhook URL per account.
