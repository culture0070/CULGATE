# Accounts, environment variables, and secrets

## Accounts

A CulGate account is one set of credentials at one provider, under a name you choose. Configure
as many as you need, including several on the same provider, and name the account on every call.

```ts
import { PaymentSDK } from '@culgate/sdk';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
import { xendit, xenditAccountFromEnv } from '@culgate/provider-xendit';

const sdk = new PaymentSDK({
  providers: [paymongo(), xendit()],
  accounts: {
    'paymongo-primary': paymongoAccountFromEnv(),
    'paymongo-secondary': paymongoAccountFromEnv({ prefix: 'PAYMONGO_SECONDARY' }),
    'xendit-primary': xenditAccountFromEnv(),
  },
});
```

- Account IDs are yours (1–64 letters, digits, `.`, `_`, `-`). They are not provider IDs.
- There is no default account. An operation without `account`, or with an unknown one, fails.
- Configuration is validated when the SDK is constructed; a bad account stops startup.
- Each account gets its own provider client. Credentials are copied at construction, so changing
  your config object afterwards has no effect.
- Store the account ID next to every payment ID you keep. Renaming an account in configuration
  does not move existing payments, and CulGate will not find them under the new name unless the
  credentials are the same.

`sdk.accounts.list()`, `get(id)` and `has(id)` return only `{ id, provider, environment }`.

## Explicit configuration

Every helper returns a plain object, and you can always write that object yourself:

```ts
accounts: {
  'paymongo-primary': {
    provider: 'paymongo',
    secretKey: mySecretManager.get('paymongo/secret-key'),
    webhookSecret: mySecretManager.get('paymongo/webhook-secret'),
    environment: 'live',
  },
}
```

| Field          | PayMongo                             | Xendit                         |
| -------------- | ------------------------------------ | ------------------------------ |
| `provider`     | `'paymongo'`                         | `'xendit'`                     |
| `secretKey`    | Required. `sk_test_…` or `sk_live_…` | Required                       |
| `environment`  | Required: `'test'` or `'live'`       | Required: `'test'` or `'live'` |
| webhook secret | `webhookSecret` (`whsk_…`), optional | `webhookToken`, optional       |
| `timeoutMs`    | Optional, default 30000              | Optional, default 30000        |

Credential fields differ per provider on purpose: a PayMongo webhook secret signs requests, while
a Xendit webhook token is a shared value, and one name for both would hide that.

**Test and live.** PayMongo keys carry their mode, so a key that does not match `environment` is
rejected at startup. Xendit keys do not, so CulGate cannot check them: `environment` is then only
your own label, and the key decides whether real money moves.

## Environment variables

`paymongoAccountFromEnv()` and `xenditAccountFromEnv()` read variables under a prefix.

| Variable (default prefix) | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `PAYMONGO_SECRET_KEY`     | Required                                                         |
| `PAYMONGO_WEBHOOK_SECRET` | Optional; enables webhooks                                       |
| `PAYMONGO_ENVIRONMENT`    | `test` or `live`. Optional: inferred from the key when unset     |
| `PAYMONGO_TIMEOUT_MS`     | Optional                                                         |
| `XENDIT_SECRET_KEY`       | Required                                                         |
| `XENDIT_ENVIRONMENT`      | **Required**: `test` or `live` (cannot be inferred from the key) |
| `XENDIT_WEBHOOK_TOKEN`    | Optional; enables webhooks                                       |
| `XENDIT_TIMEOUT_MS`       | Optional                                                         |

- **More accounts:** pass `prefix`. `{ prefix: 'PAYMONGO_SECONDARY' }` reads
  `PAYMONGO_SECONDARY_SECRET_KEY`, and so on.
- **Explicit values win:** `paymongoAccountFromEnv({ overrides: { environment: 'live' } })`.
- **Another source:** pass `env` (any object of strings) instead of `process.env`.
- **Errors name the variable**, for example
  `Environment variable "XENDIT_ENVIRONMENT" is required but not set.`, and never include a value.

CulGate does not load `.env` files, has no `dotenv` dependency, and never writes to
`process.env`. Load `.env` yourself if you use one (for example `node --env-file=.env app.js`), or
inject variables from your deployment's secret manager.

## Keeping secrets secret

What CulGate does:

- Keeps credentials out of everything it returns, logs, or throws: `JSON.stringify(sdk)`,
  `util.inspect(sdk)`, account listings, results, and error messages contain no key, token, or
  `Authorization` header. This is covered by tests for the SDK and each provider.
- Passes its optional `logger` only method, path, status, timing, and request IDs.
- Sends credentials only to the provider's fixed HTTPS host and refuses redirects.

What remains yours:

- Use secret keys on the server only. Never ship them to a browser or mobile app.
- Keep keys out of source control; commit an `.env.example` without values instead.
- `payment.raw` and webhook `event.raw` are the provider's full payloads and can contain customer
  details. Do not log them wholesale.
- Rotate a key at the provider if it may have leaked, then restart with the new value.
- CulGate does not collect or store card data and is not itself PCI-certified. Using compliant
  providers does not make your application compliant by itself.
