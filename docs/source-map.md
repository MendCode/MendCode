# MendCode Source Map

This page is for contributors and maintainers who need to find the implementation behind a MendCode feature. If you are learning how to use MendCode, start with the [user documentation](README.md) or the [Feature Map](features.md) instead.

## Why some paths say `opencode`

`src/mendcode/packages/opencode/` is the internal runtime package directory. MendCode owns the public command surface and the product layers around that runtime, while the package name preserves the upstream OpenCode lineage. It does **not** mean that users should run a second product or use an `opencode` command.

- Public users run `mendcode`.
- MendCode configuration and control-plane modules are under `src/mendcode/packages/opencode/src/mend/`.
- The underlying runtime and compatibility boundary remain under `src/mendcode/packages/opencode/src/`.
- The development-only `mend` shim is not the public installation contract.
- Lineage and licensing details live in [Architecture and Packages](architecture.md#lineage) and [ACKNOWLEDGEMENTS.md](../ACKNOWLEDGEMENTS.md).

## Start with the right boundary

| Need | Start here |
| --- | --- |
| Add or change a public CLI command | `src/mendcode/packages/opencode/src/mend/cli/public-bin.ts` |
| Change setup, project config, models, permissions, or prompt modes | `src/mendcode/packages/opencode/src/mend/config/`, `src/mendcode/packages/opencode/src/mend/profile.ts`, `src/mendcode/packages/opencode/src/mend/prompt/` |
| Change a TUI page or route | `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/` |
| Change session automation or streaming | `src/mendcode/packages/opencode/src/cli/cmd/session.ts`, `src/mendcode/packages/opencode/src/cli/cmd/run.ts`, `src/mendcode/packages/opencode/src/cli/automation.ts` |
| Change a tool or model-facing contract | `src/mendcode/packages/opencode/src/tool/` and `src/mendcode/packages/opencode/src/session/` |
| Change a plugin, widget, or extension API | `src/mendcode/packages/plugin/src/` and the corresponding TUI host under `src/mendcode/packages/opencode/src/cli/cmd/tui/plugin/` |
| Change package distribution or runtime snapshots | `src/mendcode/packages/opencode/src/mend/runtime/` |
| Change release assets or public readiness | `src/mendcode/packages/script/`, `.github/workflows/`, and `docs/releasing.md` |

## Public CLI and control plane

- `src/mendcode/packages/opencode/src/mend/cli/public-bin.ts`: public `mendcode` command router and help surface.
- `src/mendcode/packages/opencode/src/mend/config/project.ts`: project configuration, focus profiles, generated runtime config, and package metadata.
- `src/mendcode/packages/opencode/src/mend/config/models.ts`: model roles, projection, and shared prompt-model precedence.
- `src/mendcode/packages/opencode/src/mend/config/permissions.ts`: permission mode and smart-reviewer role configuration.
- `src/mendcode/packages/opencode/src/mend/prompt/mode.ts`: `minimal`, `focus`, `full`, and project-local `custom` prompt modes.
- `src/mendcode/packages/opencode/src/mend/prompt/custom.ts`: bounded, root-safe `.mendcode/prompts/custom.md` loader.
- `src/mendcode/packages/opencode/src/cli/cmd/session.ts`: session create/send/inspect/wait/events/cancel lifecycle.
- `src/mendcode/packages/opencode/src/cli/automation.ts`: versioned `mendcode.cli.v1` envelopes and secret-like field redaction.
- `src/mendcode/packages/opencode/src/cli/cmd/run.ts` and `src/mendcode/packages/opencode/src/cli/model-selection.ts`: headless streaming and shared model/agent resolution.

## TUI pages and product surfaces

- `src/mendcode/packages/opencode/src/cli/cmd/tui/app.tsx`: TUI shell, command palette entries, slash aliases, and route registration.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/changes/`: Changes Review loading, diff state, comments, responsive renderer, and review context. The key files are `index.tsx`, `load-diff.ts`, `review-state.ts`, `review-comments.ts`, `review-context.ts`, `review-actions.ts`, and `renderer-adapter.tsx`.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/plan-review.tsx`: Plan Review modal and its approve/edit/comment/reject stages.
- `src/mendcode/packages/opencode/src/tool/plan-review.ts`: Plan Review tool schema and implementation-agent switch.
- `src/mendcode/packages/opencode/src/tool/review.ts`: assistant-facing Changes Review tool.
- `src/mendcode/packages/opencode/src/session/prompt.ts`: active review context injection into model turns.
- `src/mendcode/packages/opencode/src/session/prompt/plan.txt`: Plan Review instruction for planning agents.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/loops/`: Loop Workflows dashboard and operator controls.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/memory/index.tsx`: Memory Center route, category policy, Dream panel, inspector, and side agent.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/stats/index.tsx`: Usage Insights route, scope handling, cache, shortcuts, and weather integration.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/util/usage-insights.ts`: Usage Insights aggregation and normalization.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/component/styled-plan-markdown.tsx`: stable Markdown presentation, Mermaid cards, local viewport controls, and source-to-card recovery.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/util/markdown-render.ts`: Markdown/streaming rendering and Mermaid ASCII card generation.
- `src/mendcode/packages/opencode/src/mend/profile.ts` and `src/mendcode/packages/opencode/src/mend/tui/`: TUI profile, prompt chrome, status, presentation, mascot, and customization actions.

## Sessions, loops, and coordination

- `src/mendcode/packages/opencode/src/session/loop.ts`: Loop Workflow model and lifecycle state.
- `src/mendcode/packages/opencode/src/session/loop-runner.ts`: loop wakeup and iteration execution.
- `src/mendcode/packages/opencode/src/tool/loop.ts`: assistant-facing loop tool contract.
- `src/mendcode/packages/opencode/src/mend/runtime/loop-service.ts`: durable loop service, status, activation, and run state.
- `src/mendcode/packages/opencode/src/mend/cli/control-plane.ts`: public loop CLI controls and service lifecycle.
- `src/mendcode/packages/opencode/src/server/routes/instance/loop.ts` and `src/mendcode/packages/opencode/src/server/routes/instance/httpapi/handlers/loop.ts`: loop read/control route stacks.
- `src/mendcode/packages/opencode/src/mend/config/mflow.ts`: local-first mflow setup, relay configuration, and edit locks.
- `src/mendcode/packages/opencode/src/mend/config/tsm.ts` and `src/mendcode/packages/opencode/src/mend/config/worktree.ts`: optional TSM/worktree lifecycle, previews, and safety registry.

## Memory, packages, providers, and extensions

- `src/mendcode/packages/opencode/src/mend/memory/`: approval-gated storage, proposals, retrieval, graph, Dream, side chat, workspaces, and category policy.
- `src/mendcode/packages/opencode/src/mend/runtime/pack.ts`: runtime package snapshot creation.
- `src/mendcode/packages/opencode/src/mend/runtime/packages.ts`: installed/enabled package projection.
- `src/mendcode/packages/opencode/src/provider/claude-code.ts`: local Claude Code CLI provider bridge and validation.
- `src/mendcode/packages/plugin/src/tui.ts`: public plugin/widget type contract.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/plugin/`: TUI plugin host, slots, routes, commands, dialogs, themes, and runtime registration.

## Tests, docs, and release references

- `src/mendcode/packages/opencode/test/cli/tui/`: executable coverage for Markdown, Mermaid, TUI pages, and interaction contracts.
- `src/mendcode/packages/opencode/test/tui/usage-insights.test.ts`: Usage Insights aggregation and selected-day regression coverage.
- `docs/`: public behavior, setup, feature, page, release, and security documentation.
- `src/mendcode/packages/script/` and `.github/workflows/`: release helpers, asset assembly, provenance, and CI gates.

## Related documentation

- [Architecture and Packages](architecture.md): ownership, runtime boundary, repository layout, and safety model.
- [CLI, Setup, and Configuration](cli-setup-configuration.md): public commands and user-facing configuration.
- [TUI Plugins and Widgets](tui-plugins-and-widgets.md): supported extension API.
- [Releasing MendCode](releasing.md): installer and release workflow.
- [Lineage and acknowledgements](../ACKNOWLEDGEMENTS.md): upstream attribution and licensing.
