import { ValidationError } from '../errors/index.js';

/** An amount in the currency's minor unit (PHP 1,500.00 => 150000). */
export interface Money {
  /** Non-negative safe integer in the currency's minor unit. */
  readonly value: number;
  /** Uppercase ISO 4217 code. */
  readonly currency: string;
}

/**
 * ISO 4217 minor-unit exponents for currencies CulGate accepts.
 *
 * The canonical model follows ISO 4217. Where a provider deviates (for
 * example by treating a two-decimal currency as zero-decimal), that
 * conversion belongs to the provider adapter, not here.
 */
const CURRENCY_EXPONENTS: ReadonlyMap<string, number> = new Map([
  ['PHP', 2],
  ['IDR', 2],
  ['MYR', 2],
  ['SGD', 2],
  ['THB', 2],
  ['VND', 0],
  ['USD', 2],
  ['EUR', 2],
  ['GBP', 2],
  ['AUD', 2],
  ['HKD', 2],
  ['JPY', 0],
  ['KRW', 0],
]);

export function supportedCurrencies(): string[] {
  return [...CURRENCY_EXPONENTS.keys()];
}

export function isSupportedCurrency(currency: unknown): currency is string {
  return typeof currency === 'string' && CURRENCY_EXPONENTS.has(currency);
}

/** Number of minor-unit decimal places for `currency`. Throws if unsupported. */
export function getCurrencyExponent(currency: string, path = 'currency'): number {
  const exponent = CURRENCY_EXPONENTS.get(currency);
  if (exponent === undefined) {
    throw invalid(path, `Unsupported currency. Expected an uppercase ISO 4217 code such as "PHP".`);
  }
  return exponent;
}

export interface MoneyValidationOptions {
  /** Input path used in error messages. Defaults to `amount`. */
  path?: string;
  /** Require a value greater than zero. */
  positive?: boolean;
}

/** Validates an untrusted value as {@link Money}. Never rounds or coerces. */
export function assertValidMoney(
  input: unknown,
  options: MoneyValidationOptions = {},
): asserts input is Money {
  const path = options.path ?? 'amount';
  if (typeof input !== 'object' || input === null) {
    throw invalid(path, 'Expected an object with integer `value` and `currency`.');
  }
  const { value, currency } = input as { value?: unknown; currency?: unknown };
  if (typeof currency !== 'string') {
    throw invalid(`${path}.currency`, 'Expected a currency code string.');
  }
  getCurrencyExponent(currency, `${path}.currency`);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(
      `${path}.value`,
      'Expected a safe integer in the minor unit of the currency (e.g. 150000 for PHP 1,500.00).',
    );
  }
  if (value < 0) throw invalid(`${path}.value`, 'Must not be negative.');
  if (options.positive && value === 0) throw invalid(`${path}.value`, 'Must be greater than zero.');
}

/**
 * Formats minor units as a major-unit decimal string using integer/string
 * operations only: `{ value: 150000, currency: 'PHP' }` => `"1500.00"`.
 */
export function toDecimalString(money: Money): string {
  assertValidMoney(money);
  const exponent = getCurrencyExponent(money.currency);
  if (exponent === 0) return String(money.value);
  const digits = String(money.value).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a provider's major-unit amount into minor units without floating
 * point arithmetic. Rejects (never rounds) amounts with more precision than
 * the currency allows, negative amounts, and exponent notation.
 */
export function fromDecimal(amount: string | number, currency: string, path = 'amount'): Money {
  const exponent = getCurrencyExponent(currency);
  if (typeof amount === 'number' && !Number.isFinite(amount)) {
    throw invalid(path, 'Expected a finite decimal amount.');
  }
  const match = DECIMAL_PATTERN.exec(typeof amount === 'number' ? String(amount) : amount);
  if (!match) throw invalid(path, 'Expected a non-negative plain decimal amount.');
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (/[1-9]/.test(fraction.slice(exponent))) {
    throw invalid(path, `Too many decimal places for ${currency} (maximum ${exponent}).`);
  }
  const minor = BigInt(whole + fraction.slice(0, exponent).padEnd(exponent, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid(path, 'Amount exceeds the safe integer range.');
  }
  return { value: Number(minor), currency };
}

function invalid(path: string, message: string): ValidationError {
  return new ValidationError(`Invalid ${path}: ${message}`, { issues: [{ path, message }] });
}
