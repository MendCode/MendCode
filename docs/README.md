# MendCode Docs

These docs describe the MendCode-owned product surface: the public `mendcode` CLI, `.mendcode/` configuration, setup flow, runtime packages, model roles, prompt modes, memory, permissions, TUI customization, Plan Mode, Usage Insights, mflow, optional TSM/worktrees, and release/security policy.

If you are deciding what to show on GitHub or the website, start with [Feature Map](features.md). If you only read one setup page after this index, read [CLI, setup, and configuration](cli-setup-configuration.md). If you are shaping the visual product experience, read [Customization](customization.md).

## Start Here

1. [Feature Map](features.md): the full product inventory for README, website, screenshots, and demos.
2. [CLI, setup, and configuration](cli-setup-configuration.md): install/open commands, setup state, config paths, focus profiles, model roles, prompt modes, budget posture, permissions, and memory.
3. [Customization](customization.md): prompt input, input marker, prompt status, home centered/split modes, Agent View, ASCII title/mascot, activity states, and team profile examples.
4. [Plan Mode](plan-mode.md): interactive plan review modal, approve/edit/comment/reject flow, Mermaid support, and post-approval implementation handoff.
5. [Memory Center](memory-center.md): saved memories, proposals, categories, Dream status, project grouping, and the constrained memory side agent for questions, explanations, and draft proposals.
6. [Usage Insights](usage-insights.md): global/project activity dashboard, token heatmap, AI time, top tools/agents/models, cache behavior, and weather.
7. [Packages and team sharing](packages-and-team-sharing.md): package commands, agents, modes, skills, prompts, MCP files, widgets, TUI profiles, model policy, permissions, memory, and worktree policy for teams.

## Configure The Harness

- [CLI, setup, and configuration](cli-setup-configuration.md): required setup steps, optional setup steps, config files, provider/model roles, prompt modes, permissions, and memory.
- [Package index](package-index.md): source package map and the distinction between npm workspace packages and runtime `.mendcode` packages.
- [Architecture and packages](architecture.md): repo layout, MendCode-owned runtime layer, public command router, package map, and safety model.

## Shape The Terminal

- [Feature Map](features.md): concise inventory of demo-worthy surfaces, shortcuts, slash commands, and feature claims.
- [Customization](customization.md): static TUI profile, prompt chrome, prompt marker, prompt status, home identity, Agent View, mascot/activity behavior, and screenshot guidance.
- [TUI plugins and widgets](tui-plugins-and-widgets.md): dynamic runtime extensions, custom status rows, widgets, slots, command palette entries, slash commands, dialogs, routes, themes, keybinds, and package distribution.

## Review, Memory, And Observability

- [Plan Mode](plan-mode.md): planning without silent implementation.
- [Memory Center](memory-center.md): approval-first memory review, Dream maintenance, and constrained side-agent proposals.
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

Demo-worthy shortcuts:

```text
Shift+Tab -> Mode picker
Tab -> Cycle primary agent
F2 / Shift+F2 -> Cycle recent models
F3 / Shift+F3 -> Cycle or list model variants
Ctrl+X then s -> Runtime status
Ctrl+X then l -> Session switcher
```

CLI profile inspection exists for compatibility/debugging, but it is not the normal customization path.

## Source Map

- `src/mendcode/packages/opencode/src/mend/cli/public-bin.ts`: public `mendcode` command router.
- `src/mendcode/packages/opencode/src/mend/config/project.ts`: project config, focus profiles, generated runtime config, package metadata.
- `src/mendcode/packages/opencode/src/mend/config/models.ts`: model roles and projection.
- `src/mendcode/packages/opencode/src/mend/config/permissions.ts`: global permission mode and smart-reviewer role config.
- `src/mendcode/packages/opencode/src/mend/prompt/mode.ts`: prompt modes: `minimal`, `focus`, `full`.
- `src/mendcode/packages/opencode/src/mend/memory/`: approval-gated memory storage, proposals, retrieval, graph, Dream, side chat, workspaces, and category policy.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/memory/index.tsx`: Memory Center route, category policy, Dream panel, inspector, and constrained memory side agent.
- `src/mendcode/packages/opencode/src/mend/config/mflow.ts`: local-first mflow setup, relay config, edit-lock enforcement.
- `src/mendcode/packages/opencode/src/mend/config/tsm.ts`: optional TSM lifecycle and detection.
- `src/mendcode/packages/opencode/src/mend/config/worktree.ts`: worktree status, dry-run planning, adoption, destructive previews.
- `src/mendcode/packages/opencode/src/mend/runtime/pack.ts`: runtime package snapshots.
- `src/mendcode/packages/opencode/src/mend/runtime/packages.ts`: installed package state and active package projection.
- `src/mendcode/packages/opencode/src/mend/profile.ts`: TUI profile schema and defaults.
- `src/mendcode/packages/opencode/src/tool/plan-review.ts`: Plan Review tool and post-approval agent switch.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/stats/index.tsx`: Usage Insights TUI route.
- `src/mendcode/packages/plugin/src/tui.ts`: public TUI plugin/widget types.
