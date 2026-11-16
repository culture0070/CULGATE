import { createHmac } from 'node:crypto';
import {
  type ProviderWebhookEvent,
  type WebhookRequest,
  WebhookVerificationError,
} from '@culgate/core';
import { assertProviderContract } from '@culgate/core/testing';
import { describe, expect, it } from 'vitest';
import { paymongo, type PayMongoProviderOptions } from '../src/index.js';
import { TEST_KEY } from './helpers.js';

const WEBHOOK_SECRET = 'whsk_culgate_fake_secret';
const LIVE_KEY = 'sk_live_culgate_fake_key';
const TIMESTAMP = 1700000100;

/** Signs the way PayMongo documents: HMAC-SHA256 over "<t>.<raw body>". */
function signature(body: string, secret = WEBHOOK_SECRET, timestamp = TIMESTAMP): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function request(body: string, mode: 'te' | 'li' = 'te', secret = WEBHOOK_SECRET) {
  const sig = signature(body, secret);
  const value = mode === 'te' ? `t=${TIMESTAMP},te=${sig},li=` : `t=${TIMESTAMP},te=,li=${sig}`;
  return { rawBody: body, headers: { 'Paymongo-Signature': value } };
}

function webhooks(
  environment: 'test' | 'live' = 'test',
  options: PayMongoProviderOptions = {},
  webhookSecret: string | undefined = WEBHOOK_SECRET,
) {
  const provider = paymongo(options);
  const config = provider.parseConfig(
    {
      provider: 'paymongo',
      secretKey: environment === 'live' ? LIVE_KEY : TEST_KEY,
      environment,
      ...(webhookSecret && { webhookSecret }),
    },
    { accountId: 'paymongo-main' },
  );
  return provider.createAdapter({ accountId: 'paymongo-main', config });
}

const verify = (input: WebhookRequest, adapter = webhooks()) =>
  adapter.webhooks!.verify!(input) as void;
const normalize = (body: string, adapter = webhooks()) =>
  adapter.webhooks!.normalize!({ rawBody: body, headers: {} }) as ProviderWebhookEvent;
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookVerificationError);
    return (error as WebhookVerificationError).code;
  }
  return 'did not throw';
};

/** Shaped like the `payment.paid` example in PayMongo's webhook events guide. */
const paymentPaid = JSON.stringify({
  data: {
    id: 'evt_9w6KTxQY3hmuDQaALHoAZnRp',
    type: 'event',
    attributes: {
      type: 'payment.paid',
      livemode: false,
      data: {
        id: 'pay_JMg1rgaUtg5U79rRSjiDUvLr',
        type: 'payment',
        attributes: {
          amount: 10000,
          currency: 'PHP',
          status: 'paid',
          description: 'Order #1234',
          payment_intent_id: 'pi_1Pb5ED9RDLCSsWMwXT5W6Q3K',
        },
      },
      previous_data: {},
      created_at: 1619426488,
      updated_at: 1619426488,
    },
  },
});

function event(type: string, resource: object, extra: object = {}) {
  return JSON.stringify({
    data: {
      id: 'evt_abc',
      type: 'event',
      attributes: { type, livemode: false, created_at: 1700000000, data: resource, ...extra },
    },
  });
}

describe('capabilities', () => {
  it('offers webhooks only on accounts with a webhook secret', () => {
    const without = webhooks('test', {}, '');
    expect(without.webhooks).toBeUndefined();
    expect(without.capabilities.check({ operation: 'webhooks.verify' }).supported).toBe(false);

    const withSecret = webhooks();
    expect(withSecret.capabilities.operations).toContain('webhooks.verify');
    expect(withSecret.capabilities.operations).toContain('webhooks.normalize');
  });

  it('passes the provider contract with the webhook secret treated as a secret', () => {
    assertProviderContract(paymongo(), {
      validConfig: {
        provider: 'paymongo',
        secretKey: TEST_KEY,
        environment: 'test',
        webhookSecret: WEBHOOK_SECRET,
      },
      requiredKeys: ['secretKey'],
      secrets: [TEST_KEY, WEBHOOK_SECRET],
    });
  });
});

