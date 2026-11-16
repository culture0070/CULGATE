# API reference

Every public export, by package. Signatures and field-level documentation are in the published
type declarations, which your editor shows inline. Guides for each area are linked.

## `@culgate/sdk`

`@culgate/sdk` also re-exports everything from `@culgate/core`, so applications normally import
from `@culgate/sdk` only.

### `PaymentSDK`

```ts
new PaymentSDK({ providers, accounts, logger?, fetch?, webhooks? })
```

| Member             | Methods                                   | Guide                                                                                  |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `sdk.payments`     | `create`, `retrieve`, `cancel`, `capture` | [Payments](../guides/payments.md)                                                      |
| `sdk.refunds`      | `create`, `retrieve`                      | [Refunds](../guides/refunds.md)                                                        |
| `sdk.checkout`     | `create`, `retrieve`, `expire`            | [Checkout](../guides/checkout.md)                                                      |
| `sdk.webhooks`     | `on`, `verify`, `parse`, `handle`         | [Webhooks](../guides/webhooks.md)                                                      |
| `sdk.capabilities` | `supports`, `check`, `operations`         | [ADR 0012](../decisions/0012-capability-model.md)                                      |
| `sdk.accounts`     | `list`, `get`, `has`, `getClient`         | [Configuration](../guides/configuration.md), [Escape hatch](../guides/escape-hatch.md) |

Every method that reaches a provider takes `account` and returns a promise.

Options: `providers` (provider definitions), `accounts` (config per account ID), `logger`
(`{ debug?, warn? }`, receives non-sensitive HTTP diagnostics), `fetch` (custom fetch),
`webhooks` (`{ eventStore?, maxBodyBytes? }`).

### Other exports

| Export                                                                                                | Kind    | Purpose                                                |
| ----------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| `InMemoryWebhookEventStore`                                                                           | class   | Development-only `WebhookEventStore`                   |
| `PaymentsResource`, `RefundsResource`, `CheckoutResource`, `WebhooksResource`, `CapabilitiesResource` | classes | Types of the `sdk.*` members; not constructed directly |
| `PaymentSDKOptions`, `AccountsApi`, `ProviderClient`                                                  | types   | SDK configuration and account access                   |
| `PaymentCreateInput`, `PaymentRetrieveInput`, `PaymentCancelInput`, `PaymentCaptureInput`             | types   | Payment inputs                                         |
| `RefundCreateInput`, `RefundRetrieveInput`                                                            | types   | Refund inputs                                          |
| `CheckoutCreateInput`, `CheckoutRetrieveInput`                                                        | types   | Checkout inputs                                        |
| `WebhookInput`, `WebhookHandler`, `WebhookHandleResult`, `WebhookResponse`, `WebhookOptions`          | types   | Webhook handling                                       |
| `CapabilityQuery`                                                                                     | type    | Input to `sdk.capabilities`                            |

## `@culgate/core`

### Models

| Export                                                                                                                             | Purpose                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `Money`                                                                                                                            | `{ value, currency }` in minor units |
| `Payment`, `PaymentStatus`, `PAYMENT_STATUSES`, `PaymentMethodInfo`                                                                | Payments                             |
| `Refund`, `RefundStatus`, `REFUND_STATUSES`                                                                                        | Refunds                              |
| `CheckoutSession`, `CheckoutSessionStatus`, `CHECKOUT_SESSION_STATUSES`, `CheckoutLineItem`                                        | Checkout                             |
| `CulGateWebhookEvent`, `WebhookEventType`, `WEBHOOK_EVENT_TYPES`, `WebhookPaymentData`, `WebhookRefundData`, `WebhookCheckoutData` | Webhook events                       |
| `AccountInfo`, `Environment`, `ENVIRONMENTS`, `BaseAccountConfig`                                                                  | Accounts                             |

### Money

`assertValidMoney`, `toDecimalString`, `fromDecimal`, `getCurrencyExponent`,
`isSupportedCurrency`, `supportedCurrencies`. See [ADR 0011](../decisions/0011-money-in-minor-units.md).

### Errors

`PaymentSDKError`, `ConfigurationError`, `ValidationError`, `UnsupportedOperationError`,
`ProviderError`, `AuthenticationError`, `RateLimitError`, `PaymentNotFoundError`, `RefundError`,
`NetworkError`, `TimeoutError`, `WebhookVerificationError`; types `ValidationIssue`,
`PaymentSDKErrorOptions`, `ProviderErrorOptions`. See [Errors and retries](../guides/errors-and-retries.md).

### Capabilities

`Operation`, `OPERATIONS`, `isOperation`, `CapabilityContext`, `CapabilityResult`,
`ProviderCapabilities`, `createStaticCapabilities`, `StaticCapabilitiesOptions`.

### Webhooks

`WebhookEventStore`, `WebhookEventKey`, `WebhookRequest`, `WebhookHeaders`, `WebhookOperations`,
`ProviderWebhookEvent`, `isWebhookEventType`, `getWebhookHeader`, `webhookBodyBytes`,
`webhookBodyText`, `parseWebhookJson`.

### Configuration from the environment

