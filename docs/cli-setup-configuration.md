# CLI, Setup, and Configuration

The public CLI is `mendcode`. It opens the interactive terminal coding harness, runs setup/status checks, manages packages, and controls optional mflow/TSM/worktree integrations.

Development checkouts may still have a local `mend` shim, but the public installer and package metadata expose `mendcode` and `mendcode-runtime`. Public docs and screenshots should use `mendcode`.

## Public Commands

```bash
mendcode                         # open MendCode TUI in the current project
mendcode --worktree [target]     # open MendCode in a git worktree by branch/path/id
mendcode --tsm [target|--all]    # open TSM workspace with a MendCode split
mendcode run "message"           # open TUI with an initial message
mendcode chat "message"          # run a control-plane chat turn
mendcode status
mendcode doctor
mendcode check
```

## Setup Flow

The setup flow separates required harness readiness from optional product features.

Required setup:

- `provider`: the provider/auth path MendCode can use.
- `models`: model role projection for runtime use.
- `budget`: API/budget posture when API-based usage is enabled.
- `prompt`: prompt mode and focus behavior.

Optional setup:

- `package`: active team/runtime package.
- `tui`: TUI profile and visual preferences.
- `memory`: global/project memory config.
- `permissions`: global default permission mode and smart-reviewer role.

Useful commands:

```bash
mendcode setup status
mendcode setup plan
mendcode setup doctor
```

Completing setup records local project state. It does not mean provider credentials are committed. Provider credentials, OAuth tokens, API keys, local mflow room secrets, caches, and machine-local state must stay outside shared packages and repository docs.

## Connect Provider

The setup provider step is labeled `Connect Provider` because it is the place
where MendCode validates the provider/auth path the runtime can actually use.
Provider credentials are local user state, not package or repository content.

The provider picker can include:

- hosted/API providers configured through the normal MendCode auth path;
- the upstream `opencode` provider surface when available;
- local CLI-backed providers such as `Claude Code`.

`Claude Code` is a local CLI bridge. MendCode validates that the `claude`
binary is installed, that `claude auth status --json` reports an authenticated
local account, and then exposes version-compatible Claude Code models through
the normal model picker. Optional config can override the binary path, home
path, and launch arguments for machines that keep Claude Code state outside the
default shell environment.

Example provider options:

```jsonc
{
  "provider": {
    "claude-code": {
      "options": {
        "binaryPath": "claude",
        "homePath": "",
        "launchArgs": ""
      }
    }
  }
}
```

Keep this config free of secrets. It should point to local tools and local state
only; the CLI remains responsible for its own login/session files.

## Configuration Files

Common MendCode config paths:

- `.mendcode/mendcode.json`: project config, focus defaults, package metadata, budget/worktree policy, and integration settings.
- `.mendcode/generated/opencode.json`: generated compatibility config for the adapted runtime.
- `.mendcode/prompt-mode.json`: persisted prompt mode consumed by `mendcode run`, `mendcode chat`, and the TUI footer.
- `.mendcode/models.yaml`: project model-role config.
- `~/.config/mendcode/models.yaml`: global model-role config.
- `~/.config/mendcode/mendcode.json`: global MendCode config.
- `~/.config/mendcode/permissions.json`: global permission mode and reviewer-role config.
- `.mendcode/tui/profile.json`: TUI profile.
- `.mendcode/packages/state.json`: installed/enabled package state.
- `.mendcode/registry.json`: package registry sources.
- `.mendcode/memory/`: project memory config, entries, and proposals when project memory is enabled.
- `.mendcode/mflow/state.json`: mflow local state.
- `.mflow/config.toml`: mflow runtime config scaffold.
- `.mendcode/tsm/state.json`: optional TSM state.
- `.mendcode/worktree/state.json`: managed/adopted worktree registry.

## Focus Profiles

Focus profiles tune provider-family behavior, model role defaults, prompt policy, tool posture, budget posture, and worktree policy.

Built-in focus families include:

- `codex`
- `claude`
- `gemini`
- `kimi`
- `deepseek`
- `mistral`

Commands:

```bash
mendcode focus status
mendcode focus list
mendcode focus show codex
mendcode focus use codex
```

Use focus profiles to keep provider-specific behavior explicit. Do not describe them as proprietary upstream prompt dumps; MendCode adapts behavior for provider/model families without pretending to be those products.

## Prompt Modes

Prompt mode controls how much MendCode harness context is added to runtime requests. The persisted state lives in `.mendcode/prompt-mode.json` and is shown in the TUI footer/status surfaces.

