# Architecture and Packages

MendCode has a MendCode-owned control plane wrapped around an adapted terminal coding runtime. The public surface is the `mend` CLI. The runtime source lives in `src/mendcode/packages/opencode`, but public commands are routed through MendCode modules under `src/mendcode/packages/opencode/src/mend`.

## Lineage

MendCode is a downstream project built on the opencode codebase. In open-source terms, it is a derivative work with substantial product/runtime additions rather than a simple mirror fork. The opencode lineage is preserved in the MIT license and in [ACKNOWLEDGEMENTS.md](../ACKNOWLEDGEMENTS.md).

MendCode's own layer includes the `mend` public CLI, MendCode-owned config/control plane, setup flow, package and registry system, mflow coordination, optional TSM/worktree orchestration, model-role projection, prompt/TUI customization, and public docs.

## Repository Layout

- `.github/`: public automation and security workflow wiring.
- `src/mendcode/`: main product source, installer, package workspace, infra, and release scripts.
- `src/mendcode/packages/opencode/`: the `mend`/`mendcode` CLI runtime package.
- `src/mendcode/packages/core/`: shared filesystem, global paths, locks, npm config, logging, utilities.
- `src/mendcode/packages/plugin/`: public plugin/tool/TUI extension SDK.
- `src/mendcode/packages/ui/`: web/UI component package.
- `src/mendcode/packages/function/`: serverless API/function package.
- `src/mendcode/packages/script/`: release and repository script helpers.
- `src/mendcode/packages/slack/`: Slack integration package.
- `src/mendcode/packages/extensions/zed/`: Zed extension metadata/assets.
- `src/mendcode/packages/identity/`: product marks and app icons.
- `src/mendcode/packages/containers/`: container images used by build/development workflows.

## Runtime Boundary

MendCode keeps user-facing state under `.mendcode/` and generates compatibility config for the underlying runtime. The important contract is:

- Users interact with `mend`, not donor runtime commands.
- MendCode config is source of truth.
- Generated runtime files are implementation detail.
- Donor/runtime hot paths are guarded and should not be the public customization API.

The public router is `src/mendcode/packages/opencode/src/mend/cli/public-bin.ts`. It routes commands such as `mend setup`, `mend packages`, `mend mflow`, `mend tsm`, and `mend worktree` to the MendCode control plane.

## Core Runtime Packages

| Package | Purpose |
| --- | --- |
| `mendcode` | CLI runtime package; exposes `mend`, `mendcode`, and `mendcode-runtime`. |
| `@mendcode/core` | Global paths, filesystem helpers, locks, npm config, observability, utility code. |
| `@mendcode/plugin` | Plugin API for custom tools and TUI/widget extensions. |
| `@mendcode/ui` | Shared UI components, theme tokens, file/message rendering, stories. |
| `@mendcode/function` | Serverless API integration, share/auth/token exchange behavior. |
| `@mendcode/script` | Script helper package used by release/maintenance scripts. |
| `@mendcode/slack` | Slack integration package. |

## MendCode-Owned Subsystems

- Setup/onboarding: provider, models, budget, package, TUI, prompt, memory, permissions.
- Models: role-based model config for default, plan, build/code, review, subagent, title, compaction, summary, memory extraction, and permission review.
- Runtime packages: shareable `.mendcode` bundles with commands, agents, modes, skills, plugins, prompts, MCP, widgets, TUI profile, models, focus, budget, memory, permissions, and worktree policy.
- mflow: optional coordination and file-lock layer for concurrent agents.
- TSM/worktrees: optional terminal-session/worktree executor with MendCode-owned safety registry.
- TUI customization: profile, prompt chrome, activity messages, mascot/logo, widgets, surfaces, density, theme.

## Safety Model

MendCode treats optional integrations as opt-in:

- Packages project configuration; they do not install TSM or start mflow by themselves.
- TSM is optional and never installed by `mend tsm status`.
- Worktree create/remove/reset commands are preview-first and report `executesGit: false` unless a future explicit execution gate is added.
- mflow setup writes visible local config and can be deactivated or removed without deleting unrelated project files.
