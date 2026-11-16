import type {
  AnyProviderDefinition,
  PaymentSDKOptions,
  WebhookHandleResult,
  WebhookHeaders,
} from '@culgate/sdk';
import { ConfigurationError, PaymentSDK } from '@culgate/sdk';
import type { DynamicModule, InjectionToken, ModuleMetadata, Provider } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';

/**
 * Alternative injection token for the SDK. The `PaymentSDK` class itself is
 * also registered as a token, so `constructor(private sdk: PaymentSDK)` works
 * when decorator metadata is enabled.
 */
export const CULGATE_SDK = 'CULGATE_PAYMENT_SDK';

/** Parameter decorator: `constructor(@InjectPaymentSDK() private sdk: PaymentSDK)`. */
export const InjectPaymentSDK = (): ParameterDecorator & PropertyDecorator => Inject(CULGATE_SDK);

type SdkSource = PaymentSDK | PaymentSDKOptions<string, readonly AnyProviderDefinition[]>;

export interface PaymentModuleOptions {
  /** Register globally so feature modules need not import it. Default `true`. */
  global?: boolean;
}

export interface PaymentModuleAsyncOptions extends PaymentModuleOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  /** Returns SDK options (or a ready `PaymentSDK`), e.g. built from `ConfigService`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- arguments are whatever `inject` lists
  useFactory: (...args: any[]) => SdkSource | Promise<SdkSource>;
}

/** The request fields {@link PaymentWebhookService} needs. */
export interface RawBodyWebhookRequest {
  /** Set by NestJS when the app is created with `{ rawBody: true }`. */
  rawBody?: Buffer | string | undefined;
  headers: WebhookHeaders;
}

/**
 * Runs a webhook request through `sdk.webhooks.handle()`.
 *
 * ```ts
 * @Post('paymongo-primary')
 * async receive(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
 *   const result = await this.webhooks.handle('paymongo-primary', req);
 *   res.status(result.response.status).json(result.response.body);
 * }
 * ```
 */
export class PaymentWebhookService {
  readonly #sdk: PaymentSDK;

  constructor(sdk: PaymentSDK) {
    this.#sdk = sdk;
  }

  /**
   * @param account The CulGate account this route belongs to. Use one route
   *   per account; never take the account from the request.
   */
  handle(account: string, request: RawBodyWebhookRequest): Promise<WebhookHandleResult> {
    const { rawBody } = request;
    if (rawBody === undefined || rawBody === null) {
      throw new ConfigurationError(
        'The raw webhook body is not available. Create the application with ' +
          'NestFactory.create(AppModule, { rawBody: true }) and pass the request object.',
        { code: 'raw_body_unavailable' },
      );
    }
    return this.#sdk.webhooks.handle({ account, rawBody, headers: request.headers });
  }
}

const toSdk = (source: SdkSource): PaymentSDK =>
  source instanceof PaymentSDK ? source : new PaymentSDK(source);

function buildModule(
  sdkProvider: Provider,
  options: PaymentModuleOptions,
  extra: Partial<DynamicModule> = {},
): DynamicModule {
  return {
    module: PaymentModule,
    global: options.global ?? true,
    ...extra,
    providers: [
      sdkProvider,
      { provide: CULGATE_SDK, useExisting: PaymentSDK },
      {
        provide: PaymentWebhookService,
        useFactory: (sdk: PaymentSDK) => new PaymentWebhookService(sdk),
        inject: [PaymentSDK],
      },
    ],
    exports: [PaymentSDK, CULGATE_SDK, PaymentWebhookService],
  };
}

/**
 * Registers one `PaymentSDK` for the application.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     PaymentModule.forRoot({ providers: [paymongo()], accounts: { ... } }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
export class PaymentModule {
  static forRoot<
    TAccountId extends string,
    const TProviders extends readonly AnyProviderDefinition[],
  >(
    sdk: PaymentSDK | PaymentSDKOptions<TAccountId, TProviders>,
    options: PaymentModuleOptions = {},
  ): DynamicModule {
    // Constructed eagerly so configuration errors surface at startup.
    const instance = toSdk(sdk as SdkSource);
    return buildModule({ provide: PaymentSDK, useValue: instance }, options);
  }

  static forRootAsync(options: PaymentModuleAsyncOptions): DynamicModule {
    return buildModule(
      {
        provide: PaymentSDK,
        useFactory: async (...args: unknown[]) => toSdk(await options.useFactory(...args)),
        inject: options.inject ?? [],
      },
      options,
      { imports: options.imports ?? [] },
    );
  }
}

// Applied as a function so this package compiles without decorator settings.
Module({})(PaymentModule);

export { PaymentSDK } from '@culgate/sdk';
