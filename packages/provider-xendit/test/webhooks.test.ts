import {
  type ProviderWebhookEvent,
  type WebhookRequest,
  WebhookVerificationError,
} from '@culgate/core';
import { describe, expect, it } from 'vitest';
import { fakeXendit, PR, PY, RFD, WEBHOOK_TOKEN } from './helpers.js';

const adapter = (token = WEBHOOK_TOKEN) => fakeXendit().adapter({ webhookToken: token });
const verify = (request: WebhookRequest, token?: string) =>
  adapter(token).webhooks!.verify!(request) as void;
const normalize = (payload: unknown) =>
  adapter().webhooks!.normalize!({
    rawBody: typeof payload === 'string' ? payload : JSON.stringify(payload),
    headers: {},
  }) as ProviderWebhookEvent;
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookVerificationError);
    return (error as WebhookVerificationError).code;
  }
  return 'did not throw';
};

/** The `payment.capture` example from Xendit's payment webhook reference. */
const paymentCapture = {
  event: 'payment.capture',
  business_id: '603f1c4172bbe840979fd408',
  created: '2026-08-26T07:28:23.731Z',
  data: {
    payment_id: PY,
    business_id: '603f1c4172bbe840979fd408',
    reference_id: 'nw-2026-08-26T07:28:23.260Z',
    payment_request_id: PR,
    type: 'PAY',
    country: 'ID',
    currency: 'IDR',
    request_amount: 1234,
    capture_method: 'AUTOMATIC',
    channel_code: 'DANA',
    status: 'SUCCEEDED',
    captures: [
      {
        capture_id: 'cptr-66269236-7447-450f-b0d8-ed4255b11d8a',
        capture_timestamp: '2026-08-26T07:28:37.2Z',
        capture_amount: 1234,
      },
    ],
    payment_details: {},
    metadata: { order: 'A1' },
    created: '2026-08-26T07:28:23.731Z',
    updated: '2026-08-26T07:28:37.032Z',
  },
};

/** The `refund.succeeded` example from Xendit's refund webhook reference. */
const refundSucceeded = {
  event: 'refund.succeeded',
  business_id: '62440e322008e87fb29c1fd0',
  created: '2024-10-28T05:29:08Z',
  api_version: 'v3',
  data: {
    refund_id: RFD,
    reference_id: 'refund-order-123',
    business_id: '62440e322008e87fb29c1fd0',
    payment_id: PY,
    status: 'SUCCEEDED',
    amount: 10000,
    currency: 'IDR',
    channel_code: 'CARDS',
    reason: 'REQUESTED_BY_CUSTOMER',
    created: '2024-10-28T05:29:07Z',
    updated: '2024-10-28T05:29:07Z',
  },
};

describe('capabilities', () => {
  it('offers webhooks only on accounts with a webhook token', () => {
    const without = fakeXendit().adapter();
    expect(without.webhooks).toBeUndefined();
    expect(without.capabilities.check({ operation: 'webhooks.verify' }).supported).toBe(false);
    expect(adapter().capabilities.check({ operation: 'webhooks.verify' }).supported).toBe(true);
  });
});

describe('token verification', () => {
  const body = JSON.stringify(paymentCapture);

  it('accepts the account’s callback token, whatever the header casing or container', () => {
    expect(() =>
      verify({ rawBody: body, headers: { 'x-callback-token': WEBHOOK_TOKEN } }),
    ).not.toThrow();
    expect(() =>
      verify({ rawBody: body, headers: { 'X-CALLBACK-TOKEN': WEBHOOK_TOKEN } }),
    ).not.toThrow();
    expect(() =>
      verify({ rawBody: body, headers: new Headers({ 'X-Callback-Token': WEBHOOK_TOKEN }) }),
    ).not.toThrow();
  });

  it.each([
    ['no header', {}, 'missing_signature'],
    ['an empty token', { 'x-callback-token': '' }, 'missing_signature'],
    ['a wrong token', { 'x-callback-token': 'not-the-token' }, 'invalid_signature'],
    ['a token prefix', { 'x-callback-token': WEBHOOK_TOKEN.slice(0, -1) }, 'invalid_signature'],
    [
      'a token with extra characters',
      { 'x-callback-token': `${WEBHOOK_TOKEN}x` },
      'invalid_signature',
    ],
    ['a different case', { 'x-callback-token': WEBHOOK_TOKEN.toUpperCase() }, 'invalid_signature'],
  ])('rejects %s', (_label, headers, code) => {
    expect(codeOf(() => verify({ rawBody: body, headers }))).toBe(code);
  });

  it('rejects another account’s token', () => {
    expect(
      codeOf(() =>
        verify(
          { rawBody: body, headers: { 'x-callback-token': WEBHOOK_TOKEN } },
          'other-accounts-token',
        ),
      ),
    ).toBe('invalid_signature');
  });

  it('does not reveal the expected token in errors', () => {
    try {
      verify({ rawBody: body, headers: { 'x-callback-token': 'wrong' } });
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify(error) + String(error)).not.toContain(WEBHOOK_TOKEN);
    }
  });
});

