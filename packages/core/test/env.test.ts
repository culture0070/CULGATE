import { describe, expect, it } from 'vitest';
import { ConfigurationError, createEnvReader, defaultEnv } from '../src/index.js';

describe('createEnvReader', () => {
  const env = Object.freeze({
    APP_SECRET_KEY: '  sk_value  ',
    APP_EMPTY: '   ',
    APP_ENVIRONMENT: 'live',
    APP_TIMEOUT_MS: '15000',
    APP_BAD_ENVIRONMENT: 'production',
    APP_BAD_NUMBER: '15s',
  });
  const reader = createEnvReader(env, 'APP');

  it('reads trimmed values and treats blank as unset', () => {
    expect(reader.required('SECRET_KEY')).toBe('sk_value');
    expect(reader.optional('EMPTY')).toBeUndefined();
    expect(reader.optional('MISSING')).toBeUndefined();
    expect(reader.environment()).toBe('live');
    expect(reader.integer('TIMEOUT_MS')).toBe(15000);
  });

  it.each([
    ['a missing required variable', () => reader.required('MISSING'), 'APP_MISSING'],
    ['a blank required variable', () => reader.required('EMPTY'), 'APP_EMPTY'],
    ['an invalid environment', () => reader.environment('BAD_ENVIRONMENT'), 'APP_BAD_ENVIRONMENT'],
    ['a non-numeric integer', () => reader.integer('BAD_NUMBER'), 'APP_BAD_NUMBER'],
  ])('names the variable for %s and never echoes its value', (_label, run, variable) => {
    let error: unknown;
    try {
      run();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).message).toContain(`"${variable}"`);
    expect((error as ConfigurationError).details).toEqual({ variable });
    expect(JSON.stringify(error) + String(error)).not.toMatch(/production|15s/);
  });

  it.each(['lower', '1APP', 'APP-X', ''])('rejects the prefix %j', (prefix) => {
    expect(() => createEnvReader(env, prefix)).toThrow(ConfigurationError);
  });

  it('defaults to process.env without mutating it', () => {
    const before = { ...process.env };
    expect(defaultEnv()).toBe(process.env);
    createEnvReader(defaultEnv(), 'CULGATE_DOES_NOT_EXIST').optional('X');
    expect(process.env).toEqual(before);
  });
});
