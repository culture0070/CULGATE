import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  PaymentNotFoundError,
  PaymentSDKError,
  ProviderError,
  RateLimitError,
  RefundError,
  TimeoutError,
  UnsupportedOperationError,
  ValidationError,
  WebhookVerificationError,
} from '../src/index.js';

describe('error hierarchy', () => {
  it.each([
    [new ConfigurationError('x'), 'ConfigurationError', 'configuration_error'],
    [new ValidationError('x'), 'ValidationError', 'validation_error'],
    [
      new UnsupportedOperationError('payments.capture', 'nope'),
      'UnsupportedOperationError',
      'unsupported_operation',
    ],
    [new ProviderError('x'), 'ProviderError', 'provider_error'],
    [new AuthenticationError('x'), 'AuthenticationError', 'authentication_error'],
    [new RateLimitError('x'), 'RateLimitError', 'rate_limited'],
    [new PaymentNotFoundError('x'), 'PaymentNotFoundError', 'payment_not_found'],
    [new RefundError('x'), 'RefundError', 'refund_error'],
    [new NetworkError('x'), 'NetworkError', 'network_error'],
    [new TimeoutError('x'), 'TimeoutError', 'timeout'],
    [new WebhookVerificationError('x'), 'WebhookVerificationError', 'webhook_verification_failed'],
  ])('%s has a stable name and code', (error, name, code) => {
    expect(error).toBeInstanceOf(PaymentSDKError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
  });

  it('keeps subtype relationships', () => {
    expect(new TimeoutError('x')).toBeInstanceOf(NetworkError);
    expect(new RateLimitError('x')).toBeInstanceOf(ProviderError);
    expect(new PaymentNotFoundError('x')).toBeInstanceOf(ProviderError);
  });

  it('is not retryable unless stated', () => {
    expect(new ProviderError('x').retryable).toBe(false);
    expect(new TimeoutError('x').retryable).toBe(false);
    expect(new RateLimitError('x', { retryAfterMs: 2000 })).toMatchObject({
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it('retains provider diagnostics', () => {
    const cause = new Error('socket hang up');
    const error = new ProviderError('Provider rejected the request.', {
      provider: 'mock',
      accountId: 'mock-one',
      httpStatus: 422,
      providerCode: 'parameter_invalid',
      requestId: 'req_123',
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error.toJSON()).toEqual({
      name: 'ProviderError',
      code: 'provider_error',
      message: 'Provider rejected the request.',
      provider: 'mock',
      accountId: 'mock-one',
      retryable: false,
      details: undefined,
      httpStatus: 422,
      providerCode: 'parameter_invalid',
      requestId: 'req_123',
    });
  });

  it('does not serialize the cause, which may hold request internals', () => {
    const error = new NetworkError('failed', {
      cause: { headers: { authorization: 'Basic c2VjcmV0' } },
    });
    expect(JSON.stringify(error)).not.toContain('c2VjcmV0');
  });
});
