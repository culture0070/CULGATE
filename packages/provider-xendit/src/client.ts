import type { HttpClient, HttpRequest, HttpResponse, ProviderAdapterContext } from '@culgate/core';
import {
  AuthenticationError,
  createHttpClient,
  ProviderError,
  RateLimitError,
  ValidationError,
} from '@culgate/core';
import type { PaymentSDKError } from '@culgate/core';
import type { z } from 'zod';
import type { XenditAccountConfig } from './config.js';
import { XENDIT_PROVIDER_NAME } from './config.js';
import { errorResponseSchema } from './schemas.js';

/** One host for both modes; the API key selects test or live. */
export const XENDIT_API_BASE_URL = 'https://api.xendit.co';
/** Version of the Payments API (Payment Requests, Payments, Refunds v3) this adapter targets. */
export const XENDIT_API_VERSION = '2024-11-11';

export interface XenditClient {
  /**
   * The underlying authenticated client, for the provider escape hatch. It
   * sends no `api-version`: other Xendit products use other versions.
   */
  readonly http: HttpClient;
  /** Sends a request, validates the body against `schema`, and maps it with `map`. */
  send<TSchema extends z.ZodType, TResult>(
    schema: TSchema,
    request: HttpRequest,
    map: (data: z.infer<TSchema>, raw: unknown) => TResult,
    options?: {
      /** Send the Payments API `api-version` header. Default `true`. */ apiVersion?: boolean;
    },
  ): Promise<TResult>;
}

export function createXenditClient(
  context: ProviderAdapterContext<XenditAccountConfig>,
  baseUrl: string,
): XenditClient {
  const { accountId, config } = context;
  // HTTP Basic: secret key as the username, empty password.
  const authorization = `Basic ${btoa(`${config.secretKey}:`)}`;

  const http: HttpClient = createHttpClient({
    provider: XENDIT_PROVIDER_NAME,
    accountId,
    baseUrl,
    headers: () => ({ authorization }),
    mapError: mapXenditError,
    ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
    ...(context.fetch && { fetch: context.fetch }),
    ...(context.logger && { logger: context.logger }),
  });

  const invalidResponse = (status: number, fields: string[]) =>
    // The payload is not included: it may contain customer data.
    new ProviderError('Xendit returned a response in an unexpected format.', {
      code: 'invalid_response',
      provider: XENDIT_PROVIDER_NAME,
      accountId,
      httpStatus: status,
      details: { fields },
    });

  return {
    http,
    async send(schema, request, map, options = {}) {
      const response = await http.request({
        ...request,
        headers: {
          ...request.headers,
          ...(options.apiVersion !== false && { 'api-version': XENDIT_API_VERSION }),
        },
      });
      const parsed = schema.safeParse(response.body);
      if (!parsed.success) {
        throw invalidResponse(
          response.status,
          parsed.error.issues.map((issue) => issue.path.join('.')),
        );
      }
      try {
        return map(parsed.data, response.body);
      } catch (error) {
        // Mapping failures (e.g. an amount with too many decimals) mean the
        // response is not what the documentation describes.
        if (error instanceof ValidationError) {
          throw invalidResponse(
            response.status,
            error.issues.map((issue) => issue.path),
          );
        }
        throw error;
      }
    },
  };
}

/**
 * Converts Xendit's `{ error_code, message }` body. Returns `undefined`
 * (default status-based mapping) for bodies in any other shape.
 */
export function mapXenditError(response: HttpResponse): PaymentSDKError | undefined {
  const parsed = errorResponseSchema.safeParse(response.body);
  if (!parsed.success) return undefined;

  const { error_code: code, message: detail } = parsed.data;
  const options = {
    httpStatus: response.status,
    providerCode: code,
    ...(response.requestId !== undefined && { requestId: response.requestId }),
  };
  const message = `Xendit rejected the request (${code})${detail ? `: ${detail}` : '.'}`;

  if (response.status === 401 || code === 'INVALID_API_KEY') {
    return new AuthenticationError(message, options);
  }
  if (response.status === 429) {
    // `Rate-Limit-Reset`: seconds remaining in the current rate-limit window.
    const reset = Number(response.headers.get('rate-limit-reset'));
    return new RateLimitError(message, {
      ...options,
      ...(Number.isFinite(reset) && reset > 0 && { retryAfterMs: Math.ceil(reset * 1000) }),
    });
  }
  return new ProviderError(message, {
    ...options,
    retryable: response.status >= 502 && response.status <= 504,
  });
}
