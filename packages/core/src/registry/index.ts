import type { AnyProviderDefinition } from '../contracts/index.js';
import { ConfigurationError } from '../errors/index.js';

const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Holds the provider definitions available to one SDK instance. */
export class ProviderRegistry {
  readonly #providers = new Map<string, AnyProviderDefinition>();

  constructor(providers: Iterable<AnyProviderDefinition> = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: AnyProviderDefinition): this {
    const name: unknown = provider?.name;
    if (typeof name !== 'string' || !PROVIDER_NAME_PATTERN.test(name)) {
      throw new ConfigurationError(
        'Invalid provider name. Expected lowercase letters, digits, and hyphens.',
        { code: 'invalid_provider' },
      );
    }
    if (this.#providers.has(name)) {
      throw new ConfigurationError(`Provider "${name}" is already registered.`, {
        code: 'duplicate_provider',
        provider: name,
      });
    }
    this.#providers.set(name, provider);
    return this;
  }

  has(name: string): boolean {
    return this.#providers.has(name);
  }

  get(name: string): AnyProviderDefinition {
    const provider = this.#providers.get(name);
    if (!provider) {
      const known = this.names().join(', ') || 'none';
      throw new ConfigurationError(
        `Provider "${name}" is not registered. Registered providers: ${known}. ` +
          'Pass the provider to `new PaymentSDK({ providers: [...] })`.',
        { code: 'unknown_provider', provider: name },
      );
    }
    return provider;
  }

  names(): string[] {
    return [...this.#providers.keys()];
  }
}
