---
name: mendcode-session-guardrails
description: Use at the start of every task in the MendCode repository. Enforces local-only work, risk-based validation, minimal changes, and protection of disk, memory, CPU, and TUI rendering. Load this skill before inspecting or editing code, docs, config, tests, or runtime files.
export: false
---

# MendCode Session Guardrails

Apply these rules to every task in this repository unless the user explicitly overrides a specific rule.

## GitHub and external writes

- Work locally by default. Never run `git push`, create, update, merge, or close GitHub PRs/issues, publish releases/packages, upload artifacts, or post GitHub comments.
- A direct user request authorizes only that specific external write. Otherwise stop before it and ask.
- Read-only commands such as `git status`, `git diff`, branch inspection, or remote inspection are allowed when relevant.
- Do not create a commit unless the user explicitly asks for one.

## Scope and non-regression

- Inspect the worktree before editing. Preserve unrelated changes; never reset, clean, revert, or overwrite them.
- Read the relevant callers, tests, configuration, and nearby patterns before changing behavior.
- Make the smallest patch that solves the requested problem. Avoid broad refactors, dependency changes, generated output, migrations, or public API changes unless they are required.
- Do not claim that MendCode is safe merely because a change is small: check imports, data flow, error paths, and affected callers.
- For TUI/runtime work, preserve state ownership and event flow. Do not introduce render loops, duplicate subscriptions, unstable keys, unbounded concurrency, or unnecessary rerenders.

## Tests and validation

- For executable behavior, run the narrowest relevant test, typecheck, lint, or runtime smoke check after editing.
- For a genuinely tiny non-executable change (for example, a skill, documentation, or formatting-only edit), skip the full test suite and validate the file format, frontmatter, and focused diff instead.
- Treat configuration changes as executable when they can alter runtime behavior; validate them accordingly.
- Do not run a full build or full test suite by habit. Expand validation only when the risk or repository workflow requires it, or the user asks.
- Report every check that actually ran and clearly state checks that were intentionally skipped.

## Disk, memory, CPU, and rendering budget

- Prefer targeted reads/searches and bounded commands over full-repository scans, large logs, or repeated whole-file rewrites.
- Do not create unnecessary generated files, caches, dumps, screenshots, or temporary artifacts; clean up anything required for validation.
- Avoid unbounded loops, polling, watchers, retries, uncontrolled parallelism, and duplicate work.
- Keep memory and CPU usage bounded with pagination, lazy work, bounded concurrency, and existing caches/abstractions where appropriate.
- For UI/TUI changes, avoid rendering entire histories or large collections when only a visible/changed slice is needed.
- If a change could affect performance or resource usage, inspect and validate that path specifically instead of assuming it is harmless.

## Stop conditions and reporting

- Ask before destructive actions, production/billing changes, security-impacting changes, or material scope expansion.
- Before finishing, inspect only the relevant diff and confirm no accidental artifacts or unrelated files were changed.
- Report concisely: changed files, real validation results, skipped checks, blockers, and non-goals.
