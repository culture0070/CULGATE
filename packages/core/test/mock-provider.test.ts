import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  createStaticCapabilities,
  OPERATIONS,
  type ProviderDefinition,
} from '../src/index.js';
import { assertProviderContract, mockProvider } from '../src/testing/index.js';

const SECRET = 'mock-secret-value';
const contract = {
  validConfig: { provider: 'mock', secretKey: SECRET, environment: 'test' },
  requiredKeys: ['secretKey'],
  secrets: [SECRET],
};

describe('assertProviderContract', () => {
  it('passes for the mock provider, in full and restricted configurations', () => {
    expect(() => assertProviderContract(mockProvider(), contract)).not.toThrow();
    expect(() =>
      assertProviderContract(mockProvider({ operations: ['payments.create'] }), contract),
    ).not.toThrow();
  });

  it('declares every CulGate operation by default when webhooks are configured', () => {
    const provider = mockProvider();
    const config = provider.parseConfig(
      { ...contract.validConfig, webhookSecret: 'mock-webhook-secret' },
      { accountId: 'a' },
    );
    expect(provider.createAdapter({ accountId: 'a', config }).capabilities.operations).toEqual(
      OPERATIONS,
    );
  });

  // Each broken provider below violates exactly one rule the checker enforces.
  const base = mockProvider();
  const broken: [string, ProviderDefinition, RegExp][] = [
    [
      'echoes a secret in a configuration error',
      {
        ...base,
        parseConfig: (raw) => {
          if (!raw['secretKey']) throw new ConfigurationError(`secretKey missing near ${SECRET}`);
          return base.parseConfig(raw, { accountId: 'a' });
        },
      },
      /exposes a configured secret/,
    ],
    [
      'accepts a config without its required key',
      { ...base, parseConfig: () => ({ provider: 'mock', secretKey: 'x', environment: 'test' }) },
      /must throw ConfigurationError when "secretKey" is missing/,
    ],
    [
      'declares an operation it does not implement',
      {
        ...base,
        createAdapter: () => ({
          capabilities: createStaticCapabilities({ operations: ['payments.create'] }),
        }),
      },
      /declared as supported but not implemented/,
    ],
    [
      'reports an undeclared operation as supported',
      {
        ...base,
        createAdapter: (context) => ({
          ...base.createAdapter(context as never),
          capabilities: { operations: ['payments.create'], check: () => ({ supported: true }) },
        }),
      },
      /must reject undeclared operation/,
    ],
    [
      'keeps the secret on the adapter object',
      {
        ...base,
        createAdapter: (context) =>
          Object.assign(base.createAdapter(context as never), { config: context.config }),
      },
      /the adapter exposes a configured secret/,
    ],
  ];

  it.each(broken)('fails a provider that %s', (_label, provider, message) => {
    expect(() => assertProviderContract(provider, contract)).toThrow(message);
  });
});
