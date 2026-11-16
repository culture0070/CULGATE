# @culgate/nestjs

NestJS module for CulGate: registers one `PaymentSDK` for injection and provides
`PaymentWebhookService` for webhook routes.

```ts
@Module({
  imports: [PaymentModule.forRoot({ providers: [paymongo()], accounts: { ... } })],
})
export class AppModule {}
```

Create the application with `{ rawBody: true }` so webhooks can be verified. See
`docs/guides/nestjs.md` in the repository.

Peer dependencies: `@culgate/sdk`, `@nestjs/common` and `@nestjs/core` 10, 11, or 12. MIT licensed.