describe('signature verification', () => {
  it('accepts a correctly signed test-mode request', () => {
    expect(() => verify(request(paymentPaid))).not.toThrow();
  });

  it('verifies the exact bytes received, as a string or a buffer', () => {
    const signed = request(paymentPaid);
    expect(() => verify({ ...signed, rawBody: Buffer.from(paymentPaid) })).not.toThrow();
  });

  it('finds the header regardless of case or container type', () => {
    const { headers } = request(paymentPaid);
    const value = headers['Paymongo-Signature'];
    expect(() =>
      verify({ rawBody: paymentPaid, headers: { 'paymongo-signature': value } }),
    ).not.toThrow();
    expect(() =>
      verify({ rawBody: paymentPaid, headers: new Headers({ 'PAYMONGO-SIGNATURE': value }) }),
    ).not.toThrow();
  });

  it('rejects a body that was parsed and re-serialized', () => {
    const signed = request(paymentPaid);
    const reserialized = JSON.stringify(JSON.parse(paymentPaid), null, 2);
    expect(codeOf(() => verify({ ...signed, rawBody: reserialized }))).toBe('invalid_signature');
  });

  it('rejects a modified body', () => {
    const signed = request(paymentPaid);
    const tampered = paymentPaid.replace('"amount":10000', '"amount":99999');
    expect(codeOf(() => verify({ ...signed, rawBody: tampered }))).toBe('invalid_signature');
  });

  it('rejects a signature made with another webhook’s secret', () => {
    const signed = request(paymentPaid, 'te', 'whsk_someOtherWebhookSecret00');
    expect(codeOf(() => verify(signed))).toBe('invalid_signature');
  });

  it('rejects a changed timestamp, which is part of the signed string', () => {
    const { headers } = request(paymentPaid);
    const value = headers['Paymongo-Signature'].replace(`t=${TIMESTAMP}`, `t=${TIMESTAMP + 1}`);
    expect(
      codeOf(() => verify({ rawBody: paymentPaid, headers: { 'Paymongo-Signature': value } })),
    ).toBe('invalid_signature');
  });

  it.each([
    ['no header', {}, 'missing_signature'],
    ['empty header', { 'Paymongo-Signature': '' }, 'missing_signature'],
    ['no timestamp', { 'Paymongo-Signature': `te=${'a'.repeat(64)},li=` }, 'invalid_signature'],
    [
      'non-numeric timestamp',
      { 'Paymongo-Signature': `t=abc,te=${'a'.repeat(64)},li=` },
      'invalid_signature',
    ],
    ['empty signature', { 'Paymongo-Signature': `t=${TIMESTAMP},te=,li=` }, 'invalid_signature'],
    [
      'non-hex signature',
      { 'Paymongo-Signature': `t=${TIMESTAMP},te=${'z'.repeat(64)},li=` },
      'invalid_signature',
    ],
    [
      'truncated signature',
      { 'Paymongo-Signature': `t=${TIMESTAMP},te=abcd,li=` },
      'invalid_signature',
    ],
    ['garbage', { 'Paymongo-Signature': ',,==,' }, 'invalid_signature'],
  ])('rejects %s', (_label, headers, code) => {
    expect(codeOf(() => verify({ rawBody: paymentPaid, headers }))).toBe(code);
  });

  it('uses `te` in test mode and `li` in live mode, never the other', () => {
    const testSigned = request(paymentPaid, 'te');
    const liveSigned = request(paymentPaid, 'li');

    expect(() => verify(liveSigned, webhooks('live'))).not.toThrow();
    // A validly signed test-mode request must not be accepted by a live account, or vice versa.
    expect(codeOf(() => verify(testSigned, webhooks('live')))).toBe('invalid_signature');
    expect(codeOf(() => verify(liveSigned, webhooks('test')))).toBe('invalid_signature');
  });

  it('does not enforce a timestamp tolerance unless configured', () => {
    expect(() => verify(request(paymentPaid))).not.toThrow(); // TIMESTAMP is years old
  });

  it('enforces the configured timestamp tolerance', () => {
    const at = (secondsAfter: number) =>
      webhooks('test', {
        webhooks: {
          timestampToleranceSeconds: 300,
          now: () => (TIMESTAMP + secondsAfter) * 1000,
        },
      });
    expect(() => verify(request(paymentPaid), at(299))).not.toThrow();
    expect(codeOf(() => verify(request(paymentPaid), at(301)))).toBe('timestamp_out_of_tolerance');
    expect(codeOf(() => verify(request(paymentPaid), at(-301)))).toBe('timestamp_out_of_tolerance');
  });

  it('does not reveal the secret or the expected signature in errors', () => {
    try {
      verify({
        rawBody: paymentPaid,
        headers: { 'Paymongo-Signature': `t=${TIMESTAMP},te=${'a'.repeat(64)},li=` },
      });
      expect.unreachable();
    } catch (error) {
      const exposed = JSON.stringify(error) + String(error);
      expect(exposed).not.toContain(WEBHOOK_SECRET);
      expect(exposed).not.toContain(signature(paymentPaid));
    }
  });
});

