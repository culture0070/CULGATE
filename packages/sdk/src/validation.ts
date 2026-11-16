import type { ValidationIssue } from '@culgate/core';
import type { Money } from '@culgate/core';
import { assertValidMoney, ValidationError } from '@culgate/core';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function fail(path: string, message: string): never {
  const issues: ValidationIssue[] = [{ path, message }];
  throw new ValidationError(`Invalid ${path}: ${message}`, { issues });
}

export function assertInputObject(input: unknown): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('input', 'Expected an object.');
  }
}

export function optionalString(
  value: unknown,
  path: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) fail(path, 'Expected a non-empty string.');
  if (value.length > maxLength) fail(path, `Must be at most ${maxLength} characters.`);
  return value;
}

export function requiredString(value: unknown, path: string, maxLength: number): string {
  return optionalString(value, path, maxLength) ?? fail(path, 'Required.');
}

export function optionalHttpUrl(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !URL.canParse(value)) fail(path, 'Expected an absolute URL.');
  const { protocol } = new URL(value);
  if (protocol !== 'https:' && protocol !== 'http:') fail(path, 'Expected an http(s) URL.');
  return value;
}

/**
 * Copies caller metadata into a fresh object, rejecting non-plain objects and
 * keys that could pollute prototypes downstream.
 */
export function optionalMetadata(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'Expected a plain object.');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'Expected a plain object.');
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${path}.${key}`, 'Key is not allowed.');
    copy[key] = entry;
  }
  return copy;
}

/** Validates an optional positive amount and returns a fresh copy. */
export function optionalAmount(value: unknown, path: string): Money | undefined {
  if (value === undefined) return undefined;
  assertValidMoney(value, { path, positive: true });
  return { value: value.value, currency: value.currency };
}
