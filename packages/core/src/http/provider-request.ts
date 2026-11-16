import { ValidationError } from '../errors/index.js';
import type { HttpClient, HttpMethod, HttpRequest } from './index.js';

/**
 * A provider-specific request made through the escape hatch. The host,
 * credentials, and redirect policy are fixed by the account's adapter and
 * cannot be set here.
 */
export interface ProviderRequestInput {
  method: HttpMethod;
  /** Absolute path on the provider's API, e.g. `/v1/payments`. */
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Sent as JSON. */
  body?: unknown;
  /** Extra headers, e.g. a provider API version. Authentication headers are not allowed. */
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Parsed JSON, raw text, or `undefined`. Not validated or normalized by CulGate. */
  body: T;
  requestId?: string;
}

export interface ProviderRequestOperations {
  request<T = unknown>(input: ProviderRequestInput): Promise<ProviderResponse<T>>;
}

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const INPUT_KEYS = new Set(['method', 'path', 'query', 'body', 'headers', 'timeoutMs', 'signal']);
/** Headers that carry credentials or control how the connection is made. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'expect',
  'forwarded',
]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Wraps an adapter's HTTP client as an escape-hatch request function.
 *
 * The client already pins the destination to the provider's base URL, refuses
 * redirects, applies the account's credentials last, enforces a timeout, and
 * maps errors. This adds input validation: only known fields and methods, and
 * no caller-supplied credential or connection headers. Writes are never
 * retried, because CulGate cannot know whether a given call is idempotent.
 */
export function createProviderRequest(http: HttpClient): ProviderRequestOperations['request'] {
  return async <T>(input: ProviderRequestInput): Promise<ProviderResponse<T>> => {
    if (typeof input !== 'object' || input === null) throw invalid('input', 'Expected an object.');
    for (const key of Object.keys(input)) {
      if (!INPUT_KEYS.has(key)) {
        throw invalid(key, 'Unknown field. The host and credentials cannot be overridden.');
      }
    }
    if (!METHODS.includes(input.method)) {
      throw invalid('method', `Expected one of ${METHODS.join(', ')}.`);
    }
    if (typeof input.path !== 'string') throw invalid('path', 'Expected a string.');

    const headers: Record<string, string> = {};
    if (input.headers !== undefined) {
      if (typeof input.headers !== 'object' || input.headers === null) {
        throw invalid('headers', 'Expected an object.');
      }
      for (const [name, value] of Object.entries(input.headers)) {
        const path = `headers.${name}`;
        if (!HEADER_NAME.test(name)) throw invalid('headers', 'Invalid header name.');
        if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-')) {
          throw invalid(path, 'This header is set by CulGate and cannot be supplied.');
        }
        if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) {
          throw invalid(path, 'Expected a string without control characters.');
        }
        headers[name] = value;
      }
    }
    if (input.query !== undefined) {
      if (typeof input.query !== 'object' || input.query === null) {
        throw invalid('query', 'Expected an object.');
      }
      for (const [name, value] of Object.entries(input.query)) {
        if (value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) {
          throw invalid(`query.${name}`, 'Expected a string, number, or boolean.');
        }
      }
    }

    const request: HttpRequest = {
      method: input.method,
      path: input.path,
      headers,
      // Only GETs are retried; a write goes out exactly once.
      retryable: input.method === 'GET',
      ...(input.query !== undefined && { query: input.query }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
      ...(input.signal !== undefined && { signal: input.signal }),
    };
    const response = await http.request<T>(request);
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      ...(response.requestId !== undefined && { requestId: response.requestId }),
    };
  };
}

function invalid(path: string, message: string): ValidationError {
  return new ValidationError(`Invalid provider request ${path}: ${message}`, {
    issues: [{ path, message }],
  });
}
