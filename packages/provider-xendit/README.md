# @culgate/provider-xendit

Xendit provider for CulGate (Payments API v3): e-wallet payments (GCash, ShopeePay), hosted
checkout through Payment Sessions, refunds, and webhooks.

```ts
import { PaymentSDK } from '@culgate/sdk';
import { xendit, xenditAccountFromEnv } from '@culgate/provider-xendit';

const sdk = new PaymentSDK({
  providers: [xendit()],
  accounts: { 'xendit-primary': xenditAccountFromEnv() }, // XENDIT_SECRET_KEY, XENDIT_ENVIRONMENT
});
```

Pre-release: implemented from Xendit's documentation and not yet verified against Xendit test
mode. Xendit has no idempotency for payments or refunds and authenticates webhooks with a shared
token; see the provider guide in the repository's `docs/providers/xendit.md`.

Server-side only. Requires Node.js 22.12 or newer. MIT licensed.
