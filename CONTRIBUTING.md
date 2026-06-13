# Contributing to MendCode

Thanks for helping improve MendCode. This project is public, but it is still moving quickly, so good issues and focused pull requests matter more than large drive-by rewrites.

## Before You Start

- Search existing issues and discussions first.
- Open an issue for large behavior changes before investing in a pull request.
- Keep pull requests narrow. One fix or feature per PR is easiest to review.
- Do not include secrets, local config, private prompts, or generated credentials.

## Development Setup

Source lives under `src/mendcode`.

```bash
cd src/mendcode
bun install
bun dev
```

The root repository is a public wrapper around the MendCode source tree, docs, installer, and community files. Most runtime commands should be run from `src/mendcode` or from a specific package directory.

Useful commands:

```bash
cd src/mendcode
bun run --cwd packages/opencode --conditions=browser src/index.ts
bun run --cwd packages/opencode test
bun run --cwd packages/opencode typecheck
bun run release:check-assets
```

## Pull Requests

Every PR should include:

- What changed and why.
- How you tested it.
- Screenshots or recordings for TUI/UI changes when practical.
- Any known limitations or follow-up work.

Do not mix formatting-only edits with behavior changes unless formatting is the point of the PR.

## Commit Style

Use short conventional commit-style messages:

```text
fix: handle missing setup config
docs: add package sharing guide
feat: add TUI widget slot
chore: update release metadata
```

## Tests

Run the smallest test set that proves the change, then broaden when the change touches shared contracts.

Examples:

```bash
cd src/mendcode/packages/opencode
bun test test/mend/memory.test.ts
bun test test/cli/tui/plugin-loader.test.ts
bun run typecheck
```

Release asset checks:

```bash
cd src/mendcode
bun run release:assets
bun run release:check-assets
```

## Security

Do not open public issues for private vulnerabilities or leaked credentials. Follow [SECURITY.md](SECURITY.md).

## Attribution

MendCode is downstream work built on the opencode codebase with substantial MendCode-owned runtime, CLI, setup, package, coordination, and TUI customization layers. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
