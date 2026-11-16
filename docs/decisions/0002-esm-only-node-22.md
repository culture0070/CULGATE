# ADR 0002: ESM-only packages, Node.js >= 22.12

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

The plan suggested Node.js 20+ and "ESM-first", with CommonJS support if advertised. Node.js 20
reached end of life in April 2026. Publishing dual ESM/CJS builds creates the dual-package hazard:
two copies of the error classes, so `instanceof UnsupportedOperationError` can silently fail.

## Decision

Publish ESM only, compiled with plain `tsc`, and require Node.js >= 22.12 — the first release line
where `require()` of an ES module works without a flag. CI tests Node 22 and 24.

## Alternatives considered

- **Dual ESM + CJS via tsup.** Wider compatibility on EOL runtimes at the cost of the dual-package
  hazard and a bundler in the build.
- **CJS only.** Poor fit for modern tooling and tree shaking.

## Consequences

- CommonJS applications (including typical NestJS setups) can still `require('@culgate/sdk')` on
  supported Node versions; this must be verified by a packed-consumer test before first release.
- Applications on Node < 22.12 are not supported.
- No bundler: the published files mirror the source modules.
