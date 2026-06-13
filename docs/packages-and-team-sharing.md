# Packages and Team Sharing

MendCode packages are reusable bundles of `.mendcode` configuration and extensions. They are the intended way for a team or company to share the same commands, agents, modes, prompts, TUI profile, widgets, model policy, permissions, and worktree policy.

## What a Package Can Include

Package artifacts can include:

- commands
- agents
- modes
- skills
- plugins
- prompts
- MCP config/files
- context files
- extensions/widgets/components/scripts
- TUI profile
- worktree policy
- model roles
- focus profile selection
- budget config
- memory config
- permissions config

Package manifests are read from:

- `mend-package.json`
- `.mendcode/package.json`

The generated runtime pack lives at:

- `.mendcode/runtime-pack.json`

Installed packages live under:

- `.mendcode/packages/installed/<id>`

Active package state lives in:

- `.mendcode/packages/state.json`

## Create a Local Package

```bash
mend packages create --id acme-standard --title "Acme Standard" --include all --version 1.0.0
```

Useful variants:

```bash
mend packages create --include skills,modes,plugins,tuiProfile
mend packages create --include all --exclude models,budget
mend packages status
mend packages list
```

## Install and Use Packages

```bash
mend packages sources
mend packages search acme
mend packages show acme-standard
mend packages install acme-standard
mend packages disable acme-standard
mend packages enable acme-standard
mend packages remove acme-standard
```

Disabling a package deselects it without deleting local project config. Removing a package deletes the installed package copy and updates package state.

## Share One Company Package

Recommended company flow:

1. Create a package repo, for example `github.com/acme/acme-mendcode-package`.
2. Put `mend-package.json` at the package root.
3. Put shareable artifacts under `.mendcode/`.
4. Do not include provider secrets, local tokens, `.env*`, `.mendcode/auth`, or machine-local state.
5. Add the repo as a registry source.
6. Install the package from each team checkout.

Example package manifest:

```json
{
  "version": 0,
  "id": "acme-standard",
  "packageVersion": "1.0.0",
  "title": "Acme Standard",
  "description": "Shared Acme MendCode commands, agents, prompts, TUI profile, and model policy.",
  "kind": "bundle",
  "channel": "team",
  "compatibility": {
    "mendcode": "^1.14.0",
    "runtimePack": "^0"
  },
  "artifacts": {
    "commands": [".mendcode/commands"],
    "agents": [".mendcode/agents"],
    "modes": [".mendcode/modes"],
    "skills": [".mendcode/skills"],
    "plugins": [".mendcode/plugins"],
    "prompts": [".mendcode/prompts"],
    "extensions": [".mendcode/widgets"],
    "tuiProfile": ".mendcode/tui/profile.json",
    "worktreePolicy": ".mendcode/worktree/policy.yaml"
  },
  "distribution": {
    "source": {
      "type": "github",
      "url": "https://github.com/acme/acme-mendcode-package.git"
    },
    "trust": {
      "signatureRequired": false
    }
  }
}
```

Add a registry source:

```bash
mend packages add-source acme --type github --url https://github.com/acme/acme-mendcode-package.git --channel team
mend packages search "" acme
mend packages install acme-standard
```

For private repos, use a private-git/team source and a credential environment variable. Credentials are not stored in `.mendcode/registry.json`.

## What Does Not Belong in Packages

Do not package:

- API keys
- OAuth refresh/access tokens
- `.env*`
- `.mendcode/auth`
- local DB files
- local mflow room secrets
- local run/cache artifacts
- unrelated repo source files

The package system has an allowlist and reports `secretsIncluded: false`, but package authors should still review the generated files before publishing.
