import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  ProviderAdapterContext,
  PaymentSDKError,
} from '@culgate/core';
import { AuthenticationError, createHttpClient, ProviderError } from '@culgate/core';
import type { z } from 'zod';
import type { PayMongoAccountConfig } from './config.js';
import { PAYMONGO_PROVIDER_NAME } from './config.js';
import { errorResponseSchema } from './schemas.js';

/** One host for both modes; the API key selects test or live. */
export const PAYMONGO_API_BASE_URL = 'https://api.paymongo.com';

/**
 * Error codes that mean the credentials were rejected. `account_not_activated`
 * is deliberately absent: PayMongo also returns it (with HTTP 400) when a
 * payment method is not enabled for the merchant, which is not a key problem.
 */
const AUTHENTICATION_CODES = new Set([
  'api_key_required',
  'authentication_invalid',
  'api_key_not_found',
  'secret_key_required',
  'unauthorized',
]);

export interface PayMongoClient {
  /** The underlying authenticated client, for the provider escape hatch. */
  readonly http: HttpClient;
  /** Sends a request and validates the response body against `schema`. */
  send<TSchema extends z.ZodType>(
    schema: TSchema,
    request: HttpRequest,
  ): Promise<{ data: z.infer<TSchema>; raw: unknown }>;
}

export function createPayMongoClient(
  context: ProviderAdapterContext<PayMongoAccountConfig>,
  baseUrl: string,
): PayMongoClient {
  const { accountId, config } = context;
  // HTTP Basic: secret key as the username, empty password.
  const authorization = `Basic ${btoa(`${config.secretKey}:`)}`;

  const http: HttpClient = createHttpClient({
    provider: PAYMONGO_PROVIDER_NAME,
    accountId,
    baseUrl,
    headers: () => ({ authorization }),
    mapError: mapPayMongoError,
    ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
    ...(context.fetch && { fetch: context.fetch }),
    ...(context.logger && { logger: context.logger }),
  });

  return {
    http,
    async send(schema, request) {
      const response = await http.request(request);
      const parsed = schema.safeParse(response.body);
      if (!parsed.success) {
        // The payload is not included: it may contain customer data.
        throw new ProviderError('PayMongo returned a response in an unexpected format.', {
          code: 'invalid_response',
          provider: PAYMONGO_PROVIDER_NAME,
          accountId,
          httpStatus: response.status,
          details: { fields: parsed.error.issues.map((issue) => issue.path.join('.')) },
        });
      }
      return { data: parsed.data, raw: response.body };
    },
  };
}

/**
 * Converts PayMongo's `{ errors: [{ code, detail, source.pointer }] }` body.
 * Returns `undefined` (default status-based mapping) for bodies in any other
 * shape and for HTTP 429, whose format PayMongo does not document.
 */
export function mapPayMongoError(response: HttpResponse): PaymentSDKError | undefined {
  if (response.status === 429) return undefined;
  const parsed = errorResponseSchema.safeParse(response.body);
  if (!parsed.success) return undefined;

  const { errors } = parsed.data;
  const first = errors[0]!;
  const options = {
    httpStatus: response.status,
    providerCode: first.code,
    ...(response.requestId !== undefined && { requestId: response.requestId }),
    details: {
      errors: errors.map((error) => ({
        code: error.code,
        pointer: error.source?.pointer ?? undefined,
        subCode: error.sub_code ?? undefined,
      })),
    },
  };
  const message = `PayMongo rejected the request (${first.code})${first.detail ? `: ${first.detail}` : '.'}`;

  if (response.status === 401 || AUTHENTICATION_CODES.has(first.code)) {
    return new AuthenticationError(message, options);
  }
  return new ProviderError(message, {
    ...options,
    retryable: response.status >= 502 && response.status <= 504,
  });
}

/** Whether `error` is a PayMongo error response carrying the given code. */
export function hasProviderCode(error: unknown, code: string): error is ProviderError {
  return error instanceof ProviderError && error.providerCode === code;
}
