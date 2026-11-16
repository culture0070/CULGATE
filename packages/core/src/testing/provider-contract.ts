import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { isOperation, OPERATIONS } from '../capabilities/index.js';
import type { AnyProviderDefinition } from '../contracts/index.js';
import { getOperationHandler } from '../contracts/index.js';
import { ConfigurationError } from '../errors/index.js';

export interface ProviderContractOptions {
  /** A complete, valid account config for this provider. */
  validConfig: Readonly<Record<string, unknown>>;
  /** Config keys the provider requires; removing any must fail validation. */
  requiredKeys: readonly string[];
  /** Secret values inside `validConfig` that must never become observable. */
  secrets: readonly string[];
}

/**
 * Framework-agnostic structural checks every provider must pass. Throws an
 * `AssertionError` on the first violation.
 *
 * This covers configuration handling, capability honesty, and credential
 * exposure. Behavioural checks (create/retrieve/refund against recorded
 * provider responses) are added alongside the first real adapter.
 */
export function assertProviderContract(
  provider: AnyProviderDefinition,
  options: ProviderContractOptions,
): void {
  const accountId = 'contract-account';
  const { validConfig, requiredKeys, secrets } = options;
  assert.ok(secrets.length > 0, 'options.secrets must list at least one secret value');

  assert.match(
    provider.name,
    /^[a-z][a-z0-9-]{0,31}$/,
    'provider name must be lowercase kebab-case',
  );
  assert.equal(
    validConfig['provider'],
    provider.name,
    'validConfig.provider must equal provider.name',
  );

  // Configuration: missing required keys fail with a ConfigurationError that
  // names the key and never echoes any configured value.
  for (const key of requiredKeys) {
    const incomplete = Object.fromEntries(Object.entries(validConfig).filter(([k]) => k !== key));
    let error: unknown;
    try {
      provider.parseConfig(Object.freeze(incomplete), { accountId });
    } catch (caught) {
      error = caught;
    }
    assert.ok(
      error instanceof ConfigurationError,
      `parseConfig must throw ConfigurationError when "${key}" is missing`,
    );
    assert.ok(error.message.includes(key), `the error for missing "${key}" must name the key`);
    assertNoSecrets(
      `the error for missing "${key}"`,
      [inspect(error, { depth: 10 }), JSON.stringify(error)],
      secrets,
    );
  }

  const frozen = Object.freeze({ ...validConfig });
  const config: unknown = provider.parseConfig(frozen, { accountId });
  const adapter = provider.createAdapter({ accountId, config });

  // Capability honesty.
  const declared = adapter.capabilities.operations;
  assert.ok(declared.length > 0, 'an adapter must support at least one operation');
  assert.equal(new Set(declared).size, declared.length, 'declared operations must be unique');
  for (const operation of declared) {
    assert.ok(isOperation(operation), `"${operation}" is not a CulGate operation`);
    assert.ok(
      getOperationHandler(adapter, operation),
      `"${operation}" is declared as supported but not implemented`,
    );
    assert.equal(
      adapter.capabilities.check({ operation }).supported,
      true,
      `check() must report declared operation "${operation}" as supported when no context is given`,
    );
  }
  for (const operation of OPERATIONS.filter((candidate) => !declared.includes(candidate))) {
    const result = adapter.capabilities.check({ operation });
    assert.equal(
      result.supported,
      false,
      `check() must reject undeclared operation "${operation}"`,
    );
    assert.ok(
      !result.supported && result.reason.length > 0,
      `check() must explain why "${operation}" is unsupported`,
    );
  }

  // Credential exposure and account isolation.
  const deep = { depth: Infinity, showHidden: true, getters: true };
  assertNoSecrets('the adapter', [inspect(adapter, deep), JSON.stringify(adapter) ?? ''], secrets);
  const second = provider.createAdapter({ accountId: 'contract-account-2', config });
  assert.notEqual(adapter, second, 'each account must get its own adapter instance');
}

function assertNoSecrets(
  subject: string,
  outputs: readonly string[],
  secrets: readonly string[],
): void {
  for (const secret of secrets) {
    assert.ok(
      outputs.every((output) => !output.includes(secret)),
      `${subject} exposes a configured secret`,
    );
  }
}