describe('event normalization', () => {
  it('normalizes payment.capture, pointing at the payment request', () => {
    expect(normalize(paymentCapture)).toEqual({
      id: `payment.capture:${PY}:cptr-66269236-7447-450f-b0d8-ed4255b11d8a`,
      type: 'payment.succeeded',
      providerEventType: 'payment.capture',
      resourceId: PR,
      occurredAt: new Date('2026-08-26T07:28:23.731Z'),
      data: {
        paymentId: PR,
        amount: { value: 123400, currency: 'IDR' },
        providerStatus: 'SUCCEEDED',
      },
      raw: paymentCapture,
    });
  });

  it('derives the same event ID for a redelivery and a different one for another payment', () => {
    const again = normalize(structuredClone(paymentCapture));
    const other = normalize({
      ...paymentCapture,
      data: { ...paymentCapture.data, payment_id: 'py-another', captures: [] },
    });
    expect(again.id).toBe(normalize(paymentCapture).id);
    expect(other.id).toBe('payment.capture:py-another');
  });

  it.each([
    ['payment.failure', 'payment.failed'],
    ['payment.expiry', 'payment.expired'],
    ['payment_request.expiry', 'payment.expired'],
  ])('maps %s to %s', (event, type) => {
    const result = normalize({
      event,
      created: '2026-08-26T07:28:23.731Z',
      data: {
        ...paymentCapture.data,
        status: 'FAILED',
        failure_code: 'INSUFFICIENT_BALANCE',
        captures: [],
      },
    });
    expect(result).toMatchObject({
      type,
      providerEventType: event,
      resourceId: PR,
      id: `${event}:${PY}`,
    });
  });

  it('leaves the event ID unset when the payload has no payment ID', () => {
    const result = normalize({ event: 'payment_request.expiry', data: { payment_request_id: PR } });
    expect(result).toMatchObject({ type: 'payment.expired', resourceId: PR });
    expect(result.id).toBeUndefined();
  });

  it('normalizes refund events', () => {
    expect(normalize(refundSucceeded)).toEqual({
      id: `refund.succeeded:${RFD}`,
      type: 'refund.succeeded',
      providerEventType: 'refund.succeeded',
      resourceId: RFD,
      occurredAt: new Date('2024-10-28T05:29:08Z'),
      data: {
        refundId: RFD,
        providerPaymentId: PY,
        amount: { value: 1000000, currency: 'IDR' },
        providerStatus: 'SUCCEEDED',
      },
      raw: refundSucceeded,
    });
    expect(normalize({ ...refundSucceeded, event: 'refund.failed' })).toMatchObject({
      type: 'refund.failed',
      id: `refund.failed:${RFD}`,
    });
  });

  it.each([
    'payment.authorization',
    'payment_token.activation',
    'payout.succeeded',
    'invoice.paid',
  ])('keeps %s observable as provider.unknown', (event) => {
    const payload = { event, created: '2026-01-01T00:00:00Z', data: paymentCapture.data };
    const result = normalize(payload);
    expect(result).toMatchObject({
      type: 'provider.unknown',
      providerEventType: event,
      raw: payload,
    });
    expect(result.id).toBeUndefined();
  });

  it('keeps a payload in an undocumented shape observable', () => {
    // e.g. an older product's callback, which has no `event` field
    const legacy = { id: '579c8d61f23fa4ca35e52da4', external_id: 'invoice_123', status: 'PAID' };
    expect(normalize(legacy)).toEqual({
      type: 'provider.unknown',
      providerEventType: 'unknown',
      data: {},
      raw: legacy,
    });
  });

  it('omits an amount it cannot represent exactly rather than rounding it', () => {
    const result = normalize({
      ...paymentCapture,
      data: { ...paymentCapture.data, currency: 'PHP', request_amount: 10.005 },
    });
    expect(result.type).toBe('payment.succeeded');
    expect(result.data).toEqual({ paymentId: PR, providerStatus: 'SUCCEEDED' });
  });

  it.each([
    ['malformed JSON', '{"event":'],
    ['a JSON array', '[]'],
    ['an empty body', ''],
  ])('rejects %s', (_label, body) => {
    expect(codeOf(() => normalize(body))).toBe('invalid_payload');
  });
});
