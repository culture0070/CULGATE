# ADR 0011: Money is an integer count of minor units

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

Binary floating point cannot represent most decimal amounts exactly (`0.29 * 100` is
`28.999999999999996`). Providers disagree on representation: PayMongo uses integer centavos, Xendit
uses decimal numbers in major units.

## Decision

`Money` is `{ value, currency }`, where `value` is a non-negative safe integer in the currency's
ISO 4217 minor unit (PHP 1,500.00 is `150000`) and `currency` is an ISO 4217 code CulGate knows
the exponent of. Validation rejects floats, strings, and unsafe integers; nothing is coerced.

Conversion to and from a provider's representation happens in that provider's adapter, using
string and `BigInt` arithmetic. An amount with more decimal places than its currency allows is
rejected, never rounded. An adapter that sends decimal numbers verifies the round trip.

## Alternatives considered

- **Decimal numbers in major units.** Familiar, and wrong in the ways described above.
- **Decimal strings.** Exact, but every comparison and sum needs a decimal library.
- **`bigint`.** Exact and unbounded, but does not serialize to JSON and is awkward in application
  code; safe integers cover amounts far beyond any real payment.
- **A decimal library type.** A dependency in every signature for no gain over integers.

## Consequences

- Amounts are exact, comparable, and summable with ordinary integer arithmetic.
- Callers must convert display amounts to minor units, and must not assume two decimal places:
  JPY and VND have none.
- A currency must be added to CulGate's table before it can be used.
- Where a provider treats a currency differently from ISO 4217, its adapter must handle that.
