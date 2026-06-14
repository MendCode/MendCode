# Packages and Team Sharing

MendCode packages are reusable bundles of `.mendcode` configuration and extensions. They are the intended way for a team or company to share the same commands, agents, modes, prompts, TUI profile, widgets, model policy, permissions, and worktree policy.

The mental model is “package your harness,” not “publish a plugin.” A package can make a fresh checkout feel like the team environment: the same command palette, review modes, model roles, permission posture, prompt marker, status row, memory defaults, and optional worktree policy.

## Good Package Examples

| Package | Includes | Does not include |
| --- | --- | --- |
| Team standard | commands, agents, modes, skills, focus default, model roles, permission defaults, TUI profile. | Provider tokens, local auth files, personal memory. |
| Review mode bundle | review agent, review mode, prompt templates, stricter permission mode, review model role. | Branch mutations or CI credentials. |
| UI theme | TUI profile, theme tokens, prompt chrome, status script, widgets. | Runtime service activation. |
| MCP bundle | MCP server config/files, commands, docs/context files. | Secrets required by the MCP server. |
| Worktree policy | worktree policy, package docs, optional TSM hints. | Destructive worktree operations at install time. |

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
mendcode packages create --id acme-standard --title "Acme Standard" --include all --version 1.0.0
```

Useful variants:

```bash
mendcode packages create --include skills,modes,plugins,tuiProfile
mendcode packages create --include all --exclude models,budget
mendcode packages status
mendcode packages list
```

## Install and Use Packages

```bash
mendcode packages sources
mendcode packages search acme
mendcode packages show acme-standard
mendcode packages install acme-standard
mendcode packages disable acme-standard
mendcode packages enable acme-standard
mendcode packages remove acme-standard
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
    "mendcode": ">=0.1.7 <1.0.0",
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
mendcode packages add-source acme --type github --url https://github.com/acme/acme-mendcode-package.git --channel team
mendcode packages search "" acme
mendcode packages install acme-standard
```

For private repos, use a private-git/team source and a credential environment variable. Credentials are not stored in `.mendcode/registry.json`.

## Rollout Checklist

Before sharing a package:

1. Run `mendcode packages create` from a clean package authoring checkout.
2. Inspect the generated `mend-package.json` and `.mendcode/runtime-pack.json`.
3. Confirm the package uses `mendcode` in docs/examples.
4. Confirm no secrets are included.
5. Install it in a throwaway checkout.
6. Run `mendcode packages status`, `mendcode tui status`, `mendcode models status`, and `mendcode permissions status`.
7. Open the TUI and verify prompt marker, status row, command palette entries, Agent View/home layout, and any widgets.

Screenshot slot:

| File | Capture |
| --- | --- |
| `docs/assets/screenshots/package-status.png` | `mendcode packages status` or package show output for a demo package such as `acme-standard`. Use demo values only. |

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
