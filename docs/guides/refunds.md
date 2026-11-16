# Refunds

```ts
// Full refund
const refund = await sdk.refunds.create({ account, paymentId });

// Partial refund
const partial = await sdk.refunds.create({
  account,
  paymentId,
  amount: { value: 50000, currency: 'PHP' },
  reason: 'requested_by_customer',
  idempotencyKey: 'order-123-refund-1',
});

const current = await sdk.refunds.retrieve({ account, refundId: refund.id });
```

- `account` must be the account that took the payment.
- `paymentId` is the CulGate payment ID (`payment.id`, or `session.paymentId` for a checkout).
- Omit `amount` for a full refund.
- Several partial refunds are allowed up to the amount paid; the provider enforces the limit.

## Statuses

| Status       | Meaning                                      |
| ------------ | -------------------------------------------- |
| `pending`    | Accepted by the provider, not finished       |
| `processing` | In progress                                  |
| `succeeded`  | The provider completed the refund            |
| `failed`     | The refund did not go through                |
| `cancelled`  | Withdrawn                                    |
| `unknown`    | A provider status CulGate does not recognize |

**A created refund is usually `pending`.** Do not tell a customer their money is back until the
refund is `succeeded`. Follow it with the `refund.succeeded` / `refund.failed` webhooks or by
retrieving it. Even then, `succeeded` means the provider and its partners processed the refund;
the money can take days to appear on the customer's side, depending on the payment method.

## Reasons

Both providers require a reason code. Pass one of the codes below and it is sent as-is; pass any
other text and CulGate sends the provider's generic code and keeps your text.

| You pass                                           | PayMongo                  | Xendit                         |
| -------------------------------------------------- | ------------------------- | ------------------------------ |
| `duplicate`, `fraudulent`, `requested_by_customer` | Sent as the code          | Sent as the code (upper-cased) |
| `cancellation`                                     | `others`, text in `notes` | `CANCELLATION`                 |
| any other text                                     | `others`, text in `notes` | `OTHERS`, text in metadata     |
| nothing                                            | `others`                  | `OTHERS`                       |

## Errors

A provider's refusal is a `RefundError` carrying the provider's code in `providerCode`, for example
an amount above the refundable balance, a payment method that cannot be refunded, or an expired
refund window. `code: 'payment_not_refundable'` means CulGate found no completed payment to refund;
`code: 'refund_not_found'` means the refund ID is unknown to that account.

## Provider differences

- **Idempotency.** Neither provider prevents a duplicate refund. PayMongo's test environment
  issued two refunds for one key, and Xendit only records the key as the refund's reference.
  Never repeat a refund call without first checking whether the first one went through.
- **Full refund after a partial one.** Omitting `amount` refunds what is still refundable on both
  providers. PayMongo requires an explicit amount, so CulGate computes it from the payment's
  existing refunds; Xendit computes it itself.
- **Refund windows and partial-refund support** vary by payment method; see the provider guides.
