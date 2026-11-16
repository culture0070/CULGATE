# @culgate/provider-paymongo

PayMongo provider for CulGate: e-wallet payments (GCash, Maya, GrabPay, ShopeePay, BillEase),
hosted checkout (cards and e-wallets), refunds, and webhooks.

```ts
import { PaymentSDK } from '@culgate/sdk';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';

const sdk = new PaymentSDK({
  providers: [paymongo()],
  accounts: { 'paymongo-primary': paymongoAccountFromEnv() }, // PAYMONGO_SECRET_KEY
});
```

Pre-release. Payments, refunds, and checkout were verified against PayMongo's test environment on
2026-11-16; webhook verification has not yet been confirmed against a real delivery. See the
provider guide in the repository's `docs/providers/paymongo.md` for what is
supported, how concepts map, and open questions.

Server-side only. Requires Node.js 22.12 or newer. MIT licensed.
