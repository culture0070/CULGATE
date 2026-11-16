/**
 * Operations with a provider-neutral adapter contract. This list grows only
 * when a contract for the operation exists (customers, invoices, and payouts
 * are not modelled yet).
 */
export const OPERATIONS = [
  'payments.create',
  'payments.retrieve',
  'payments.cancel',
  'payments.capture',
  'refunds.create',
  'refunds.retrieve',
  'checkout.create',
  'checkout.retrieve',
  'checkout.expire',
  'webhooks.verify',
  'webhooks.normalize',
  'provider.request',
] as const;

export type Operation = (typeof OPERATIONS)[number];

export function isOperation(value: unknown): value is Operation {
  return typeof value === 'string' && (OPERATIONS as readonly string[]).includes(value);
}

/** What the caller intends to do. Unspecified dimensions are not evaluated. */
export interface CapabilityContext {
  operation: Operation;
  currency?: string;
  paymentMethod?: string;
  country?: string;
}

export type CapabilityResult =
  { readonly supported: true } | { readonly supported: false; readonly reason: string };

/**
 * Per-account capability description. `check` may depend on the account's
 * configuration and environment, not just the provider brand.
 */
export interface ProviderCapabilities {
  /** Operations supported in at least some context. */
  readonly operations: readonly Operation[];
  check(context: CapabilityContext): CapabilityResult;
}

export interface StaticCapabilitiesOptions {
  operations: readonly Operation[];
  /** When set, any other currency is unsupported. */
  currencies?: readonly string[];
  /**
   * When set, any other payment method is unsupported. Pass an object to give
   * each operation its own list; operations not listed are unrestricted.
   */
  paymentMethods?: readonly string[] | Readonly<Partial<Record<Operation, readonly string[]>>>;
}

/** A simple allow-list capability matrix; adapters may implement richer logic. */
export function createStaticCapabilities(options: StaticCapabilitiesOptions): ProviderCapabilities {
  const operations = Object.freeze([...options.operations]);
  const currencies = options.currencies && new Set(options.currencies);
  const methodsFor = (operation: Operation): readonly string[] | undefined => {
    const methods = options.paymentMethods;
    if (methods === undefined) return undefined;
    if (isStringList(methods)) return methods;
    return Object.hasOwn(methods, operation) ? methods[operation] : undefined;
  };
  return Object.freeze({
    operations,
    check(context: CapabilityContext): CapabilityResult {
      if (!operations.includes(context.operation)) {
        return { supported: false, reason: `operation "${context.operation}" is not available` };
      }
      if (currencies && context.currency !== undefined && !currencies.has(context.currency)) {
        return { supported: false, reason: `currency "${context.currency}" is not available` };
      }
      const paymentMethods = methodsFor(context.operation);
      if (
        paymentMethods &&
        context.paymentMethod !== undefined &&
        !paymentMethods.includes(context.paymentMethod)
      ) {
        return {
          supported: false,
          reason: `payment method "${context.paymentMethod}" is not available`,
        };
      }
      return { supported: true };
    },
  });
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}
