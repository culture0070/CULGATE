import type {
  CulGateWebhookEvent,
  Logger,
  WebhookEventStore,
  WebhookEventType,
  WebhookHeaders,
  WebhookOperations,
  WebhookRequest,
} from '@culgate/core';
import {
  isWebhookEventType,
  PaymentSDKError,
  UnsupportedOperationError,
  webhookBodyBytes,
  WebhookVerificationError,
} from '@culgate/core';
import type { AccountManager, ResolvedAccount } from '../account-manager.js';
import { assertInputObject } from '../validation.js';

export interface WebhookInput<TAccountId extends string = string> {
  /**
   * The account this endpoint belongs to. Bind each webhook URL to one
   * account; never take the account from the request body.
   */
  account: TAccountId;
  /** The request body exactly as received (string or bytes), before any JSON parsing. */
  rawBody: string | Uint8Array;
  headers: WebhookHeaders;
}

export type WebhookHandler = (event: CulGateWebhookEvent) => void | Promise<void>;

/** What to send back to the provider. */
export interface WebhookResponse {
  status: number;
  /** Send as JSON. Some providers require a JSON body to count a delivery as successful. */
  body: Record<string, unknown>;
}

export type WebhookHandleResult =
  /** Verified and every handler completed. */
  | { status: 'processed'; event: CulGateWebhookEvent; response: WebhookResponse }
  /** Verified, but the event store reports it is already processed or in progress. */
  | { status: 'duplicate'; event: CulGateWebhookEvent; response: WebhookResponse }
  /** Not authentic or not parseable. Handlers did not run. */
  | { status: 'rejected'; error: WebhookVerificationError; response: WebhookResponse }
  /** Verified, but a handler threw. The response asks the provider to retry. */
  | { status: 'failed'; event: CulGateWebhookEvent; error: unknown; response: WebhookResponse };

export interface WebhookOptions {
  /** Enables deduplication of events that carry a provider event ID. */
  eventStore?: WebhookEventStore;
  /** Bodies larger than this are rejected before verification. Default 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const ACKNOWLEDGED: WebhookResponse = Object.freeze({ status: 200, body: { received: true } });
const REJECTION_STATUS: Readonly<Record<string, number>> = {
  payload_too_large: 413,
  invalid_payload: 400,
  raw_body_required: 400,
};

export class WebhooksResource<TAccountId extends string = string> {
  readonly #accounts: AccountManager;
  readonly #handlers = new Map<string, Set<WebhookHandler>>();
  readonly #eventStore: WebhookEventStore | undefined;
  readonly #maxBodyBytes: number;
  readonly #logger: Logger | undefined;

  /** @internal */
  constructor(accounts: AccountManager, options: WebhookOptions = {}, logger?: Logger) {
    this.#accounts = accounts;
    this.#eventStore = options.eventStore;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#logger = logger;
  }

  /**
   * Registers a handler for one event type, or `'*'` for every event
   * (including `provider.unknown`). Returns a function that removes it.
   * Handlers must be idempotent: events can be delivered more than once.
   */
  on(type: WebhookEventType | '*', handler: WebhookHandler): () => void {
    const handlers = this.#handlers.get(type) ?? new Set();
    this.#handlers.set(type, handlers);
    handlers.add(handler);
    return () => void handlers.delete(handler);
  }

  /** Authenticates a request. Throws `WebhookVerificationError` if it is not authentic. */
  async verify(input: WebhookInput<TAccountId>): Promise<void> {
    const { account, webhooks, request } = this.#prepare(input);
    await guarded(account, () => webhooks.verify(request));
  }

  /** Verifies a request, then returns the normalized event. Does not dispatch or deduplicate. */
  async parse(input: WebhookInput<TAccountId>): Promise<CulGateWebhookEvent> {
    const { account, webhooks, request } = this.#prepare(input);
    return guarded(account, async () => {
      // Nothing in the body is trusted, or even parsed, before this succeeds.
      await webhooks.verify(request);
      const event = await webhooks.normalize(request);
      return {
        ...event,
        type: isWebhookEventType(event.type) ? event.type : 'provider.unknown',
        accountId: account.info.id,
        provider: account.info.provider,
      };
    });
  }

