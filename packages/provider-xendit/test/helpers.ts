import type { FetchLike, ProviderAdapter } from '@culgate/core';
import { xendit } from '../src/index.js';

export const TEST_KEY = 'xendit_fake_test_secret_key';
export const WEBHOOK_TOKEN = 'callback-token-9f8e7d6c5b4a';
export const PR = 'pr-c5a38204-58a9-4968-a8ad-68a79b172a66';
export const PY = 'py-66269236-7447-450f-b0d8-ed4255b11d8a';
export const RFD = 'rfd-1402feb0-8b79-85ae-9d1e-e69394d3949c';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A stand-in for the Xendit API: replies are registered per "METHOD /path". */
export function fakeXendit() {
  const routes = new Map<string, Reply>();
  const requests: RecordedRequest[] = [];

  const fetch: FetchLike = async (url, init) => {
    const { pathname } = new URL(url);
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      path: pathname,
      headers: init.headers as Headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const reply = routes.get(`${request.method} ${pathname}`) ?? {
      status: 404,
      body: { error_code: 'DATA_NOT_FOUND', message: 'ID specified in request cannot be found.' },
    };
    return Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers ?? {} });
  };

  return {
    fetch,
    requests,
    on(route: string, reply: Reply) {
      routes.set(route, reply);
      return this;
    },
    adapter(
      options: { webhookToken?: string; accountId?: string; secretKey?: string } = {},
    ): ProviderAdapter {
      const accountId = options.accountId ?? 'xendit-main';
      const provider = xendit();
      const config = provider.parseConfig(
        {
          provider: 'xendit',
          secretKey: options.secretKey ?? TEST_KEY,
          environment: 'test',
          ...(options.webhookToken && { webhookToken: options.webhookToken }),
        },
        { accountId },
      );
      return provider.createAdapter({ accountId, config, fetch });
    },
  };
}

/** Payment Request shaped like the v3 reference's e-wallet example. */
export function paymentRequest(overrides: Record<string, unknown> = {}) {
  return {
    business_id: '603f1c4172bbe840979fd408',
    reference_id: 'ORDER-123',
    payment_request_id: PR,
    type: 'PAY',
    country: 'PH',
    currency: 'PHP',
    request_amount: 1500.5,
    capture_method: 'AUTOMATIC',
    channel_code: 'GCASH',
    channel_properties: {
      success_return_url: 'https://example.com/payment/success',
      failure_return_url: 'https://example.com/payment/cancel',
    },
    actions: [
      {
        type: 'REDIRECT_CUSTOMER',
        descriptor: 'WEB_URL',
        value: 'https://pay.example/redirect/abc',
      },
      { type: 'REDIRECT_CUSTOMER', descriptor: 'DEEPLINK_URL', value: 'gcash://pay/abc' },
    ],
    status: 'REQUIRES_ACTION',
    description: 'Order payment',
    metadata: null,
    created: '2026-08-26T07:28:23.731Z',
    updated: '2026-08-26T07:28:23.731Z',
    ...overrides,
  };
}

export function refund(overrides: Record<string, unknown> = {}) {
  return {
    refund_id: RFD,
    reference_id: 'refund-order-123',
    business_id: '62440e322008e87fb29c1fd0',
    payment_id: PY,
    status: 'SUCCEEDED',
    amount: 500,
    currency: 'PHP',
    channel_code: 'GCASH',
    reason: 'REQUESTED_BY_CUSTOMER',
    created: '2024-10-28T05:29:07Z',
    updated: '2024-10-28T05:29:07Z',
    ...overrides,
  };
}

export const errorBody = (error_code: string, message = 'Something was wrong.') => ({
  error_code,
  message,
});
