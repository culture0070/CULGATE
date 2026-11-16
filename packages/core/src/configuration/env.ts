import { ConfigurationError } from '../errors/index.js';
import type { Environment } from './index.js';
import { ENVIRONMENTS } from './index.js';

/** A source of environment variables, e.g. `process.env`. Never mutated. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface AccountEnvOptions {
  /**
   * Variable name prefix. Use a different prefix per account, e.g.
   * `PAYMONGO_SECONDARY` reads `PAYMONGO_SECONDARY_SECRET_KEY`.
   */
  prefix?: string;
  /** Defaults to `process.env`. CulGate never loads `.env` files itself. */
  env?: EnvSource;
}

const PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Reads variables under one prefix. Error messages name the variable and
 * never include its value.
 */
export function createEnvReader(env: EnvSource, prefix: string) {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new ConfigurationError(
      'Invalid environment variable prefix. Use uppercase letters, digits, and underscores.',
      { code: 'invalid_env_prefix' },
    );
  }
  const nameOf = (suffix: string) => `${prefix}_${suffix}`;
  const optional = (suffix: string): string | undefined => {
    const value = env[nameOf(suffix)]?.trim();
    return value ? value : undefined;
  };
  const fail = (suffix: string, problem: string) =>
    new ConfigurationError(`Environment variable "${nameOf(suffix)}" ${problem}`, {
      code: 'invalid_env',
      details: { variable: nameOf(suffix) },
    });

  return {
    nameOf,
    optional,
    required(suffix: string): string {
      const value = optional(suffix);
      if (value === undefined) throw fail(suffix, 'is required but not set.');
      return value;
    },
    environment(suffix = 'ENVIRONMENT'): Environment | undefined {
      const value = optional(suffix);
      if (value === undefined) return undefined;
      const environment = ENVIRONMENTS.find((candidate) => candidate === value);
      if (!environment) throw fail(suffix, 'must be "test" or "live".');
      return environment;
    },
    integer(suffix: string): number | undefined {
      const value = optional(suffix);
      if (value === undefined) return undefined;
      if (!/^\d+$/.test(value)) throw fail(suffix, 'must be a whole number.');
      return Number(value);
    },
    fail,
  };
}

/** `process.env` when running on Node.js, otherwise an empty source. */
export function defaultEnv(): EnvSource {
  const { process } = globalThis as { process?: { env?: EnvSource } };
  return process?.env ?? {};
}