`createEnvReader`, `defaultEnv`, `EnvSource`, `AccountEnvOptions`.

### For provider authors

These are the contracts a provider package implements. Applications do not need them.

| Export                                                                                                                                                       | Purpose                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| `ProviderDefinition`, `AnyProviderDefinition`, `AccountConfigOf`, `ProviderConfigContext`, `ProviderAdapterContext`                                          | Registering a provider     |
| `ProviderAdapter`, `PaymentOperations`, `RefundOperations`, `CheckoutOperations`, `ProviderRequestOperations`                                                | What an adapter implements |
| `ProviderPayment`, `ProviderRefund`, `ProviderCheckoutSession` and the `Provider*Input` types                                                                | Adapter inputs and results |
| `getOperationHandler`, `assertAdapterImplementsCapabilities`                                                                                                 | Contract helpers           |
| `ProviderRegistry`                                                                                                                                           | Registry used by the SDK   |
| `createHttpClient`, `HttpClient`, `HttpClientOptions`, `HttpRequest`, `HttpResponse`, `HttpMethod`, `RetryOptions`, `FetchLike`, `Logger`, `parseRetryAfter` | HTTP transport             |
| `createProviderRequest`, `ProviderRequestInput`, `ProviderResponse`                                                                                          | Escape hatch               |

## `@culgate/core/testing`

For tests and examples only.

| Export                                                                                                                | Purpose                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `mockProvider(options?)`                                                                                              | In-memory provider implementing every operation; adds `calls`, `callsFor`, `reset`, `setPaymentStatus`, `completeCheckout`, `signWebhook` |
| `assertProviderContract(provider, options)`                                                                           | Structural checks every provider must pass                                                                                                |
| `fingerprintSecret(secret)`                                                                                           | Fingerprint for asserting which credential was used                                                                                       |
| `MOCK_SIGNATURE_HEADER`                                                                                               | Header the mock signs webhooks with                                                                                                       |
| `MockProvider`, `MockAccountConfig`, `MockProviderOptions`, `MockCall`, `MockWebhookInput`, `ProviderContractOptions` | Types                                                                                                                                     |

## `@culgate/provider-paymongo`

| Export                                                                                                                                                                                           | Purpose                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `paymongo(options?)`                                                                                                                                                                             | The provider definition. Options: `baseUrl` (tests only), `webhooks.timestampToleranceSeconds` |
| `paymongoAccountFromEnv(options?)`                                                                                                                                                               | Account config from environment variables                                                      |
| `PayMongoAccountConfig`, `PayMongoProviderOptions`, `PayMongoWebhookOptions`, `PayMongoEnvOptions`                                                                                               | Types                                                                                          |
| `PAYMONGO_PROVIDER_NAME`, `PAYMONGO_API_BASE_URL`, `PAYMONGO_OPERATIONS`, `PAYMONGO_PAYMENT_METHODS`, `PAYMONGO_CHECKOUT_PAYMENT_METHODS`, `PAYMONGO_SIGNATURE_HEADER`, `REFERENCE_METADATA_KEY` | Constants                                                                                      |

Guide: [PayMongo](../providers/paymongo.md).

## `@culgate/provider-xendit`

| Export                                                                                                                                                                                | Purpose                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `xendit(options?)`                                                                                                                                                                    | The provider definition. Options: `baseUrl` (tests only) |
| `xenditAccountFromEnv(options?)`                                                                                                                                                      | Account config from environment variables                |
| `XenditAccountConfig`, `XenditProviderOptions`, `XenditEnvOptions`                                                                                                                    | Types                                                    |
| `XENDIT_PROVIDER_NAME`, `XENDIT_API_BASE_URL`, `XENDIT_API_VERSION`, `XENDIT_OPERATIONS`, `XENDIT_PAYMENT_METHODS`, `XENDIT_CHECKOUT_PAYMENT_METHODS`, `XENDIT_CALLBACK_TOKEN_HEADER` | Constants                                                |

Guide: [Xendit](../providers/xendit.md).

## `@culgate/express`

| Export                                                       | Purpose                                     |
| ------------------------------------------------------------ | ------------------------------------------- |
| `paymentWebhook(sdk, { account, maxBodyBytes?, onResult? })` | Express route handler for provider webhooks |
| `PaymentWebhookOptions`, `WebhookCapableSdk`                 | Types                                       |

Guide: [Express](../guides/express.md).

## `@culgate/nestjs`

| Export                                                                       | Purpose                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| `PaymentModule.forRoot(sdkOrOptions, { global? })`                           | Registers the SDK                             |
| `PaymentModule.forRootAsync({ imports?, inject?, useFactory, global? })`     | Registers the SDK from injected dependencies  |
| `PaymentSDK`                                                                 | Re-exported; also the injection token         |
| `CULGATE_SDK`, `InjectPaymentSDK()`                                          | Alternative injection token and decorator     |
| `PaymentWebhookService`                                                      | `handle(account, request)` for webhook routes |
| `PaymentModuleOptions`, `PaymentModuleAsyncOptions`, `RawBodyWebhookRequest` | Types                                         |

Guide: [NestJS](../guides/nestjs.md).
