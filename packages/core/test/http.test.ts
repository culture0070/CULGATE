import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  ConfigurationError,
  createHttpClient,
  type FetchLike,
  type HttpClientOptions,
  NetworkError,
  parseRetryAfter,
  PaymentNotFoundError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '../src/index.js';

const SECRET = 'sk_test_do_not_leak';
const BASE = { provider: 'acme', accountId: 'acme-main', baseUrl: 'https://api.acme.test/v1' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A client whose `fetch` replays the given responses (or thrown errors) in order. */
function clientWith(responses: (Response | Error)[], overrides: Partial<HttpClientOptions> = {}) {
  const fetchMock = vi.fn<FetchLike>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const client = createHttpClient({
    ...BASE,
    headers: () => ({ authorization: `Bearer ${SECRET}` }),
    fetch: fetchMock,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...overrides,
  });
  return { client, fetchMock, sleeps };
}

describe('requests', () => {
  it('sends JSON with authentication to the provider base URL', async () => {
    const { client, fetchMock } = clientWith([
      json(200, { id: 'pay_1' }, { 'x-request-id': 'req_9' }),
    ]);

    const response = await client.request<{ id: string }>({
      method: 'POST',
      path: '/payments',
      query: { expand: 'customer', limit: 10, skipped: undefined },
      body: { amount: 150000 },
    });

    expect(response).toMatchObject({ status: 200, body: { id: 'pay_1' }, requestId: 'req_9' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.acme.test/v1/payments?expand=customer&limit=10');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"amount":150000}');
    expect(init.redirect).toBe('error');
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('never lets per-request headers override authentication', async () => {
    const { client, fetchMock } = clientWith([json(200, {})]);
    await client.request({
      method: 'GET',
      path: '/payments',
      headers: { Authorization: 'Bearer attacker', 'x-custom': '1' },
    });
    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(headers.get('x-custom')).toBe('1');
  });

  it('handles empty and non-JSON bodies', async () => {
    const { client } = clientWith([new Response(null, { status: 204 }), new Response('OK')]);
    expect((await client.request({ method: 'DELETE', path: '/x' })).body).toBeUndefined();
    expect((await client.request({ method: 'GET', path: '/x' })).body).toBe('OK');
  });

  it('rejects malformed JSON in a success response', async () => {
    const { client } = clientWith([
      new Response('{not json', { headers: { 'content-type': 'application/json' } }),
    ]);
    await expect(client.request({ method: 'POST', path: '/x' })).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'invalid_response',
    });
  });
});

describe('path restrictions (SSRF)', () => {
  it.each([
    ['absolute URL', 'https://evil.example/steal'],
    ['protocol-relative URL', '//evil.example/steal'],
    ['relative path', 'payments'],
    ['parent traversal', '/../admin'],
    ['nested traversal', '/payments/../../admin'],
    ['encoded traversal', '/payments/%2e%2e/%2e%2e/admin'],
    ['dot segment', '/./payments'],
    ['backslash', '/\\evil.example'],
    ['embedded query', '/payments?admin=1'],
    ['fragment', '/payments#x'],
    ['whitespace', '/pay ments'],
    ['CRLF', '/payments\r\nx-injected: 1'],
    ['non-ASCII', '/páyments'],
  ])('rejects %s without sending anything', async (_label, path) => {
    const { client, fetchMock } = clientWith([]);
    await expect(client.request({ method: 'GET', path })).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps paths that merely look like hosts on the provider origin', async () => {
    const { client, fetchMock } = clientWith([json(200, {})]);
    await client.request({ method: 'GET', path: '/@evil.example/x' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.acme.test/v1/@evil.example/x');
  });

  it.each([
    ['plain http', 'http://api.acme.test'],
    ['embedded credentials', 'https://user:pass@api.acme.test'],
    ['query string', 'https://api.acme.test/?x=1'],
    ['not a URL', 'api.acme.test'],
  ])('rejects a base URL with %s', (_label, baseUrl) => {
    expect(() => createHttpClient({ ...BASE, baseUrl })).toThrow(ConfigurationError);
  });

  it('allows http for loopback only', () => {
    expect(() => createHttpClient({ ...BASE, baseUrl: 'http://127.0.0.1:8080' })).not.toThrow();
  });
});

describe('error mapping', () => {
  it.each([
    [401, AuthenticationError, false],
    [403, AuthenticationError, false],
    [400, ProviderError, false],
    [404, ProviderError, false],
    [500, ProviderError, false],
    [503, ProviderError, true],
  ])('maps HTTP %i', async (status, type, retryable) => {
    const { client } = clientWith([
      json(status, { secret_echo: SECRET }, { 'request-id': 'req_1' }),
    ]);
    const error = await client.request({ method: 'POST', path: '/x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({
      httpStatus: status,
      retryable,
      requestId: 'req_1',
      provider: 'acme',
      accountId: 'acme-main',
    });
    // Response bodies are not copied into errors by default.
    expect(JSON.stringify(error) + String(error)).not.toContain(SECRET);
  });

  it('maps 429 with Retry-After', async () => {
    const { client } = clientWith([json(429, {}, { 'retry-after': '2' })]);
    const error = await client.request({ method: 'POST', path: '/x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryAfterMs: 2000, retryable: true });
  });

  it('lets the provider map errors and still attaches account context', async () => {
    const { client } = clientWith([json(404, { errors: [{ code: 'resource_not_found' }] })], {
      mapError: (response) =>
        response.status === 404
          ? new PaymentNotFoundError('No such payment.', {
              httpStatus: 404,
              providerCode: (response.body as { errors: { code: string }[] }).errors[0]!.code,
            })
          : undefined,
    });
    const error = await client.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentNotFoundError);
    expect(error).toMatchObject({ providerCode: 'resource_not_found', accountId: 'acme-main' });
  });

  it('wraps transport failures as NetworkError with unknown outcome', async () => {
    const { client } = clientWith([new TypeError('fetch failed')]);
    const error = await client.request({ method: 'POST', path: '/x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as Error).message).toMatch(/unknown/);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe('retries', () => {
  it('never retries a write that is not marked safe to repeat', async () => {
    for (const failure of [json(503, {}), new TypeError('fetch failed'), json(429, {})]) {
      const { client, fetchMock, sleeps } = clientWith([failure, json(200, {})]);
      await expect(client.request({ method: 'POST', path: '/payments' })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('retries reads with bounded exponential backoff and jitter', async () => {
    const { client, fetchMock, sleeps } = clientWith([
      json(503, {}),
      new TypeError('fetch failed'),
      json(200, { ok: true }),
    ]);
    const response = await client.request({ method: 'GET', path: '/payments/1' });
    expect(response.body).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]); // random 0.5 x (200, 400)
  });

  it('retries a write explicitly marked idempotent, resending the identical request', async () => {
    const { client, fetchMock } = clientWith([json(502, {}), json(200, {})]);
    await client.request({
      method: 'POST',
      path: '/payments',
      headers: { 'idempotency-key': 'order-1' },
      body: { amount: 1 },
      retryable: true,
    });
    const [first, second] = fetchMock.mock.calls;
    expect((second![1].headers as Headers).get('idempotency-key')).toBe('order-1');
    expect(second![1].body).toBe(first![1].body);
  });

  it('stops after maxAttempts and surfaces the last error', async () => {
    const { client, fetchMock } = clientWith([json(503, {}), json(503, {}), json(503, {})]);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      httpStatus: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 404, 422, 500])('does not retry HTTP %i', async (status) => {
    const { client, fetchMock } = clientWith([json(status, {}), json(200, {})]);
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After, and gives up when it exceeds the maximum delay', async () => {
    const honoured = clientWith([json(429, {}, { 'retry-after': '3' }), json(200, {})]);
    await honoured.client.request({ method: 'GET', path: '/x' });
    expect(honoured.sleeps).toEqual([3000]);

    const tooLong = clientWith([json(429, {}, { 'retry-after': '120' }), json(200, {})]);
    await expect(tooLong.client.request({ method: 'GET', path: '/x' })).rejects.toThrow(
      RateLimitError,
    );
    expect(tooLong.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('can be disabled', async () => {
    const { client, fetchMock } = clientWith([json(503, {}), json(200, {})], { retry: false });
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('logging', () => {
  it('logs only non-sensitive fields', async () => {
    const debug = vi.fn();
    const warn = vi.fn();
    const { client } = clientWith([json(503, { card: '4242' }), json(200, { card: '4242' })], {
      logger: { debug, warn },
    });
    await client.request({
      method: 'GET',
      path: '/payments/1',
      query: { email: 'customer@example.com' },
    });

    expect(warn).toHaveBeenCalledWith(
      'culgate.http.error',
      expect.objectContaining({ status: 503, attempt: 1, retryInMs: 100, error: 'provider_error' }),
    );
    expect(debug).toHaveBeenCalledWith(
      'culgate.http.response',
      expect.objectContaining({ method: 'GET', path: '/payments/1', status: 200, attempt: 2 }),
    );
    const logged = JSON.stringify([...debug.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('customer@example.com');
    expect(logged).not.toContain('4242');
    expect(logged.toLowerCase()).not.toContain('authorization');
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter('Fri, 13 Nov 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Fri, 13 Nov 2026 00:00:00 GMT', now + 5000)).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('against a real HTTP server', () => {
  let server: Server;
  let baseUrl: string;
  const seen: { url?: string; authorization?: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      if (request.url === '/slow') return; // never responds
      if (request.url === '/redirect') {
        // Redirects back to this same server, so a followed redirect would be seen.
        response.writeHead(302, { location: '/elsewhere' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const client = () =>
    createHttpClient({
      ...BASE,
      baseUrl,
      retry: false,
      headers: () => ({ authorization: `Bearer ${SECRET}` }),
    });

  it('round-trips JSON using the global fetch', async () => {
    const response = await client().request({ method: 'GET', path: '/ok' });
    expect(response.body).toEqual({ ok: true });
    expect(seen.at(-1)).toEqual({ url: '/ok', authorization: `Bearer ${SECRET}` });
  });

  it('times out with a TimeoutError', async () => {
    const error = await client()
      .request({ method: 'POST', path: '/slow', timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ code: 'timeout', retryable: false });
  });

  it('distinguishes a caller abort from a timeout', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const error = await client()
      .request({ method: 'GET', path: '/slow', signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ code: 'aborted' });
  });

  it('refuses to follow redirects, so credentials are never forwarded', async () => {
    await expect(client().request({ method: 'GET', path: '/redirect' })).rejects.toThrow(
      NetworkError,
    );
    // Checked by URL, not by position: a request from an earlier test can
    // still reach the server while this one runs.
    const urls = seen.map((request) => request.url);
    expect(urls.filter((url) => url === '/redirect')).toHaveLength(1);
    expect(urls).not.toContain('/elsewhere');
  });
});
