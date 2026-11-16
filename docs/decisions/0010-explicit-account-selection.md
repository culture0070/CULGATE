# ADR 0010: Every operation names its account

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

An application may hold several merchant accounts, including more than one at the same provider.
Using the wrong account moves money through the wrong merchant, or sends one merchant's request
with another's credentials.

## Decision

Every public operation takes a required `account`: an application-defined account ID. There is no
default account, no "current" account, and no automatic choice or rotation. A missing or unknown
account fails before anything else happens. The SDK, not the adapter, writes `accountId` and
`provider` onto everything returned. Account IDs are checked at compile time against the configured
accounts.

Each account gets its own adapter instance built from a frozen copy of its configuration, so
credentials cannot cross accounts or change after startup.

## Alternatives considered

- **A default account.** Convenient with one account, and a silent hazard the moment a second is
  added: calls written earlier would keep using the default.
- **Selecting by provider name.** Fails as soon as there are two accounts at one provider.
- **One SDK instance per account.** Explicit, but pushes multi-account bookkeeping onto every
  application and makes cross-account mistakes a matter of passing the wrong variable.
- **Automatic routing or failover.** Not a library's decision to make with someone's money.

## Consequences

- Slightly more to type on every call.
- Which merchant account handled a payment is always visible in the code and in the returned data.
- Applications must store the account ID with each payment ID.
