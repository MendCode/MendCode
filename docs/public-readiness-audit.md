# Public Readiness Audit

This file records the current public-readiness checks done for this repo before publishing broader MendCode docs.

## Repository and Branches

Verified remote:

```text
origin https://github.com/MendCode/MendCode.git
```

Verified remote heads after cleanup:

```text
main
dev
```

Dependabot PR #49 was closed and its branch was deleted during branch cleanup. Its security-relevant package updates were then applied manually to this release line so `dev` and `main` do not publish with the same Dependabot alerts.

Open PRs at cleanup time: none.

## Secret / Config Audit

Tracked `.agents`, `.mendcode`, `.env`, `.env.local`, `.envrefs`, and `src/mendcode/.mendcode` files:

```text
none tracked
```

Static grep over the publicable working tree found no plausible live provider keys matching common live-key families such as OpenAI-style API keys, GitHub personal access tokens, Slack tokens, AWS access keys, or private-key block headers.

Expected non-secret hits remain:

- workflow references to `${{ secrets.* }}`
- code variables named `token`, `secret`, `password`, `access_token`, `refresh_token`
- database schema columns for tokens/secrets
- SST/infra resources that reference managed secret providers
- tests that mutate fake lock tokens

Scanner results on a temporary tree made from tracked files plus new untracked docs:

```text
gitleaks v8.30.1: no leaks found
trufflehog v3.95.5: verified_secrets=0, unverified_secrets=0
```

## Dependency Alerts

Open Dependabot alerts on `main` before the final dependency patch covered:

- `esbuild` in `src/mendcode/sdks/vscode/package.json`
- `dompurify` in `src/mendcode/packages/ui/package.json`
- `@hono/node-server` in `src/mendcode/packages/opencode/package.json`
- `minimatch` in `src/mendcode/packages/opencode/package.json`
- `turbo` in `src/mendcode/package.json`

The release line updates those direct package declarations to the patched versions reported by GitHub. `src/mendcode/packages/core/package.json` already used a newer fixed `minimatch` version and was intentionally left unchanged.

History scan note: reachable Git history contains fake/test placeholders that intentionally look like keys, including old memory redaction tests and old docs examples. They do not appear to be live credentials, but they are still public key-shaped strings in history. If the public requirement is "zero key-shaped strings anywhere in all historical commits", rewrite/scrub history before release.

## Old Repository References

Fixed active script defaults that still pointed to the old repository:

- `src/mendcode/script/raw-changelog.ts`
- `src/mendcode/script/stats.ts`

Known remaining donor/upstream references are intentional context, not MendCode repo links:

- `anomalyco/opencode` references in donor/runtime guard tests and upstream patch metadata.
- Legacy mflow integration repository references and public relay labels.

Public Git history/PR metadata still includes old branch names and merge messages:

- PR #42 / #43 used head branch `codex/mendcode-cli-prune-and-github-install`.
- Git history includes merge commits that mention that branch name.

This is not an active source-file reference after the patch, but it is public GitHub metadata unless history and PR metadata are cleaned externally.

Public MendCode install and issue links should use:

```text
https://github.com/MendCode/MendCode
```
