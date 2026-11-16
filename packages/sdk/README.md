# @culgate/sdk

One interface. Multiple payment gateways.

`PaymentSDK` gives an application one typed API for payments, refunds, hosted checkout, and
webhooks across payment providers. Every call names the merchant account to use.

```ts
import { PaymentSDK } from '@culgate/sdk';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';

const sdk = new PaymentSDK({
  providers: [paymongo()],
  accounts: { 'paymongo-primary': paymongoAccountFromEnv() },
});

const payment = await sdk.payments.create({
  account: 'paymongo-primary',
  amount: { value: 150000, currency: 'PHP' },
  paymentMethod: { type: 'gcash' },
  returnUrls: { success: 'https://example.com/return' },
});
```

Install a provider package alongside it: `@culgate/provider-paymongo` or
`@culgate/provider-xendit`. Server-side only. Requires Node.js 22.12 or newer. MIT licensed.

Documentation is in the repository's `docs/` folder.
