import { describe, expect, it, vi } from 'vitest';
import {
  createHttpClient,
  createProviderRequest,
  type FetchLike,
  type ProviderRequestInput,
  ValidationError,
} from '../src/index.js';

const SECRET = 'sk_test_escape_hatch_secret';

function setup(responses: Response[] = [Response.json({ ok: true })]) {
  const fetchMock = vi.fn<FetchLike>(async () => responses.shift() ?? Response.json({ ok: true }));
  const http = createHttpClient({
    provider: 'acme',
    accountId: 'acme-main',
    baseUrl: 'https://api.acme.test',
    headers: () => ({ authorization: `Bearer ${SECRET}` }),
    fetch: fetchMock,
    sleep: async () => {},
  });
  return { request: createProviderRequest(http), fetchMock };
}

describe('createProviderRequest', () => {
  it('sends an authenticated request to the provider and returns the raw response', async () => {
    const { request, fetchMock } = setup([
      Response.json({ data: [1, 2] }, { headers: { 'x-request-id': 'req_1' } }),
    ]);

    const response = await request<{ data: number[] }>({
      method: 'GET',
      path: '/v1/payments',
      query: { limit: 2 },
      headers: { 'api-version': '2025-09-01' },
    });

    expect(response).toMatchObject({ status: 200, body: { data: [1, 2] }, requestId: 'req_1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.acme.test/v1/payments?limit=2');
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(headers.get('api-version')).toBe('2025-09-01');
    expect(init.redirect).toBe('error');
  });

  it.each([
    ['a base URL override', { baseUrl: 'https://evil.example' }],
    ['a full URL field', { url: 'https://evil.example/steal' }],
    ['a host field', { host: 'evil.example' }],
    ['a retry override', { retryable: true }],
  ])('rejects %s', async (_label, extra) => {
    const { request, fetchMock } = setup();
    await expect(
      request({ method: 'GET', path: '/v1/x', ...extra } as ProviderRequestInput),
    ).rejects.toThrow(/Unknown field/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an absolute URL as the path', 'https://evil.example/steal'],
    ['a protocol-relative path', '//evil.example/steal'],
    ['path traversal', '/v1/../../admin'],
    ['encoded traversal', '/v1/%2e%2e/admin'],
    ['an embedded query', '/v1/x?token=1'],
    ['header injection in the path', '/v1/x\r\nx-injected: 1'],
  ])('rejects %s', async (_label, path) => {
    const { request, fetchMock } = setup();
    await expect(request({ method: 'GET', path })).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['TRACE', 'CONNECT', 'OPTIONS', 'HEAD', 'get', ''])(
    'rejects method %j',
    async (method) => {
      const { request, fetchMock } = setup();
      await expect(request({ method: method as 'GET', path: '/v1/x' })).rejects.toThrow(
        ValidationError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    'authorization',
    'Authorization',
    'AUTHORIZATION',
    'Proxy-Authorization',
    'proxy-anything',
    'Cookie',
    'Host',
    'Content-Length',
    'Transfer-Encoding',
    'Connection',
  ])('rejects the caller-supplied header %s', async (name) => {
    const { request, fetchMock } = setup();
    await expect(
      request({ method: 'GET', path: '/v1/x', headers: { [name]: 'attacker' } }),
    ).rejects.toThrow(/cannot be supplied/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a header value with CRLF', { 'x-note': 'a\r\nauthorization: Bearer attacker' }],
    ['a header name with a space', { 'x note': 'a' }],
    ['a header name with a colon', { 'x:note': 'a' }],
    ['a non-string header value', { 'x-note': 1 as unknown as string }],
  ])('rejects %s', async (_label, headers) => {
    const { request, fetchMock } = setup();
    await expect(request({ method: 'GET', path: '/v1/x', headers })).rejects.toThrow(
      ValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-primitive query values', async () => {
    const { request } = setup();
    await expect(
      request({ method: 'GET', path: '/v1/x', query: { filter: { a: 1 } as unknown as string } }),
    ).rejects.toThrow(ValidationError);
  });

  it('sends a write exactly once, but retries a read', async () => {
    const unavailable = () => Response.json({}, { status: 503 });

    const write = setup([unavailable(), Response.json({})]);
    await expect(
      write.request({ method: 'POST', path: '/v1/x', body: { a: 1 } }),
    ).rejects.toThrow();
    expect(write.fetchMock).toHaveBeenCalledTimes(1);

    const read = setup([unavailable(), Response.json({ ok: true })]);
    await expect(read.request({ method: 'GET', path: '/v1/x' })).resolves.toMatchObject({
      status: 200,
    });
    expect(read.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps error responses without exposing the credential', async () => {
    const { request } = setup([Response.json({ secret_echo: SECRET }, { status: 401 })]);
    const error = await request({ method: 'GET', path: '/v1/x' }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      name: 'AuthenticationError',
      httpStatus: 401,
      accountId: 'acme-main',
    });
    expect(JSON.stringify(error) + String(error)).not.toContain(SECRET);
  });
});
