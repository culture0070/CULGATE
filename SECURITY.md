# Security policy

## Reporting a vulnerability

Please report security issues privately. **Do not open a public issue.**

Use the repository's private vulnerability reporting (the **Security** tab, then **Report a
vulnerability**). Include what you found, how to reproduce it, and the affected package and
version. You will get an acknowledgement, and updates as the report is investigated.

Never include real API keys, webhook secrets, or customer data in a report. If a key may have been
exposed, rotate it with the provider first.

## Supported versions

Security fixes are made to the latest released version.

## Scope

In scope: the `@culgate/*` packages in this repository, in particular anything that could

- expose credentials (in logs, errors, serialized objects, or to another host),
- let a webhook be accepted without valid authentication,
- cause a request to be sent to a host other than the configured provider,
- cause a payment or refund to be created more than once without the caller asking, or
- misreport an unpaid payment as paid.

Out of scope: vulnerabilities in the payment providers themselves (report those to the provider),
and issues that require an attacker to already control the application's configuration or process.

## What CulGate does and does not do

- CulGate is a library. It runs inside your application with your credentials; there is no CulGate
  service and nothing is sent anywhere except to the payment provider you configure.
- CulGate does not collect, transmit, or store card numbers. Card payments go through the
  provider's hosted checkout page.
- CulGate is not PCI DSS certified, and using it does not make an application compliant. Your PCI
  scope is determined by how you integrate with your provider.
