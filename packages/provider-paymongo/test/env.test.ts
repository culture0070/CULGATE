import { ConfigurationError } from '@culgate/core';
import { describe, expect, it } from 'vitest';
import { paymongo, paymongoAccountFromEnv } from '../src/index.js';

const KEY = 'sk_test_from_environment_fake';

describe('paymongoAccountFromEnv', () => {
  it('reads the default variables and infers the mode from the key', () => {
    const env = {
      PAYMONGO_SECRET_KEY: KEY,
      PAYMONGO_WEBHOOK_SECRET: 'whsk_abc',
      PAYMONGO_TIMEOUT_MS: '10000',
    };
    expect(paymongoAccountFromEnv({ env })).toEqual({
      provider: 'paymongo',
      secretKey: KEY,
      environment: 'test',
      webhookSecret: 'whsk_abc',
      timeoutMs: 10000,
    });
    expect(
      paymongoAccountFromEnv({ env: { PAYMONGO_SECRET_KEY: 'sk_live_abc' } }).environment,
    ).toBe('live');
  });

  it('reads a second account from another prefix', () => {
    const env = {
      PAYMONGO_SECRET_KEY: KEY,
      PAYMONGO_SECONDARY_SECRET_KEY: 'sk_test_secondAccount',
    };
    expect(paymongoAccountFromEnv({ env, prefix: 'PAYMONGO_SECONDARY' }).secretKey).toBe(
      'sk_test_secondAccount',
    );
  });

  it('lets explicit values take precedence over the environment', () => {
    const env = {
      PAYMONGO_SECRET_KEY: KEY,
      PAYMONGO_WEBHOOK_SECRET: 'whsk_env',
      PAYMONGO_ENVIRONMENT: 'test',
    };
    const config = paymongoAccountFromEnv({
      env,
      overrides: {
        secretKey: 'sk_live_explicit',
        environment: 'live',
        webhookSecret: 'whsk_explicit',
      },
    });
    expect(config).toMatchObject({
      secretKey: 'sk_live_explicit',
      environment: 'live',
      webhookSecret: 'whsk_explicit',
    });
  });

  it('needs no environment variable when the key is given explicitly', () => {
    expect(paymongoAccountFromEnv({ env: {}, overrides: { secretKey: KEY } }).secretKey).toBe(KEY);
  });

  it('names the missing variable', () => {
    expect(() => paymongoAccountFromEnv({ env: {} })).toThrow(/"PAYMONGO_SECRET_KEY" is required/);
    expect(() => paymongoAccountFromEnv({ env: {}, prefix: 'PM_TWO' })).toThrow(
      /"PM_TWO_SECRET_KEY"/,
    );
  });

  it('asks for the environment when it cannot be inferred, without echoing the key', () => {
    let error: unknown;
    try {
      paymongoAccountFromEnv({ env: { PAYMONGO_SECRET_KEY: 'mystery-key-value' } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('"PAYMONGO_ENVIRONMENT"');
    expect(JSON.stringify(error) + String(error)).not.toContain('mystery-key-value');
  });

  it('still fails provider validation when the stated mode contradicts the key', () => {
    const config = paymongoAccountFromEnv({
      env: { PAYMONGO_SECRET_KEY: KEY, PAYMONGO_ENVIRONMENT: 'live' },
    });
    expect(() => paymongo().parseConfig({ ...config }, { accountId: 'a' })).toThrow(
      /does not match environment "live"/,
    );
  });

  it('does not mutate the environment source', () => {
    const env = Object.freeze({ PAYMONGO_SECRET_KEY: KEY });
    expect(() => paymongoAccountFromEnv({ env })).not.toThrow();
  });
});
