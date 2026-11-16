// Packs every publishable package, installs the tarballs into a clean
// project outside the workspace, and uses them the way an application would:
// from ESM, from CommonJS, and from TypeScript. Also checks what the tarballs
// contain. Run `pnpm build` first.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['core', 'sdk', 'provider-paymongo', 'provider-xendit', 'express', 'nestjs'];
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const work = mkdtempSync(join(tmpdir(), 'culgate-consumer-'));
const tarballs = join(work, 'tarballs');
const app = join(work, 'app');
mkdirSync(tarballs);
mkdirSync(app);

try {
  // 1. Pack. pnpm rewrites `workspace:` ranges to real versions.
  const files = {};
  for (const name of packages) {
    run('pnpm', ['pack', '--pack-destination', tarballs], join(root, 'packages', name));
  }
  for (const file of readdirSync(tarballs)) {
    const name = packages.find((candidate) => file.startsWith(`culgate-${candidate}-`));
    files[`@culgate/${name}`] = `file:${join(tarballs, file)}`;

    // 2. Inspect contents: only build output and metadata, nothing sensitive.
    const entries = run('tar', ['-tzf', join(tarballs, file)])
      .trim()
      .split('\n');
    const unexpected = entries.filter(
      (entry) => !/^package\/(dist\/.+\.(js|d\.ts)|package\.json|LICENSE|README\.md)$/.test(entry),
    );
    if (unexpected.length > 0) {
      throw new Error(`${file} contains unexpected files:\n  ${unexpected.join('\n  ')}`);
    }
    if (!entries.includes('package/LICENSE')) throw new Error(`${file} has no LICENSE`);
    if (entries.some((entry) => /test|fixture|\.env/i.test(entry.replace('/testing/', '/')))) {
      throw new Error(`${file} contains test or environment files`);
    }
    const manifest = JSON.parse(
      run('tar', ['-xzOf', join(tarballs, file), 'package/package.json']),
    );
    const ranges = JSON.stringify([manifest.dependencies, manifest.peerDependencies]);
    if (ranges.includes('workspace:')) throw new Error(`${file} still has workspace: ranges`);
    console.log(`packed ${manifest.name}@${manifest.version}: ${entries.length} files`);
  }

  // 3. Install into a clean project. `overrides` makes the tarballs satisfy
  //    the packages' dependencies on each other, which are not on a registry.
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'culgate-consumer',
        private: true,
        dependencies: {
          ...files,
          express: '^5.0.0',
          '@nestjs/common': '^12.0.0',
          '@nestjs/core': '^12.0.0',
          'reflect-metadata': '^0.2.2',
          rxjs: '^7.8.2',
        },
        devDependencies: { typescript: '~6.0', '@types/node': '^22', '@types/express': '^5' },
        overrides: files,
      },
      null,
      2,
    ),
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], app);

  // Core must not have pulled in anything.
  const coreManifest = JSON.parse(
    readFileSync(join(app, 'node_modules/@culgate/core/package.json'), 'utf8'),
  );
  if (Object.keys(coreManifest.dependencies ?? {}).length > 0) {
    throw new Error('@culgate/core must have no runtime dependencies');
  }

  const scenario = `
    const mock = mockProvider();
    const sdk = new PaymentSDK({
      providers: [mock, paymongo(), xendit()],
      accounts: {
        m: { provider: 'mock', secretKey: 'mock-secret', environment: 'test' },
        pm: { provider: 'paymongo', secretKey: 'sk_test_consumerCheck000', environment: 'test' },
        xn: { provider: 'xendit', secretKey: 'xendit-consumer-check', environment: 'test' },
      },
    });
    const payment = await sdk.payments.create({ account: 'm', amount: { value: 150000, currency: 'PHP' } });
    if (payment.accountId !== 'm' || payment.status !== 'pending') throw new Error('unexpected payment');
    try {
      await sdk.payments.capture({ account: 'pm', paymentId: 'pi_x' });
      throw new Error('capture should be unsupported');
    } catch (error) {
      // instanceof must hold across packages: one copy of the error classes.
      if (!(error instanceof UnsupportedOperationError)) throw error;
    }
    if (typeof paymentWebhook(sdk, { account: 'm' }) !== 'function') throw new Error('no handler');
    if (typeof PaymentModule.forRoot(sdk).module !== 'function') throw new Error('no module');
    if (JSON.stringify(sdk).includes('secret')) throw new Error('credential exposed');
  `;

  // 4. ESM
  writeFileSync(
    join(app, 'esm.mjs'),
    `import 'reflect-metadata';
import { PaymentSDK, UnsupportedOperationError } from '@culgate/sdk';
import { mockProvider } from '@culgate/core/testing';
import { paymongo } from '@culgate/provider-paymongo';
import { xendit } from '@culgate/provider-xendit';
import { paymentWebhook } from '@culgate/express';
import { PaymentModule } from '@culgate/nestjs';
${scenario}
console.log('ESM consumer OK');
`,
  );
  process.stdout.write(run('node', ['esm.mjs'], app));

  // 5. CommonJS, via require() of the ES modules
  writeFileSync(
    join(app, 'cjs.cjs'),
    `require('reflect-metadata');
const { PaymentSDK, UnsupportedOperationError } = require('@culgate/sdk');
const { mockProvider } = require('@culgate/core/testing');
const { paymongo } = require('@culgate/provider-paymongo');
const { xendit } = require('@culgate/provider-xendit');
const { paymentWebhook } = require('@culgate/express');
const { PaymentModule } = require('@culgate/nestjs');
(async () => {
${scenario}
  console.log('CommonJS consumer OK');
})().catch((error) => { console.error(error); process.exit(1); });
`,
  );
  process.stdout.write(run('node', ['cjs.cjs'], app));

  // 6. TypeScript: the published types resolve and enforce the API.
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2023',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
      },
      include: ['types.mts'],
    }),
  );
  writeFileSync(
    join(app, 'types.mts'),
    `import { PaymentSDK, type Payment, type CheckoutSession } from '@culgate/sdk';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
import { xendit } from '@culgate/provider-xendit';
import { paymentWebhook } from '@culgate/express';

const sdk = new PaymentSDK({
  providers: [paymongo(), xendit()],
  accounts: {
    pm: paymongoAccountFromEnv({ env: { PAYMONGO_SECRET_KEY: 'sk_test_x' } }),
    xn: { provider: 'xendit', secretKey: 'x', environment: 'test', webhookToken: 't' },
  },
});
export const payment: Promise<Payment> = sdk.payments.create({
  account: 'pm',
  amount: { value: 100, currency: 'PHP' },
});
export const session: Promise<CheckoutSession> = sdk.checkout.create({
  account: 'xn',
  lineItems: [{ name: 'x', quantity: 1, amount: { value: 100, currency: 'PHP' } }],
});
export const handler = paymentWebhook(sdk, { account: 'xn' });

// @ts-expect-error unknown account IDs are compile errors
void sdk.payments.retrieve({ account: 'nope', paymentId: 'x' });
// @ts-expect-error a PayMongo account does not take Xendit's webhookToken
new PaymentSDK({ providers: [paymongo()], accounts: { a: { provider: 'paymongo', secretKey: 'k', environment: 'test', webhookToken: 't' } } });
// @ts-expect-error account is required
void sdk.refunds.create({ paymentId: 'x' });
`,
  );
  run('npx', ['tsc', '-p', 'tsconfig.json'], app);
  console.log('TypeScript consumer OK');
  console.log('Consumer test passed.');
} catch (error) {
  console.error(error.stdout ?? '', error.stderr ?? '');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
