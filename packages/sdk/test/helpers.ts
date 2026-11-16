import type {
  BaseAccountConfig,
  Operation,
  ProviderDefinition,
  ProviderPaymentCreateInput,
} from '@culgate/core';
import { ConfigurationError, createStaticCapabilities } from '@culgate/core';

export interface OtherAccountConfig extends BaseAccountConfig {
  readonly provider: 'other';
  readonly apiKey: string;
}

/**
 * A second, differently-shaped provider (different credential field, status
 * vocabulary, and ID format) so tests can prove provider selection.
 */
export function otherProvider(options: { operations?: readonly Operation[] } = {}) {
  const calls: { accountId: string; input: ProviderPaymentCreateInput }[] = [];
  const definition: ProviderDefinition<OtherAccountConfig> = {
    name: 'other',
    parseConfig(raw, { accountId }) {
      if (typeof raw['apiKey'] !== 'string' || raw['apiKey'].length === 0) {
        throw new ConfigurationError(
          `Account "${accountId}" is missing required config key "apiKey".`,
          {
            accountId,
          },
        );
      }
      return {
        provider: 'other',
        apiKey: raw['apiKey'],
        environment: raw['environment'] as 'test',
      };
    },
    createAdapter({ accountId }) {
      return {
        capabilities: createStaticCapabilities({
          operations: options.operations ?? ['payments.create'],
          currencies: ['PHP', 'IDR'],
        }),
        payments: {
          async create(input) {
            calls.push({ accountId, input });
            const id = `OTHER-${calls.length}`;
            return {
              id,
              providerPaymentId: id,
              amount: input.amount,
              status: 'requires_action',
              providerStatus: 'REQUIRES_ACTION',
            };
          },
        },
      };
    },
  };
  return Object.assign(definition, { calls });
}
