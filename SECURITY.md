# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: the repository's
**Security** tab > **Report a vulnerability**. Include the MendCode version (`mendcode --version`), the platform, and the
smallest steps that show the problem.

You will get an answer within seven days. A confirmed problem is fixed in a release before it is described publicly, and
the report credits you unless you ask otherwise.

## Supported versions

Only the latest release gets security fixes while MendCode is at 0.x.

## What MendCode protects, and what it does not

The [security model](README.md#security-model) in the README lists what is enforced: the permission engine, local-only
guards for remote access, secret markers and the script-workflow sandbox. Extensions, views and packages run with your
own permissions and are not sandboxed ([views](docs/views.md#how-custom-code-is-isolated)); installing one is trusting
its author.
