import type { FetchLike, ProviderAdapter } from '@culgate/core';
import { paymongo } from '../src/index.js';

export const TEST_KEY = 'sk_test_culgate_fake_key';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

interface StaticReply {
  status?: number;
  body: unknown;
}
type Reply = StaticReply | ((request: RecordedRequest) => StaticReply);

/**
 * A stand-in for the PayMongo API: replies are registered per
 * "METHOD /path" and every request is recorded. Multiple replies for the
 * same route are served in order; the last one repeats.
 */
export function fakePayMongo() {
  const routes = new Map<string, Reply[]>();
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
    const queue = routes.get(`${request.method} ${pathname}`);
    if (!queue?.length) {
      return Response.json(
        { errors: [{ code: 'resource_not_found', detail: 'No such route in the fake.' }] },
        { status: 404 },
      );
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    const reply = typeof next === 'function' ? next(request) : next;
    return Response.json(reply.body, { status: reply.status ?? 200 });
  };

  return {
    fetch,
    requests,
    on(route: string, ...replies: Reply[]) {
      routes.set(route, replies);
      return this;
    },
    adapter(secretKey = TEST_KEY, accountId = 'paymongo-main'): ProviderAdapter {
      const provider = paymongo();
      const config = provider.parseConfig(
        { provider: 'paymongo', secretKey, environment: 'test' },
        { accountId },
      );
      return provider.createAdapter({ accountId, config, fetch });
    },
  };
}

/** Payment Intent in the documented `data: { id, type, attributes }` envelope. */
export function intent(
  overrides: Record<string, unknown> = {},
  id = 'pi_1Pb5ED9RDLCSsWMwXT5W6Q3K',
) {
  return {
    data: {
      id,
      type: 'payment_intent',
      attributes: {
        amount: 150000,
        capture_type: 'automatic',
        client_key: `${id}_client_abc`,
        currency: 'PHP',
        description: 'Order payment',
        livemode: false,
        original_amount: 150000,
        statement_descriptor: 'CULGATE',
        status: 'awaiting_payment_method',
        last_payment_error: null,
        payment_method_allowed: ['gcash'],
        payments: [],
        next_action: null,
        payment_method_options: null,
        metadata: null,
        setup_future_usage: null,
        created_at: 1586179682,
        updated_at: 1586179682,
        ...overrides,
      },
    },
  };
}

export function awaitingAction(overrides: Record<string, unknown> = {}) {
  return intent({
    status: 'awaiting_next_action',
    next_action: {
      type: 'redirect',
      redirect: {
        url: 'https://test-sources.paymongo.com/sources?id=src_abc',
        return_url: 'https://example.com/payment/success',
      },
    },
    ...overrides,
  });
}

export function paidIntent(overrides: Record<string, unknown> = {}) {
  return intent({
    status: 'succeeded',
    payments: [
      {
        id: 'pay_JMg1rgaUtg5U79rRSjiDUvLr',
        type: 'payment',
        attributes: {
          amount: 150000,
          currency: 'PHP',
          status: 'paid',
          payment_intent_id: 'pi_1Pb5ED9RDLCSsWMwXT5W6Q3K',
          refunds: [],
        },
      },
    ],
    ...overrides,
  });
}

export function refund(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'ref_6W6F9Gi82YiApC4cBEzYq4nu',
      type: 'refund',
      attributes: {
        amount: 5000,
        balance_transaction_id: null,
        currency: 'PHP',
        livemode: false,
        metadata: null,
        notes: null,
        payment_id: 'pay_JMg1rgaUtg5U79rRSjiDUvLr',
        payout_id: null,
        reason: 'requested_by_customer',
        status: 'pending',
        transfer_link: null,
        available_at: 1586179800,
        created_at: 1586179700,
        refunded_at: null,
        updated_at: 1586179700,
        ...overrides,
      },
    },
  };
}

export function errorBody(code: string, detail = 'Something was wrong.', pointer?: string) {
  return { errors: [{ code, detail, ...(pointer && { source: { pointer } }) }] };
}
