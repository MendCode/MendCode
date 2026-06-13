# CLI, Setup, and Configuration

The public CLI is `mend`. It can open the interactive TUI, inspect configuration, run setup, manage packages, and control optional mflow/TSM/worktree integrations.

## Public Commands

```bash
mend                         # open MendCode TUI in the current project
mend --worktree [target]     # open MendCode in a git worktree by branch/path/id
mend --tsm [target|--all]    # open TSM workspace with a MendCode split
mend run "message"           # open TUI with an initial message
mend chat "message"          # run a control-plane chat turn
mend status
mend doctor
mend check
mend config show
mend config paths
```

## Setup Page

The setup flow tracks these steps:

- Required: `provider`, `models`, `budget`, `prompt`.
- Optional: `package`, `tui`, `memory`, `permissions`.

Useful commands:

```bash
mend setup status
mend setup plan
mend setup doctor
```

The setup state is local project state. Completing setup means the required steps are recorded, not that secrets are committed. Provider credentials and API keys must stay outside the repository.

## Configuration Files

Common MendCode config paths:

- `.mendcode/mendcode.json`: project config and package metadata.
- `.mendcode/generated/opencode.json`: generated runtime compatibility config.
- `.mendcode/models.yaml`: project model-role config.
- `~/.config/mendcode/models.yaml`: global model-role config.
- `~/.config/mendcode/mendcode.json`: global MendCode config.
- `.mendcode/tui/profile.json`: TUI profile.
- `.mendcode/packages/state.json`: installed/enabled package state.
- `.mendcode/registry.json`: package registry sources.
- `.mendcode/mflow/state.json`: mflow local state.
- `.mflow/config.toml`: mflow runtime config scaffold.
- `.mendcode/tsm/state.json`: optional TSM state.
- `.mendcode/worktree/state.json`: managed/adopted worktree registry.

## Focus Profiles

MendCode ships focus profiles that tune prompt policy, model role, tool posture, budget posture, and worktree policy:

- `codex`
- `claude`
- `gemini`
- `kimi`
- `deepseek`
- `mistral`

Commands:

```bash
mend focus status
mend focus list
mend focus show codex
mend focus use codex
```

## Models

Models are configured by role instead of hardcoding one model everywhere. Roles include:

- `default`
- `small`
- `plan`
- `build`
- `code`
- `review`
- `subagent`
- `title`
- `compaction`
- `summary`
- `memoryExtractor`
- `permissionReviewer`

Example:

```yaml
version: 0
enabled: true
roles:
  default:
    providerID: "openai"
    modelID: "gpt-5.2"
    authMode: "api-key"
  build:
    providerID: "openai"
    modelID: "gpt-5.2-codex"
    authMode: "api-key"
  small:
    providerID: "openai"
    modelID: "gpt-5-mini"
    authMode: "api-key"
```

Commands:

```bash
mend models status
mend models presets
mend models set-default openai gpt-5.2 --auth-mode api-key --enable
mend models use-preset openai-api-gpt-5.2-codex --enable
mend models plan
```

The CLI currently writes the default model role directly. For non-default roles such as `build`, `review`, or `permissionReviewer`, edit `models.yaml` and run `mend models plan` / `mend models status` to verify projection.

## Providers, Auth, Permissions, Memory

Useful inspection commands:

```bash
mend providers status
mend auth status
mend permissions status
mend permissions set-default smart
mend memory status
mend memory search "project convention"
```

MendCode should never commit provider credentials. Package and registry flows explicitly report `secretsIncluded: false` for shared package state.
