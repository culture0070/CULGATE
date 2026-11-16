# Payment lifecycle

## Create

```ts
const payment = await sdk.payments.create({
  account: 'paymongo-primary',
  amount: { value: 150000, currency: 'PHP' }, // PHP 1,500.00 in centavos
  paymentMethod: { type: 'gcash' },
  reference: 'ORDER-123',
  description: 'Order payment',
  returnUrls: { success: 'https://example.com/return', cancel: 'https://example.com/cart' },
  idempotencyKey: 'order-123-payment',
});

if (payment.status === 'requires_action') redirect(payment.checkoutUrl!);
```

Amounts are integers in the currency's minor unit. `payments.create` is for a payment method you
have already chosen; to let the customer choose on the provider's page (including cards), use
[hosted checkout](checkout.md).

Store three things: the **account ID**, `payment.id`, and your own order reference. A payment ID
means nothing without the account it belongs to.

## Statuses

| Status                           | Meaning                                                                       | Is it paid?   |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------- |
| `pending`                        | Created; nothing has happened yet, or an attempt failed and it can be retried | No            |
| `requires_action`                | The customer must do something, usually follow `checkoutUrl`                  | No            |
| `processing`                     | The provider is working on it                                                 | No            |
| `authorized`                     | Funds are reserved but not captured                                           | **No**        |
| `succeeded`                      | The provider confirmed the payment                                            | **Yes**       |
| `failed`                         | This payment will not succeed                                                 | No            |
| `cancelled`                      | Cancelled before completion                                                   | No            |
| `expired`                        | The time to pay ran out                                                       | No            |
| `partially_refunded`, `refunded` | Refund state, where a provider reports it on the payment                      | Was paid      |
| `unknown`                        | A provider status CulGate does not recognize                                  | Do not assume |

**Only `succeeded` means paid.** Never treat `pending`, `processing`, or `authorized` as success,
and never treat `unknown` as either success or failure: read `payment.providerStatus`, which always
holds the provider's own value, and decide deliberately.

Providers do not report every status. PayMongo never reports `failed` or `expired` for a payment
(a failed attempt goes back to `pending`), and neither provider currently reports the refund
statuses on the payment. See the [compatibility matrix](../providers/compatibility.md).

## Knowing when it is paid

1. **Webhook** (recommended): handle `payment.succeeded`, then retrieve the payment and act on its
   current status. See the [webhook guide](webhooks.md).
2. **Retrieve**: `sdk.payments.retrieve({ account, paymentId })` returns the provider's current
   view. Use it when the customer returns to your site, and as a fallback when a webhook is late.

The customer arriving at your `success` return URL proves nothing. Anyone can open that URL.

## Cancel and capture

```ts
await sdk.payments.cancel({ account, paymentId });
await sdk.payments.capture({ account, paymentId, amount }); // where supported
```

Which states can be cancelled is the provider's decision; a refusal is a `ProviderError` with the
provider's code. Capture is not supported by either current provider adapter and throws
`UnsupportedOperationError`.

## What you get back

```ts
payment.id; // pass back to CulGate
payment.accountId; // which of your accounts owns it
payment.provider; // 'paymongo' | 'xendit' | ...
payment.status; // normalized
payment.providerStatus; // the provider's own word for it
payment.checkoutUrl; // where the customer goes, when applicable
payment.paymentMethod; // { type: 'gcash', providerType: 'GCASH' }
payment.raw; // the provider's full response
```

`raw` can contain customer details. Do not log it wholesale.

## Switching providers

For an operation and payment method both providers support, changing provider means changing the
`account` value and nothing else. What is not identical is listed in the
[compatibility matrix](../providers/compatibility.md); check with
`sdk.capabilities.supports({ account, operation, currency, paymentMethod })` instead of assuming.
