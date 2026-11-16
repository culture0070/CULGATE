import { describe, expect, it } from 'vitest';
import { ConfigurationError, ProviderRegistry } from '../src/index.js';
import { mockProvider } from '../src/testing/index.js';

describe('ProviderRegistry', () => {
  it('registers and returns providers by name', () => {
    const provider = mockProvider();
    const registry = new ProviderRegistry([provider]);
    expect(registry.has('mock')).toBe(true);
    expect(registry.get('mock')).toBe(provider);
    expect(registry.names()).toEqual(['mock']);
  });

  it('rejects duplicate provider names', () => {
    expect(() => new ProviderRegistry([mockProvider(), mockProvider()])).toThrow(
      /already registered/,
    );
  });

  it('rejects invalid provider names', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register({ ...mockProvider(), name: 'Not Valid' as 'mock' })).toThrow(
      ConfigurationError,
    );
  });

  it('names the registered providers when one is unknown', () => {
    const registry = new ProviderRegistry([mockProvider()]);
    expect(() => registry.get('paymongo')).toThrow(/"paymongo" is not registered.*mock/);
    expect(() => registry.get('toString')).toThrow(ConfigurationError);
  });
});
