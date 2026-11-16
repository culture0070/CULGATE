# Examples

Each example runs without provider credentials, using CulGate's in-memory mock provider. The
comments show the two lines to change to use PayMongo or Xendit instead.

| Example              | Shows                                                         | Run                                   |
| -------------------- | ------------------------------------------------------------- | ------------------------------------- |
| [`node`](node)       | Payments, refunds, checkout, capabilities, errors             | `pnpm --filter example-node start`    |
| [`express`](express) | A payment route and webhook routes with raw-body verification | `pnpm --filter example-express start` |
| [`nestjs`](nestjs)   | `PaymentModule`, an injected SDK, and a webhook controller    | `pnpm --filter example-nestjs start`  |

Run `pnpm install && pnpm build` at the repository root first. Each example also has a `demo`
script that exercises it end to end and exits, which CI runs as a smoke test.
