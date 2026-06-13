# Security Policy

## Reporting a Vulnerability

Please do not report private vulnerabilities, leaked credentials, or exploit details in public issues or discussions.

Use GitHub private vulnerability reporting when available:

```text
https://github.com/MendCode/MendCode/security/advisories/new
```

If private vulnerability reporting is unavailable, open a minimal issue that says you need a private security contact, without exploit details or secrets.

## What to Include

- Affected version, commit, or release.
- Platform and installation method.
- Reproduction steps with safe test data.
- Impact assessment.
- Whether the issue may expose credentials, files, command execution, model prompts, tool calls, or workspace data.

## Supported Versions

Security fixes target the latest public release and the current `main` branch.

## Secret Handling

Never paste real API keys, access tokens, SSH keys, `.env` files, private prompts, or company config into an issue, PR, discussion, or test fixture.

If you accidentally disclose a secret:

1. Revoke or rotate it immediately.
2. Report where it was exposed.
3. Do not rely on deletion from Git history as the only remediation.

## Maintainer Notes

The repository runs security guard checks for risky tracked files, invisible Unicode controls, secret scanning, dependency scanning, GitHub Actions review, and custom Semgrep rules.
