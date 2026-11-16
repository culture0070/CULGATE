import { describe, expect, it } from 'vitest';
import {
  assertAdapterImplementsCapabilities,
  ConfigurationError,
  createStaticCapabilities,
  getOperationHandler,
  isOperation,
  type ProviderAdapter,
} from '../src/index.js';

describe('createStaticCapabilities', () => {
  const capabilities = createStaticCapabilities({
    operations: ['payments.create'],
    currencies: ['PHP'],
    paymentMethods: ['gcash'],
  });

  it('supports listed operations in listed contexts', () => {
    expect(capabilities.check({ operation: 'payments.create' })).toEqual({ supported: true });
    expect(
      capabilities.check({ operation: 'payments.create', currency: 'PHP', paymentMethod: 'gcash' }),
    ).toEqual({ supported: true });
  });

  it.each([
    [{ operation: 'payments.capture' } as const, 'operation "payments.capture"'],
    [{ operation: 'payments.create', currency: 'USD' } as const, 'currency "USD"'],
    [{ operation: 'payments.create', paymentMethod: 'card' } as const, 'payment method "card"'],
  ])('explains why %j is unsupported', (context, reason) => {
    const result = capabilities.check(context);
    expect(result.supported).toBe(false);
    expect(result).toHaveProperty('reason', expect.stringContaining(reason));
  });

  it('is unrestricted on dimensions it does not declare', () => {
    const open = createStaticCapabilities({ operations: ['payments.create'] });
    expect(open.check({ operation: 'payments.create', currency: 'USD' }).supported).toBe(true);
  });
});

describe('adapter contract helpers', () => {
  const adapter: ProviderAdapter = {
    capabilities: createStaticCapabilities({ operations: ['payments.create', 'refunds.create'] }),
    payments: { create: async () => ({}) as never },
  };

  it('finds implemented handlers only', () => {
    expect(getOperationHandler(adapter, 'payments.create')).toBeTypeOf('function');
    expect(getOperationHandler(adapter, 'payments.capture')).toBeUndefined();
    expect(getOperationHandler(adapter, 'refunds.create')).toBeUndefined();
  });

  it('rejects an adapter that claims an operation it does not implement', () => {
    expect(() =>
      assertAdapterImplementsCapabilities(adapter, { provider: 'fake', accountId: 'a' }),
    ).toThrow(ConfigurationError);
  });

  it('recognizes operations', () => {
    expect(isOperation('payments.create')).toBe(true);
    expect(isOperation('payments.teleport')).toBe(false);
  });
});
