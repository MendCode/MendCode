# MendCode Docs

These docs describe the MendCode-owned product surface: the public `mendcode` CLI, `.mendcode/` configuration, setup flow, runtime packages, model roles, prompt modes, memory, permissions, TUI customization, Plan Mode, Usage Insights, mflow, optional TSM/worktrees, and release/security policy.

If you only read one page after this index, read [CLI, setup, and configuration](cli-setup-configuration.md). If you are shaping the visual product experience, read [Customization](customization.md).

## Start Here

1. [CLI, setup, and configuration](cli-setup-configuration.md): install/open commands, setup state, config paths, focus profiles, model roles, prompt modes, budget posture, permissions, and memory.
2. [Customization](customization.md): prompt input, input marker, prompt status, home centered/split modes, Agent View, ASCII title/mascot, activity states, screenshot plan, and team profile examples.
3. [Plan Mode](plan-mode.md): interactive plan review modal, approve/edit/comment/reject flow, Mermaid support, and post-approval implementation handoff.
4. [Usage Insights](usage-insights.md): global/project activity dashboard, token heatmap, AI time, top tools/agents/models, cache behavior, weather, and screenshot plan.
5. [Packages and team sharing](packages-and-team-sharing.md): package commands, agents, modes, skills, prompts, MCP files, widgets, TUI profiles, model policy, permissions, memory, and worktree policy for teams.

## Configure The Harness

- [CLI, setup, and configuration](cli-setup-configuration.md): required setup steps, optional setup steps, config files, provider/model roles, prompt modes, permissions, and memory.
- [Package index](package-index.md): source package map and the distinction between npm workspace packages and runtime `.mendcode` packages.
- [Architecture and packages](architecture.md): repo layout, MendCode-owned runtime layer, public command router, package map, and safety model.

## Shape The Terminal

- [Customization](customization.md): static TUI profile, prompt chrome, prompt marker, prompt status, home identity, Agent View, mascot/activity behavior, and screenshot guidance.
- [TUI plugins and widgets](tui-plugins-and-widgets.md): dynamic runtime extensions, custom status rows, widgets, slots, command palette entries, slash commands, dialogs, routes, themes, keybinds, and package distribution.

## Review, Memory, And Observability

- [Plan Mode](plan-mode.md): planning without silent implementation.
- [Usage Insights](usage-insights.md): local usage visibility without overclaiming productivity.
- [CLI, setup, and configuration](cli-setup-configuration.md#permissions-and-memory): permission modes, smart reviewer role, memory scopes, search/preview, and approval-gated proposals.

## Coordinate Local Work

- [mflow coordination](mflow.md): optional local-first coordination, relay modes, file locks, and same-worktree multi-agent editing.
- [TSM and worktrees](tsm-and-worktrees.md): `mendcode --worktree`, `mendcode --tsm`, optional TSM lifecycle, registry ownership, and preview-first worktree safety.

## Release And Public Readiness

- [Releasing](releasing.md): release assets, installer contract, checksums, release notes, and public installer smoke tests.
- [Supply chain security](supply-chain-security.md): release provenance, SBOM, pinned actions, dependency review, and scanner policy.
- [Public readiness audit](public-readiness-audit.md): current branch, secret, old-repo-reference, and public-surface audit notes.
- [Community](community.md): issues, discussions, PRs, and labels.
- [Wiki](wiki.md): GitHub wiki setup and doc sync.
- [Lineage and acknowledgements](../ACKNOWLEDGEMENTS.md): opencode attribution and MendCode downstream scope.

## Main Commands

```bash
mendcode
mendcode status
mendcode setup status
mendcode tui status
mendcode models status
mendcode packages status
mendcode mflow status
mendcode tsm status
mendcode worktree status
mendcode --worktree [branch|path|id]
mendcode --tsm [branch|path|id|--all]
```

## TUI Customization Commands

Most visual changes can be made from the command palette:

```text
Ctrl+P -> Home identity
Ctrl+P -> Home title text
Ctrl+P -> Home title font
Ctrl+P -> Home ASCII size
Ctrl+P -> Home welcome mode
Ctrl+P -> Home split panel
Ctrl+P -> Prompt chrome
Ctrl+P -> Prompt lead string
Ctrl+P -> Prompt status placement
Ctrl+P -> Chat presentation
Ctrl+P -> Usage Insights
```

You can also inspect the active profile from the CLI:

```bash
mendcode tui status
mendcode tui profile
mendcode tui preview
```

## Screenshot Capture Queue

Capture with the public command visible as `mendcode`:

1. Home split with Agent View.
2. Prompt `top-bottom` with `mendcode>` marker.
3. Prompt `ascii-box`.
4. Plan Review modal.
5. Usage Insights global dashboard.
6. Setup/status page without secrets.
7. Memory search/preview with demo data.

Do not commit screenshot links until the files exist under `docs/assets/screenshots/`.

## Source Map

- `src/mendcode/packages/opencode/src/mend/cli/public-bin.ts`: public `mendcode` command router.
- `src/mendcode/packages/opencode/src/mend/config/project.ts`: project config, focus profiles, generated runtime config, package metadata.
- `src/mendcode/packages/opencode/src/mend/config/models.ts`: model roles and projection.
- `src/mendcode/packages/opencode/src/mend/config/permissions.ts`: global permission mode and smart-reviewer role config.
- `src/mendcode/packages/opencode/src/mend/prompt/mode.ts`: prompt modes: `minimal`, `focus`, `full`.
- `src/mendcode/packages/opencode/src/mend/memory/`: approval-gated memory storage, proposals, and retrieval.
- `src/mendcode/packages/opencode/src/mend/config/mflow.ts`: local-first mflow setup, relay config, edit-lock enforcement.
- `src/mendcode/packages/opencode/src/mend/config/tsm.ts`: optional TSM lifecycle and detection.
- `src/mendcode/packages/opencode/src/mend/config/worktree.ts`: worktree status, dry-run planning, adoption, destructive previews.
- `src/mendcode/packages/opencode/src/mend/runtime/pack.ts`: runtime package snapshots.
- `src/mendcode/packages/opencode/src/mend/runtime/packages.ts`: installed package state and active package projection.
- `src/mendcode/packages/opencode/src/mend/profile.ts`: TUI profile schema and defaults.
- `src/mendcode/packages/opencode/src/tool/plan-review.ts`: Plan Review tool and post-approval agent switch.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/stats/index.tsx`: Usage Insights TUI route.
- `src/mendcode/packages/plugin/src/tui.ts`: public TUI plugin/widget types.
