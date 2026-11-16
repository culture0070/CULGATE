import {
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  PaymentSDKError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../errors/index.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The subset of `fetch` the transport needs; injectable for tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Optional diagnostics sink. CulGate only ever passes non-sensitive fields:
 * never headers, credentials, query strings, or request/response bodies.
 */
export interface Logger {
  debug?(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn?(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Default 200. */
  baseDelayMs?: number;
  /** Upper bound for any single wait, including `Retry-After`. Default 5000. */
  maxDelayMs?: number;
}

export interface HttpRequest {
  method: HttpMethod;
  /** Absolute, already-normalized path below the client's base URL. */
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  headers?: Readonly<Record<string, string>>;
  /** Serialized as JSON. */
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Whether this request may be sent more than once. Defaults to `true` for
   * GET and `false` otherwise. Set `true` on a write ONLY when it carries a
   * provider-enforced idempotency key.
   */
  retryable?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Parsed JSON, raw text for non-JSON responses, or `undefined` when empty. */
  body: T;
  requestId?: string;
}

export interface HttpClientOptions {
  provider: string;
  accountId: string;
  /** Fixed per provider/environment. Must be https (http only for loopback). */
  baseUrl: string;
  /**
   * Returns authentication and other fixed headers. Called per attempt and
   * applied last, so per-request headers can never override them.
   */
  headers?: () => Readonly<Record<string, string>>;
  /** Default 30000. */
  timeoutMs?: number;
  /** `false` disables retries entirely. */
  retry?: RetryOptions | false;
  /** Response headers that may carry the provider's request ID. */
  requestIdHeaders?: readonly string[];
  /**
   * Converts a non-2xx response into a provider-specific error. Return
   * `undefined` to use the default status-based mapping.
   */
  mapError?: (response: HttpResponse) => PaymentSDKError | undefined;
  fetch?: FetchLike;
  logger?: Logger;
  /** Test seam. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam; must return a number in [0, 1). */
  random?: () => number;
}

export interface HttpClient {
  request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const UNSAFE_PATH_CHARACTERS = /[\\?#\s\u0000-\u001f\u007f]/;

/**
 * Creates the HTTP client a provider adapter uses for one account.
 *
 * Guarantees: requests can only reach `baseUrl`'s origin and path prefix;
 * redirects are refused (so credentials are never forwarded elsewhere);
 * every request has a timeout; only requests that are safe to repeat are
 * retried; and nothing sensitive is logged or placed in error messages.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const context = { provider: options.provider, accountId: options.accountId };
  const base = parseBaseUrl(options.baseUrl, context);
  const basePath = base.pathname.replace(/\/+$/, '');
  const defaultTimeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, context);
  const retry = options.retry === false ? undefined : normalizeRetry(options.retry ?? {});
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const requestIdHeaders = options.requestIdHeaders ?? ['request-id', 'x-request-id'];
  const { logger } = options;

  function buildUrl(request: HttpRequest): string {
    const { path } = request;
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      UNSAFE_PATH_CHARACTERS.test(path)
    ) {
      throw invalidPath(
        'Expected an absolute path such as "/v1/payments" without query or fragment.',
      );
    }
    const url = new URL(base.origin + basePath + path);
    // Any difference means the URL parser normalized something (dot segments,
    // encoded dots, non-ASCII), i.e. the path does not mean what it says.
    if (url.origin !== base.origin || url.pathname !== basePath + path) {
      throw invalidPath('Path must be normalized and must stay within the provider base URL.');
    }
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }
    return url.toString();
  }

  async function attempt<T>(request: HttpRequest, url: string): Promise<HttpResponse<T>> {
    const timeoutMs = validateTimeout(request.timeoutMs ?? defaultTimeoutMs, context);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    const headers = new Headers({ accept: 'application/json' });
    for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
    if (request.body !== undefined) headers.set('content-type', 'application/json');
    for (const [name, value] of Object.entries(options.headers?.() ?? {})) headers.set(name, value);

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        method: request.method,
        headers,
        signal,
        redirect: 'error',
        ...(request.body !== undefined && { body: JSON.stringify(request.body) }),
      });
      text = await response.text();
    } catch (cause) {
      if (request.signal?.aborted) {
        throw new NetworkError('The request was aborted by the caller.', {
          code: 'aborted',
          cause,
          ...context,
        });
      }
      if (timeoutSignal.aborted) {
        throw new TimeoutError(
          `The request to ${options.provider} timed out after ${timeoutMs}ms. ` +
            'Whether the provider processed it is unknown.',
          { cause, ...context },
        );
      }
      throw new NetworkError(
        `The request to ${options.provider} failed without a response. ` +
          'Whether the provider processed it is unknown.',
        { cause, ...context },
      );
    }

    const requestId = requestIdHeaders
      .map((name) => response.headers.get(name))
      .find((value): value is string => Boolean(value));
    const isJson = /\bjson\b/i.test(response.headers.get('content-type') ?? '');
    let body: unknown = text === '' ? undefined : text;
    if (isJson && text !== '') {
      try {
        body = JSON.parse(text);
      } catch (cause) {
        if (response.ok) {
          throw new ProviderError(`${options.provider} returned a malformed JSON response.`, {
            code: 'invalid_response',
            httpStatus: response.status,
            cause,
            ...context,
            ...(requestId !== undefined && { requestId }),
          });
        }
      }
    }

    const result: HttpResponse = {
      status: response.status,
      headers: response.headers,
      body,
      ...(requestId !== undefined && { requestId }),
    };
    if (response.ok) return result as HttpResponse<T>;
    throw withContext(
      options.mapError?.(result) ?? defaultError(result, options.provider),
      context,
    );
  }

  return {
    async request<T>(request: HttpRequest): Promise<HttpResponse<T>> {
      const url = buildUrl(request);
      const mayRepeat = request.retryable ?? request.method === 'GET';
      const maxAttempts = retry && mayRepeat ? retry.maxAttempts : 1;

      for (let attemptNumber = 1; ; attemptNumber++) {
        const startedAt = Date.now();
        const fields = {
          ...context,
          method: request.method,
          path: request.path,
          attempt: attemptNumber,
        };
        try {
          const response = await attempt<T>(request, url);
          logger?.debug?.('culgate.http.response', {
            ...fields,
            status: response.status,
            durationMs: Date.now() - startedAt,
            requestId: response.requestId,
          });
          return response;
        } catch (error) {
          const delayMs =
            retry && attemptNumber < maxAttempts && !request.signal?.aborted
              ? retryDelay(error, attemptNumber, retry, random)
              : undefined;
          logger?.warn?.('culgate.http.error', {
            ...fields,
            durationMs: Date.now() - startedAt,
            error: error instanceof PaymentSDKError ? error.code : 'unexpected_error',
            status: error instanceof ProviderError ? error.httpStatus : undefined,
            retryInMs: delayMs,
          });
          if (delayMs === undefined) throw error;
          await sleep(delayMs, request.signal);
        }
      }
    },
  };

  function invalidPath(message: string): ValidationError {
    return new ValidationError(`Invalid request path: ${message}`, {
      issues: [{ path: 'path', message }],
      ...context,
    });
  }
}

/** Parses a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function defaultError(response: HttpResponse, provider: string): PaymentSDKError {
  const { status, requestId } = response;
  const common = { httpStatus: status, ...(requestId !== undefined && { requestId }) };
  // The response body is deliberately not included: it may contain personal data.
  const message = `${provider} responded with HTTP ${status}.`;
  if (status === 401 || status === 403) return new AuthenticationError(message, common);
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return new RateLimitError(message, {
      ...common,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
  }
  return new ProviderError(message, { ...common, retryable: RETRYABLE_STATUSES.has(status) });
}

/** Returns how long to wait before the next attempt, or `undefined` to give up. */
function retryDelay(
  error: unknown,
  attemptNumber: number,
  retry: Required<RetryOptions>,
  random: () => number,
): number | undefined {
  if (!(error instanceof PaymentSDKError)) return undefined;
  const transient = error instanceof NetworkError ? error.code !== 'aborted' : error.retryable;
  if (!transient) return undefined;
  if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs <= retry.maxDelayMs ? error.retryAfterMs : undefined;
  }
  // Exponential backoff with full jitter.
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attemptNumber - 1));
  return Math.floor(random() * ceiling);
}

function withContext(
  error: PaymentSDKError,
  context: { provider: string; accountId: string },
): PaymentSDKError {
  const target = error as { accountId?: string; provider?: string };
  target.accountId ??= context.accountId;
  target.provider ??= context.provider;
  return error;
}

function parseBaseUrl(baseUrl: string, context: { provider: string; accountId: string }): URL {
  const fail = (reason: string) =>
    new ConfigurationError(
      `Invalid base URL for provider "${context.provider}": ${reason}`,
      context,
    );
  if (typeof baseUrl !== 'string' || !URL.canParse(baseUrl)) throw fail('not an absolute URL.');
  const url = new URL(baseUrl);
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw fail('must use https.');
  }
  if (url.username || url.password) throw fail('must not contain credentials.');
  if (url.search || url.hash) throw fail('must not contain a query string or fragment.');
  return url;
}

function validateTimeout(
  timeoutMs: number,
  context: { provider: string; accountId: string },
): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ConfigurationError(
      `"timeoutMs" must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
      context,
    );
  }
  return timeoutMs;
}

function normalizeRetry(retry: RetryOptions): Required<RetryOptions> {
  const normalized = {
    maxAttempts: retry.maxAttempts ?? 3,
    baseDelayMs: retry.baseDelayMs ?? 200,
    maxDelayMs: retry.maxDelayMs ?? 5000,
  };
  const valid =
    Number.isInteger(normalized.maxAttempts) &&
    normalized.maxAttempts >= 1 &&
    normalized.maxAttempts <= 10 &&
    normalized.baseDelayMs >= 0 &&
    normalized.maxDelayMs >= normalized.baseDelayMs;
  if (!valid) throw new ConfigurationError('Invalid retry options.');
  return normalized;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
