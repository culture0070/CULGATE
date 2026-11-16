import { describe, expect, it } from 'vitest';
import { xenditAccountFromEnv } from '../src/index.js';

describe('xenditAccountFromEnv', () => {
  const env = Object.freeze({
    XENDIT_SECRET_KEY: 'xendit-key-from-env',
    XENDIT_ENVIRONMENT: 'test',
    XENDIT_WEBHOOK_TOKEN: 'token-from-env',
    XENDIT_SECONDARY_SECRET_KEY: 'second-key',
    XENDIT_SECONDARY_ENVIRONMENT: 'live',
  });

  it('reads the default variables', () => {
    expect(xenditAccountFromEnv({ env })).toEqual({
      provider: 'xendit',
      secretKey: 'xendit-key-from-env',
      environment: 'test',
      webhookToken: 'token-from-env',
    });
  });

  it('reads a second account from another prefix', () => {
    expect(xenditAccountFromEnv({ env, prefix: 'XENDIT_SECONDARY' })).toEqual({
      provider: 'xendit',
      secretKey: 'second-key',
      environment: 'live',
    });
  });

  it('lets explicit values take precedence over the environment', () => {
    expect(
      xenditAccountFromEnv({ env, overrides: { environment: 'live', webhookToken: 'explicit' } }),
    ).toMatchObject({
      environment: 'live',
      webhookToken: 'explicit',
      secretKey: 'xendit-key-from-env',
    });
  });

  it('requires the environment, since Xendit keys do not reveal their mode', () => {
    expect(() => xenditAccountFromEnv({ env: { XENDIT_SECRET_KEY: 'k' } })).toThrow(
      /"XENDIT_ENVIRONMENT" is required/,
    );
  });

  it('names a missing or invalid variable without echoing values', () => {
    expect(() => xenditAccountFromEnv({ env: {} })).toThrow(/"XENDIT_SECRET_KEY" is required/);
    let message = '';
    try {
      xenditAccountFromEnv({ env: { XENDIT_SECRET_KEY: 'k', XENDIT_ENVIRONMENT: 'sandbox' } });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('"XENDIT_ENVIRONMENT" must be "test" or "live"');
    expect(message).not.toContain('sandbox');
  });
});
