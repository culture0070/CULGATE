import type { WebhookHandleResult, WebhookInput } from '@culgate/sdk';
import { ConfigurationError } from '@culgate/sdk';
import type { Request, RequestHandler } from 'express';

/** The part of `PaymentSDK` this package uses. */
export interface WebhookCapableSdk<TAccountId extends string = string> {
  webhooks: { handle(input: WebhookInput<TAccountId>): Promise<WebhookHandleResult> };
}

export interface PaymentWebhookOptions<TAccountId extends string = string> {
  /**
   * The CulGate account this route receives webhooks for. Register one route
   * per account; the account is never taken from the request.
   */
  account: TAccountId;
  /**
   * Largest body this handler will read itself. Default 1 MiB. Has no effect
   * when a body parser already read the body; set that parser's own limit.
   */
  maxBodyBytes?: number;
  /** Called with every outcome before the response is sent, e.g. for logging. */
  onResult?: (result: WebhookHandleResult, request: Request) => void | Promise<void>;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Express handler that verifies, normalizes, deduplicates, and dispatches a
 * provider webhook through `sdk.webhooks.handle()`, then sends the response
 * the provider expects.
 *
 * ```ts
 * app.post('/webhooks/paymongo-primary', paymentWebhook(sdk, { account: 'paymongo-primary' }));
 * ```
 *
 * The raw request body is required for verification. It is taken from, in
 * order: a `Buffer`/string `req.body` (`express.raw()` / `express.text()`), a
 * `Buffer` at `req.rawBody`, or the request stream itself when no body parser
 * ran. If `express.json()` already consumed the body without preserving it,
 * the handler fails with a `ConfigurationError` instead of guessing.
 */
export function paymentWebhook<TAccountId extends string>(
  sdk: WebhookCapableSdk<TAccountId>,
  options: PaymentWebhookOptions<TAccountId>,
): RequestHandler {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (request, response, next) => {
    try {
      const rawBody = await readRawBody(request, maxBodyBytes);
      if (rawBody === 'too_large') {
        response.status(413).json({ error: 'payload_too_large' });
        return;
      }
      const result = await sdk.webhooks.handle({
        account: options.account,
        rawBody,
        headers: request.headers,
      });
      await options.onResult?.(result, request);
      response.status(result.response.status).json(result.response.body);
    } catch (error) {
      next(error);
    }
  };
}

async function readRawBody(
  request: Request,
  maxBytes: number,
): Promise<Buffer | string | 'too_large'> {
  const { body } = request as { body?: unknown };
  if (Buffer.isBuffer(body) || typeof body === 'string') return body;

  const { rawBody } = request as { rawBody?: unknown };
  if (Buffer.isBuffer(rawBody)) return rawBody;

  const consumed = request.readableEnded || request.destroyed;
  if (consumed || (body !== undefined && body !== null)) {
    throw new ConfigurationError(
      'The raw webhook body is not available because a body parser already consumed it. ' +
        'Mount this route before express.json(), or use express.raw({ type: "*/*" }) on it, ' +
        'or keep the bytes with express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }).',
      { code: 'raw_body_unavailable' },
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > maxBytes) {
      request.resume(); // discard the rest so the response can be delivered
      return 'too_large';
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
