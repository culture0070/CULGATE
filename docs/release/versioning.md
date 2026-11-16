# Versioning and migration policy

## Versions

CulGate follows [semantic versioning](https://semver.org). All `@culgate/*` packages are released
together with the same version number, so any set of packages with the same version is known to
work together. Install matching versions.

While the version is `0.x`, the API is not yet stable: a minor release (`0.2.0`) may contain
breaking changes, and a patch release (`0.1.1`) will not. From `1.0.0`, breaking changes require a
major release.

## What counts as breaking

- Removing or renaming an export, method, option, or field.
- Changing the type or meaning of an input or returned field.
- Mapping an existing provider status or event to a **different** normalized value.
- Raising the minimum supported Node.js version.
- Requiring configuration that was optional.

Not breaking:

- Adding an export, method, optional input, or field.
- Adding a value to a status or event union. **Handle unknown values**: a `switch` over
  `payment.status` or `event.type` needs a default branch.
- Mapping a provider status or event that was previously `unknown` / `provider.unknown` to a
  specific value.
- Adding a provider, payment method, or capability.
- Changes to `raw` payloads, which belong to the provider.
- Changes to error message text. Depend on `code` and `providerCode`.

## Provider API changes

Each adapter targets a provider API version recorded in its guide, with the date the documentation
was read. When a provider changes its API, the adapter is updated in a normal release and the
change is described in the changelog.

## Deprecation

Before something is removed it is marked `@deprecated` in its documentation comment, with the
replacement, and listed in the changelog. From `1.0.0`, a deprecated API stays for at least one
further minor release and is removed only in a major release.

## Node.js support

CulGate supports Node.js releases that are in active or maintenance LTS and can `require()` ES
modules without a flag; today that is Node.js 22.12 or newer. Dropping a Node.js version is a
breaking change.

## Changelog

Changes are recorded with [Changesets](https://github.com/changesets/changesets) and published in
each package's `CHANGELOG.md`.