| Mode | What it does | Good for |
| --- | --- | --- |
| `minimal` | Uses a small MendCode boundary and avoids the full harness prompt. Persistent memory remains independent and can still be retrieved when enabled. | Low-noise experiments, debugging prompt influence, narrow one-off tasks. |
| `focus` | Default mode. Uses the selected focus profile and provider-family policy. | Normal daily coding. |
| `full` | Adds the focus behavior plus MendCode product/runtime policy and integration context. Legacy `dev-js` config is normalized to `full`. | Work that needs package, memory, workflow, or product policy context. |

Current public setup/status surfaces should be used to inspect prompt readiness:

```bash
mendcode setup status
mendcode status
```

For team rollout, packages can include prompt mode state as part of the runtime pack. For manual local experiments, edit `.mendcode/prompt-mode.json` with one of `minimal`, `focus`, or `full`, then verify through setup/status and the TUI footer.

## Models

Models are configured by role instead of hardcoding one model everywhere.

Common roles:

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
- `memoryDream`
- `memoryAssistant`
- `permissionReviewer`

Example:

```yaml
version: 0
enabled: true
roles:
  default:
    providerID: "<provider>"
    modelID: "<default-model>"
    authMode: "<auth-mode>"
  build:
    providerID: "<provider>"
    modelID: "<model-for-build>"
    authMode: "<auth-mode>"
  small:
    providerID: "<provider>"
    modelID: "<model-for-lightweight-tasks>"
    authMode: "<auth-mode>"
  memoryDream:
    providerID: "<provider>"
    modelID: "<model-for-memory-maintenance>"
    authMode: "<auth-mode>"
  memoryAssistant:
    providerID: "<provider>"
    modelID: "<model-for-memory-side-chat>"
    authMode: "<auth-mode>"
  permissionReviewer:
    providerID: "<provider>"
    modelID: "<model-for-permission-review>"
    authMode: "<auth-mode>"
```

Commands:

```bash
mendcode models status
mendcode models presets
mendcode models set-default <provider> <model> --auth-mode <auth-mode> --enable
mendcode models use-preset <preset-id> --enable
mendcode models plan
```

The CLI currently writes the default model role directly. For non-default roles such as `build`, `review`, `subagent`, `memoryExtractor`, `memoryDream`, `memoryAssistant`, or `permissionReviewer`, edit `models.yaml` and run `mendcode models plan` / `mendcode models status` to verify projection. Public docs should keep model examples provider-neutral; teams can pin their own provider and model choices in local or package-specific config.

## Permissions And Memory

Useful inspection commands:

```bash
mendcode providers status
mendcode auth status
mendcode permissions status
mendcode memory status
mendcode memory search "project convention"
mendcode memory preview "project convention"
```

Permission modes:

| Mode | Behavior |
| --- | --- |
| `approval` | Manual approval remains the default posture. |
| `smart` | Uses an AI-assisted reviewer role for configured triggers. If the reviewer role is not configured, MendCode asks instead of silently approving. |
| `full_access` | Reduces permission prompts for the current policy surface, but explicit deny rules still matter. Use only when that trust posture is intentional. |

Configure permissions:

```bash
mendcode permissions status
mendcode permissions set-default approval
mendcode permissions set-default smart
mendcode permissions set-default full_access
mendcode permissions set-reviewer-role permissionReviewer
```

Describe `smart` as AI-assisted permission review, not as “secure by default”. It depends on the configured reviewer role and still needs a sane trust boundary.

Memory behavior:

- Memory can be global or project-scoped.
- Runtime memory is injected as transient system context; it is not copied into normal chat history unless the user asks to see it.
- Generated memory proposals are approval-gated.
- Direct `mendcode memory add` is for explicit user requests to save memory.
- `mendcode memory search` and `mendcode memory preview` are the right commands before editing, deleting, applying, or rejecting entries/proposals.
- The [Memory Center](memory-center.md) view adds saved/pending views, category policy, Dream status/logs, workspace awareness, and constrained side chat.

Example:

```bash
mendcode memory status
mendcode memory list --scope global
mendcode memory list --scope project
mendcode memory search "release workflow"
mendcode memory preview "release workflow"
mendcode memory add "Use docs screenshots with the public mendcode command." --scope project
```

## Packages, mflow, TSM, And Worktrees

Common next commands:

```bash
mendcode packages status
mendcode mflow status
mendcode worktree status
mendcode tsm status
```

Use [Packages and team sharing](packages-and-team-sharing.md), [Customization](customization.md), [mflow coordination](mflow.md), and [TSM and worktrees](tsm-and-worktrees.md) for deeper workflows.