describe('event normalization', () => {
  it('normalizes payment.paid and points at the payment intent', () => {
    const result = normalize(paymentPaid);
    expect(result).toEqual({
      id: 'evt_9w6KTxQY3hmuDQaALHoAZnRp',
      type: 'payment.succeeded',
      providerEventType: 'payment.paid',
      resourceId: 'pi_1Pb5ED9RDLCSsWMwXT5W6Q3K',
      occurredAt: new Date(1619426488 * 1000),
      data: {
        paymentId: 'pi_1Pb5ED9RDLCSsWMwXT5W6Q3K',
        amount: { value: 10000, currency: 'PHP' },
        providerStatus: 'paid',
      },
      raw: JSON.parse(paymentPaid),
    });
  });

  it('normalizes payment.failed', () => {
    const body = event('payment.failed', {
      id: 'pay_x',
      type: 'payment',
      attributes: { amount: 10000, currency: 'PHP', status: 'failed', payment_intent_id: 'pi_x' },
    });
    expect(normalize(body)).toMatchObject({
      type: 'payment.failed',
      providerEventType: 'payment.failed',
      resourceId: 'pi_x',
      data: { providerStatus: 'failed' },
    });
  });

  it('falls back to the payment ID when there is no payment intent', () => {
    const body = event('payment.paid', {
      id: 'pay_fromLink',
      type: 'payment',
      attributes: { amount: 10000, currency: 'PHP', status: 'paid', payment_intent_id: null },
    });
    expect(normalize(body)).toMatchObject({
      resourceId: 'pay_fromLink',
      data: { paymentId: 'pay_fromLink' },
    });
  });

  it.each([
    ['succeeded', 'refund.succeeded'],
    ['failed', 'refund.failed'],
    ['processing', 'refund.pending'],
    ['pending', 'refund.pending'],
    ['reversed', 'provider.unknown'],
  ])('maps payment.refund.updated with status %s to %s', (status, type) => {
    const body = event('payment.refund.updated', {
      id: 'ref_abc',
      type: 'refund',
      attributes: {
        amount: 200,
        currency: 'PHP',
        payment_id: 'pay_x',
        reason: 'duplicate',
        status,
      },
    });
    const result = normalize(body);
    expect(result).toMatchObject({ type, providerEventType: 'payment.refund.updated' });
    if (type !== 'provider.unknown') {
      expect(result).toMatchObject({
        resourceId: 'ref_abc',
        data: {
          refundId: 'ref_abc',
          providerPaymentId: 'pay_x',
          amount: { value: 200, currency: 'PHP' },
          providerStatus: status,
        },
      });
    }
  });

  it.each([
    'payment.refunded',
    'link.payment.paid',
    'qrph.expired',
    'source.chargeable',
    'some.future.event',
  ])('keeps %s observable as provider.unknown with its original type and payload', (type) => {
    const body = event(type, { id: 'res_1', type: 'thing', attributes: { status: 'paid' } });
    const result = normalize(body);
    expect(result).toMatchObject({
      id: 'evt_abc',
      type: 'provider.unknown',
      providerEventType: type,
    });
    expect(result.raw).toEqual(JSON.parse(body));
  });

  it('keeps a payload outside the documented envelope observable, without an event ID', () => {
    // PayMongo's docs show some events as a bare resource with no envelope.
    const bare = JSON.stringify({
      id: 'ref_xxxxx',
      type: 'refund',
      attributes: { status: 'succeeded' },
    });
    const result = normalize(bare);
    expect(result).toEqual({
      type: 'provider.unknown',
      providerEventType: 'unknown',
      data: {},
      raw: JSON.parse(bare),
    });
    expect(result.id).toBeUndefined();
  });

  it('rejects an event whose mode contradicts the account environment', () => {
    expect(codeOf(() => normalize(paymentPaid, webhooks('live')))).toBe('livemode_mismatch');
  });

  it.each([
    ['malformed JSON', '{"data":'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['an empty body', ''],
  ])('rejects %s', (_label, body) => {
    expect(codeOf(() => normalize(body))).toBe('invalid_payload');
  });
});
