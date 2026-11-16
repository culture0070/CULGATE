import { describe, expect, it } from 'vitest';
import {
  assertValidMoney,
  fromDecimal,
  getCurrencyExponent,
  toDecimalString,
  ValidationError,
} from '../src/index.js';

describe('currency exponents', () => {
  it('does not assume two decimal places', () => {
    expect(getCurrencyExponent('PHP')).toBe(2);
    expect(getCurrencyExponent('JPY')).toBe(0);
    expect(getCurrencyExponent('VND')).toBe(0);
  });

  it.each(['php', 'XXX', '', 'constructor', '__proto__'])('rejects %j', (currency) => {
    expect(() => getCurrencyExponent(currency)).toThrow(ValidationError);
  });
});

describe('assertValidMoney', () => {
  it('accepts integer minor units', () => {
    expect(() => assertValidMoney({ value: 150000, currency: 'PHP' })).not.toThrow();
    expect(() => assertValidMoney({ value: 0, currency: 'PHP' })).not.toThrow();
  });

  it.each([
    ['float', { value: 1500.5, currency: 'PHP' }],
    ['numeric string', { value: '150000', currency: 'PHP' }],
    ['unsafe integer', { value: Number.MAX_SAFE_INTEGER + 1, currency: 'PHP' }],
    ['NaN', { value: Number.NaN, currency: 'PHP' }],
    ['negative', { value: -1, currency: 'PHP' }],
    ['unknown currency', { value: 100, currency: 'ZZZ' }],
    ['missing currency', { value: 100 }],
    ['null', null],
    ['number', 150000],
  ])('rejects %s', (_label, input) => {
    expect(() => assertValidMoney(input)).toThrow(ValidationError);
  });

  it('rejects zero only when a positive amount is required', () => {
    expect(() => assertValidMoney({ value: 0, currency: 'PHP' }, { positive: true })).toThrow(
      ValidationError,
    );
  });

  it('reports the offending path', () => {
    try {
      assertValidMoney({ value: 1.5, currency: 'PHP' }, { path: 'refund.amount' });
      expect.unreachable();
    } catch (error) {
      expect((error as ValidationError).issues[0]?.path).toBe('refund.amount.value');
    }
  });
});

describe('toDecimalString', () => {
  it.each([
    [{ value: 150000, currency: 'PHP' }, '1500.00'],
    [{ value: 1500, currency: 'USD' }, '15.00'],
    [{ value: 5, currency: 'PHP' }, '0.05'],
    [{ value: 0, currency: 'PHP' }, '0.00'],
    [{ value: 1500, currency: 'JPY' }, '1500'],
    [{ value: Number.MAX_SAFE_INTEGER, currency: 'PHP' }, '90071992547409.91'],
  ])('%j => %s', (money, expected) => {
    expect(toDecimalString(money)).toBe(expected);
  });
});

describe('fromDecimal', () => {
  it.each([
    ['1500.00', 'PHP', 150000],
    ['1500', 'PHP', 150000],
    ['1500.5', 'PHP', 150050],
    [1500.5, 'PHP', 150050],
    [0.1, 'PHP', 10],
    ['0.29', 'USD', 29], // 0.29 * 100 === 28.999999999999996 in floating point
    ['1500.000', 'PHP', 150000],
    ['1500', 'JPY', 1500],
    ['1500.0', 'JPY', 1500],
  ] as const)('%j %s => %i', (amount, currency, expected) => {
    expect(fromDecimal(amount, currency)).toEqual({ value: expected, currency });
  });

  it.each([
    ['excess precision', '1500.005', 'PHP'],
    ['fraction on zero-decimal currency', '1500.5', 'JPY'],
    ['negative', '-1.00', 'PHP'],
    ['exponent notation', '1e3', 'PHP'],
    ['exponent-formatted number', 1e21, 'PHP'],
    ['infinity', Number.POSITIVE_INFINITY, 'PHP'],
    ['garbage', 'abc', 'PHP'],
    ['empty', '', 'PHP'],
    ['beyond safe integers', '90071992547409.92', 'PHP'],
  ] as const)('rejects %s instead of rounding', (_label, amount, currency) => {
    expect(() => fromDecimal(amount, currency)).toThrow(ValidationError);
  });

  it('round-trips with toDecimalString', () => {
    const money = { value: 123456789, currency: 'PHP' };
    expect(fromDecimal(toDecimalString(money), 'PHP')).toEqual(money);
  });
});
