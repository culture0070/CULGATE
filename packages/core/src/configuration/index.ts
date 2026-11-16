export const ENVIRONMENTS = ['test', 'live'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Fields every account config shares. Credentials are deliberately NOT part
 * of this type: each provider defines its own credential fields.
 */
export interface BaseAccountConfig {
  readonly provider: string;
  readonly environment: Environment;
}

/** Non-sensitive description of a configured account. Safe to log. */
export interface AccountInfo {
  readonly id: string;
  readonly provider: string;
  readonly environment: Environment;
}
