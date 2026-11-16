# Idempotency and reconciliation

An idempotency key is meant to let you repeat a request safely: the provider recognizes the key
and returns the original result instead of doing the work twice.

**Neither provider CulGate supports gives you that guarantee today.** Xendit documents no
idempotency mechanism for these APIs. PayMongo documents an `Idempotency-Key` header, but in its
test environment on 2026-11-16 the same key and body created two payment intents, two checkout
sessions, and two refunds. CulGate therefore treats every create as unprotected.

## What happens to your key

| Operation         | PayMongo                                                | Xendit                                           |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `payments.create` | Sent as `Idempotency-Key`; **not enforced** when tested | Not sent; **not enforced**                       |
| `refunds.create`  | Sent as `Idempotency-Key`; **not enforced** when tested | Used as the refund's reference; **not enforced** |
| `checkout.create` | Sent as `Idempotency-Key`; **not enforced** when tested | Not sent; **not enforced**                       |

"Not enforced" means calling twice creates two payments, refunds, or sessions.

Passing `idempotencyKey` is still worthwhile: on PayMongo the header is sent as documented, so you
benefit if PayMongo enforces it in live mode or starts to, and on Xendit it labels the refund.
But do not build retries on it.

## What CulGate does about it

- **Creates and refunds are sent exactly once.** CulGate never retries them, on any provider, even
  after a timeout.
- Reads (`retrieve`) are retried, since repeating them is harmless.

## Reconciling an unknown outcome

A timeout or connection failure during a create leaves you not knowing whether it happened.
Creating again blindly can charge or refund a customer twice. Find out first.

1. **Always send a `reference`** that identifies the order.
2. After an unknown outcome, look for the payment before trying again:
   - **PayMongo:** if `payments.create` failed partway, the error's `details.paymentIntentId` names
     the payment intent that was created; retrieve or cancel it. Otherwise check the PayMongo
     dashboard for your reference (stored on the payment intent's metadata as `culgate_reference`).
   - **Xendit:** look the payment up by `reference_id` in the Xendit dashboard, or wait for the
     webhook, which carries it in `event.raw`.
3. Create again only once you have established that the first attempt did not go through, or after
   cancelling the original.

For refunds, retrieve the payment and its refunds from the provider (or your own records) before
issuing a second one. A duplicate partial refund is real money.

For anything involving money, also run a periodic reconciliation: compare your orders in a
non-final state against `sdk.payments.retrieve` for each. Webhooks can be delayed, delivered out
of order, or missed while your endpoint is down; the provider's current state is the authority.

## An unpaid duplicate is cheap; a paid one is not

A duplicate payment intent, payment request, or checkout session that nobody pays costs nothing:
cancel or expire it. The danger is giving the customer two live payment links for one order. Keep
one current payment per order in your own records, and cancel the old one before creating another.

## Webhooks are a separate problem

Idempotency keys concern requests you send. Deliveries you receive need their own protection: see
deduplication in the [webhook guide](webhooks.md).