  /**
   * The managed pipeline: verify, normalize, deduplicate (when an event store
   * is configured and the event has an ID), and run handlers. Never throws
   * for an unauthentic request or a failing handler; send `result.response`
   * back to the provider. Configuration mistakes still throw.
   */
  async handle(input: WebhookInput<TAccountId>): Promise<WebhookHandleResult> {
    let event: CulGateWebhookEvent;
    try {
      event = await this.parse(input);
    } catch (error) {
      if (!(error instanceof WebhookVerificationError)) throw error;
      const status = REJECTION_STATUS[error.code] ?? 401;
      return { status: 'rejected', error, response: { status, body: { error: error.code } } };
    }

    const key =
      this.#eventStore && event.id !== undefined
        ? { accountId: event.accountId, provider: event.provider, eventId: event.id }
        : undefined;
    if (key && !(await this.#eventStore!.claim(key))) {
      return { status: 'duplicate', event, response: ACKNOWLEDGED };
    }

    try {
      for (const type of [event.type, '*']) {
        for (const handler of this.#handlers.get(type) ?? []) await handler(event);
      }
    } catch (error) {
      if (key) await this.#release(key, error);
      return {
        status: 'failed',
        event,
        error,
        response: { status: 500, body: { error: 'handler_failed' } },
      };
    }

    if (key) await this.#eventStore!.markCompleted(key);
    return { status: 'processed', event, response: ACKNOWLEDGED };
  }

  async #release(
    key: { accountId: string; provider: string; eventId: string },
    error: unknown,
  ): Promise<void> {
    try {
      await this.#eventStore!.markFailed?.({ ...key, error });
    } catch {
      // The handler failure is what matters; the claim will expire on its own.
      this.#logger?.warn?.('culgate.webhook.mark_failed_error', {
        accountId: key.accountId,
        provider: key.provider,
        eventId: key.eventId,
      });
    }
  }

  #prepare(input: WebhookInput<TAccountId>): {
    account: ResolvedAccount;
    webhooks: WebhookOperations;
    request: WebhookRequest;
  } {
    assertInputObject(input);
    const account = this.#accounts.resolve(input.account);
    const { id: accountId, provider } = account.info;
    const { adapter } = account;

    for (const operation of ['webhooks.verify', 'webhooks.normalize'] as const) {
      const result = adapter.capabilities.check({ operation });
      if (!result.supported) {
        throw new UnsupportedOperationError(operation, result.reason, { accountId, provider });
      }
    }
    const { verify, normalize } = adapter.webhooks ?? {};
    if (!verify || !normalize) {
      throw new UnsupportedOperationError('webhooks.verify', 'the provider does not implement it', {
        accountId,
        provider,
      });
    }

    const context = { accountId, provider };
    const { rawBody, headers } = input as { rawBody: unknown; headers: unknown };
    if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
      throw new WebhookVerificationError(
        'Webhook verification needs the raw request body (string or bytes), not a parsed object. ' +
          'Configure your framework to preserve the raw body for this route.',
        { code: 'raw_body_required', ...context },
      );
    }
    if (webhookBodyBytes(rawBody).byteLength > this.#maxBodyBytes) {
      throw new WebhookVerificationError(
        `Webhook body exceeds the ${this.#maxBodyBytes}-byte limit.`,
        { code: 'payload_too_large', ...context },
      );
    }
    if (typeof headers !== 'object' || headers === null) {
      throw new WebhookVerificationError('Webhook headers are missing.', {
        code: 'missing_signature',
        ...context,
      });
    }

    return {
      account,
      webhooks: {
        verify: verify.bind(adapter.webhooks),
        normalize: normalize.bind(adapter.webhooks),
      },
      request: { rawBody, headers: headers as WebhookHeaders },
    };
  }
}

/** Runs adapter code, adding account context to any SDK error it raises. */
async function guarded<T>(account: ResolvedAccount, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PaymentSDKError) {
      const target = error as { accountId?: string; provider?: string };
      target.accountId ??= account.info.id;
      target.provider ??= account.info.provider;
    }
    throw error;
  }
}
