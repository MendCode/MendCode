# Marketplace and Team Sharing

MendCode marketplace packages are reusable bundles of `.mendcode` configuration and extensions. They are the intended way for a team or company to share the same commands, agents, modes, prompts, TUI profile, widgets, pages, custom tool calls, model policy, permissions, and worktree policy.

The mental model is “package your harness,” not “publish a single plugin.” A package can make a fresh checkout feel like the team environment: the same command palette, review modes, model roles, permission posture, prompt marker, status row, memory defaults, custom pages, custom widgets, and optional worktree policy.

The official registry repo is `https://github.com/MendCode/mendcode-marketplace`. The old `mendcode-packages` name is only a compatibility redirect.

## Good Package Examples

| Package | Includes | Does not include |
| --- | --- | --- |
| Team standard | commands, agents, modes, skills, focus default, model roles, permission defaults, TUI profile. | Provider tokens, local auth files, personal memory. |
| Review mode bundle | review agent, review mode, prompt templates, stricter permission mode, review model role. | Branch mutations or CI credentials. |
| UI theme | TUI profile, theme tokens, prompt chrome, status script, widgets, pages. | Runtime service activation. |
| ASCII art pack | TUI profile with a Home logo, session mascot states, or both. | Separate art-pack manifest/importer; static art is shared through the TUI profile. |
| Tool pack | Custom tool calls, tool docs, supporting scripts, prompt mode hints. | Arbitrary background daemons or secrets. |
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
- tools
- pages
- widgets/components/scripts
- TUI profile
- worktree policy
- model roles
- focus profile selection
- budget config
- memory config
- permissions config

### Sharing ASCII art

There is no special `pet` or `asciiArt` artifact type. Shareable art belongs in the package's TUI profile:

- Home-only art: `identity.logoMode: "mascot"` and `surfaces.homeLogo.text`.
- Session-only art: `presentation.activity.mascot`, including `hover` and `states`.
- Full identity pack: both sections together; they remain independent after installation.

A package can therefore contain a logo, a session companion, or a complete branded terminal identity without shipping a plugin. Keep the art monospaced, narrow enough for the target terminals, and data-only. Use a plugin only when the package needs dynamic rendering, custom dialogs, or behavior beyond static profile values.

Package manifests are read from:

- `mend-package.json`
- `.mendcode/package.json`

The generated runtime pack lives at:

- `.mendcode/runtime-pack.json`

Installed packages live under:

- `.mendcode/packages/installed/<id>`

Active package state lives in:

- `.mendcode/packages/state.json`

Marketplace packages run against the public MendCode API:

- `@mendcode/plugin/tui` for commands, routes/pages, widgets, slots, dialogs, overlays, shell-backed streaming widgets, editor customization, state, KV, themes, and lifecycle cleanup.
- `api.session`, `api.ai`, and `api.metadata` for session lifecycle, AI-backed pages/modals, Agent View metadata, and control-plane actions.
- `api.memory` for graph snapshots, explicit fact/link mutations, and Memory side chat.
- `api.client` for the generated SDK surface when a package needs an endpoint without a convenience wrapper.
- `.mendcode/tools` for assistant-facing custom tool calls; see [Custom Tool Calls](custom-tool-calls.md) for schemas, context, and package examples.
- `.mendcode/pages` for package-owned TUI pages.
- `.mendcode/tui/profile.json` for profile and status customization.

Packages should import public types from `@mendcode/plugin/tui` and must not import private runtime internals. If a package needs a missing capability, add a public API first instead of reaching into `src/`. Third-party packages are trusted local code: inspect them before enabling shell, session, or memory mutations.

## Create a Local Package

```bash
mendcode marketplace create --id acme-standard --title "Acme Standard" --include all --version 1.0.0
```

Useful variants:

```bash
mendcode marketplace create --include skills,modes,plugins,tuiProfile,tools,pages
mendcode marketplace create --include all --exclude models,budget
mendcode marketplace status
mendcode marketplace list
```

## Install and Use Marketplace Packages

```bash
mendcode marketplace sources
mendcode marketplace search acme
mendcode marketplace show acme-standard
mendcode install acme-standard
mendcode marketplace install acme-standard
mendcode marketplace install acme-standard acme
mendcode marketplace install-source acme
mendcode marketplace disable acme-standard
mendcode marketplace enable acme-standard
mendcode marketplace remove acme-standard
```

Disabling a package deselects it without deleting local project config. Removing a package deletes the installed package copy and updates package state.

`mendcode install <pack-id> [source-id]` is the short form for
`mendcode marketplace install <pack-id> [source-id]`. It uses configured
marketplace sources; it is not an npm package install path.

## Share One Company Package

Recommended company flow:

1. Create a package repo, for example `github.com/acme/acme-mendcode-marketplace`.
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
    "tools": [".mendcode/tools"],
    "pages": [".mendcode/pages"],
    "prompts": [".mendcode/prompts"],
    "extensions": [".mendcode/widgets", ".mendcode/components"],
    "tuiProfile": ".mendcode/tui/profile.json",
    "worktreePolicy": ".mendcode/worktree/policy.yaml"
  },
  "distribution": {
    "source": {
      "type": "github",
      "url": "https://github.com/acme/acme-mendcode-marketplace.git"
    },
    "trust": {
      "signatureRequired": false
    }
  }
}
```

Add a registry source:

```bash
mendcode marketplace add-source acme --type github --url https://github.com/acme/acme-mendcode-marketplace.git --channel team
mendcode marketplace search "" acme
mendcode marketplace install acme-standard acme
```

For private repos, use a private-git/team source and a credential environment variable. Credentials are not stored in `.mendcode/registry.json`.

## Rollout Checklist

Before sharing a package:

1. Run `mendcode marketplace create` from a clean package authoring checkout.
2. Inspect the generated `mend-package.json` and `.mendcode/runtime-pack.json`.
3. Confirm the package uses `mendcode` in docs/examples.
4. Confirm no secrets are included.
5. Install it in a throwaway checkout.
6. Run `mendcode marketplace status`, `mendcode models status`, and `mendcode permissions status`.
7. Open the TUI and verify prompt marker, status row, command palette entries, Agent View/home layout, and any widgets.
8. If the package includes ASCII art, verify both Home and session mascot surfaces in a narrow terminal and confirm that missing activity states fall back cleanly.

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
