# MendCode Docs

These docs describe the MendCode-owned product surface: the public `mendcode` CLI, `.mendcode/` configuration, setup flow, runtime packages, model roles, prompt modes, memory, permissions, TUI customization, Plan Mode, Changes Review, Loop Workflows, Usage Insights, mflow, optional TSM/worktrees, and release/security policy.

Use this index by intent. **Use MendCode** explains the public workflow, **Features and pages** describes what the TUI can do, and **Build and maintain** is for packages, extensions, source paths, and releases. The [Source Map](source-map.md) is intentionally separate so normal product docs do not repeat internal `opencode` paths.

## Use MendCode

- [CLI, setup, and configuration](cli-setup-configuration.md): install/open commands, setup state, config paths, focus profiles, model roles, prompt modes, permissions, and memory.
- [Session history](session-history.md): browse, inspect, and resume previous sessions.
- [Automation runtime](automation-runtime.md): JSON envelopes, shared model selection, progress inspection, events, waiting, and cancellation.
- [Independent Workflows](workflows.md): one-shot plans, task sequencing, completion evidence, and operator controls.
- [Loop Workflows](loop-workflows.md): verified goals, recurring jobs, bounded runs, durable permission waits, and `/loops` supervision.
- [mflow coordination](mflow.md): local-first coordination, relay modes, file locks, and same-worktree editing.
- [TSM and worktrees](tsm-and-worktrees.md): optional terminal sessions, worktree routing, registry ownership, and preview-first safety.
- [Packages and team sharing](packages-and-team-sharing.md): share commands, agents, modes, skills, prompts, MCP, widgets, profiles, and policy.

## Features and pages

### Product features

- [Feature Map](features.md): complete inventory of product behavior, shortcuts, slash commands, and demo surfaces.
- [Customization](customization.md): prompt chrome, input marker, status placement, home identity, Agent View, mascot, activity states, and profiles.
- [Mermaid ASCII rendering](mermaid-ascii-rendering.md): terminal-native diagrams, fit/pan controls, local scrolling, supported families, and expanded fixtures.
- [Custom Tool Calls](custom-tool-calls.md): project-local and package-shared tools with typed context and permission checks.
- [TUI Plugins and Widgets](tui-plugins-and-widgets.md): status rows, widgets, slots, commands, dialogs, routes, themes, keybinds, and package distribution.
- [Themes](themes.md): terminal theme reference.

### TUI pages and operator surfaces

- [Plan Mode](plan-mode.md): review, edit, comment, approve, or reject a plan before implementation.
- [Changes Review](changes-review.md): diff workspace, responsive layout, comments, and agent-visible review context.
- [Loop Workflows](loop-workflows.md): active/history dashboard, phases, runs, permissions, and recovery controls.
- [Memory Center](memory-center.md): saved memories, proposals, categories, Dream status, and constrained side chat.
- [Usage Insights](usage-insights.md): activity scopes, token heatmap, AI time, tools/agents/models, cache behavior, and weather.

## Build and maintain

- [Architecture and packages](architecture.md): ownership, runtime boundary, repository layout, package map, and safety model.
- [Package index](package-index.md): workspace packages versus runtime `.mendcode` packages.
- [MendCode Source Map](source-map.md): one maintained map from public features to implementation and test paths.
- [Releasing](releasing.md): installer contract, checksums, release notes, and public installer smoke tests.
- [Changelog](../CHANGELOG.md): versioned behavior changes and regression coverage for recent releases.
- [Supply chain security](supply-chain-security.md): provenance, SBOM, pinned actions, dependency review, and scanner policy.
- [Public readiness audit](public-readiness-audit.md): branch, secret, dependency, legacy-reference, and public-surface checks.

## Community and publication

- [Community](community.md): issues, discussions, pull requests, and labels.
- [Wiki](wiki.md): GitHub wiki structure and synchronization.
- [Lineage and acknowledgements](../ACKNOWLEDGEMENTS.md): upstream attribution and MendCode downstream scope.

## Main Commands

```bash
mendcode
mendcode status
mendcode session list --format json
mendcode loops status
mendcode setup status
mendcode models status
mendcode packages status
mendcode mflow status
mendcode tsm status
mendcode worktree status
mendcode --worktree [branch|path|id]
mendcode --tsm [branch|path|id|--all]
```

## Loop Workflow Controls

```text
/loop   # create/activate a loop from natural language
/loops  # supervise active and historical loops
```

## TUI Customization Commands

Most visual changes can be made from the command palette:

```text
Ctrl+P -> Home identity
Ctrl+P -> Home title text
Ctrl+P -> Home title font
Ctrl+P -> Home mascot ASCII
Ctrl+P -> Home welcome mode
Ctrl+P -> Home split panel
Ctrl+P -> Prompt chrome
Ctrl+P -> Prompt context (`minimal`, `focus`, `full`, or project `custom`)
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

## Implementation pointers

The maintained implementation and test paths now live in the dedicated [MendCode Source Map](source-map.md). This index stays focused on the public product documentation.
