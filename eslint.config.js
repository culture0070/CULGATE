import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Builds a rule that forbids importing the given workspace packages. */
const forbidImports = (patterns, message) => ({
  'no-restricted-imports': ['error', { patterns: [{ group: patterns, message }] }],
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.turbo/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain JavaScript (examples, scripts) runs on Node.js.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // NestJS injects by constructor parameter type, which needs real (not
    // type-only) imports so the class exists at runtime.
    files: ['examples/nestjs/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  // Package boundaries (see docs/architecture/overview.md).
  {
    files: ['packages/core/**/*.ts'],
    rules: forbidImports(
      ['@culgate/*', 'express', '@nestjs/*'],
      '@culgate/core must not depend on provider, SDK, or framework packages.',
    ),
  },
  {
    files: ['packages/provider-*/**/*.ts'],
    rules: forbidImports(
      ['@culgate/sdk', '@culgate/sdk/*', '@culgate/provider-*', 'express', '@nestjs/*'],
      'Provider packages may depend only on @culgate/core.',
    ),
  },
  {
    files: ['packages/express/src/**/*.ts', 'packages/nestjs/src/**/*.ts'],
    rules: forbidImports(
      ['@culgate/provider-*', '@culgate/core', '@culgate/core/*'],
      'Framework packages depend only on @culgate/sdk and their framework.',
    ),
  },
  {
    files: ['packages/sdk/src/**/*.ts'],
    rules: forbidImports(
      ['@culgate/provider-*', 'express', '@nestjs/*'],
      '@culgate/sdk must not depend on concrete providers or frameworks.',
    ),
  },
);
