# Feature Map

This page is the product-facing inventory for MendCode. It is meant to be the source page for the website feature page, README refreshes, screenshots, and demos. Keep it tied to implemented behavior; do not add aspirational claims without a matching source path or spec status.

## What MendCode Is

MendCode is a terminal-first coding harness you can shape around your own workflow. The public surface is the `mendcode` CLI plus the TUI, setup flow, model-role configuration, permission policy, memory system, runtime packages, optional mflow coordination, optional TSM/worktree orchestration, Usage Insights, Plan Mode, and TUI customization.

The pitch is not “another chat box.” The pitch is a configurable coding terminal: prompt chrome, status rows, model roles, memory policy, team packages, workflow coordination, and review gates live together.

## Headline Features

| Feature | What it gives users | Where to go deeper |
| --- | --- | --- |
| Custom terminal UI | Prompt frame, input marker, status row, home logo, split home, Agent View, chat presentation, themes, widgets, and plugin-driven surfaces. | [Customization](customization.md), [TUI plugins and widgets](tui-plugins-and-widgets.md) |
| Package system | Bundle commands, agents, modes, skills, prompts, MCP config, TUI profile, widgets, model roles, permission defaults, memory defaults, and worktree policy. | [Packages and team sharing](packages-and-team-sharing.md) |
| Plan Mode | The agent presents a Markdown plan inside a TUI review modal; the user can approve, edit, comment, or reject before implementation starts. Approval switches into the configured implementation agent. | [Plan Mode](plan-mode.md) |
| Usage Insights | Local activity dashboard for tokens, sessions, AI time, words, tools, agents, models, changed files, daily activity, cache mix, and optional weather. | [Usage Insights](usage-insights.md) |
| Approval-gated memory | Memory can retrieve context without silently turning every session into permanent state. Generated memories become reviewable proposals first. | [CLI, setup, and configuration](cli-setup-configuration.md#permissions-and-memory) |
| Memory Center, graph, and Dream | Route-level memory workspace with saved/pending memories, categories, policy controls, Dream logs, and constrained memory side chat. | [Memory Center](memory-center.md) |
| Smart permissions | Choose `approval`, `smart`, or `full_access`. Smart mode can route risky permission decisions through a configured `permissionReviewer` role. | [CLI, setup, and configuration](cli-setup-configuration.md#permissions-and-memory) |
| Model roles | Configure task-specific roles for default, small, plan, build, review, subagent, title, compaction, summary, memory extraction, Dream, memory side chat, and permission review. | [CLI, setup, and configuration](cli-setup-configuration.md#models) |
| mflow coordination | Optional local-first coordination and locks for multiple agents working around the same repo. | [mflow coordination](mflow.md) |
| TSM and worktrees | Open MendCode in managed/adopted worktrees or TSM terminal workspaces with preview-first safety. | [TSM and worktrees](tsm-and-worktrees.md) |
| Plugins and widgets | Add status entries, editor widgets, slots, command palette entries, slash commands, routes, dialogs, themes, and package-distributed TUI behavior. | [TUI plugins and widgets](tui-plugins-and-widgets.md) |

## Terminal Workflow

Open MendCode in a repo:

```bash
mendcode
```

Start with an initial instruction:

```bash
mendcode run "review this repo and draft a plan"
```

Run a control-plane turn without opening the full interactive surface:

```bash
mendcode chat "summarize current status"
```

Inspect readiness and product subsystems:

```bash
mendcode status
mendcode doctor
mendcode setup status
mendcode models status
mendcode permissions status
mendcode memory status
mendcode packages status
mendcode mflow status
mendcode worktree status
mendcode tsm status
```

Open with workflow shortcuts:

```bash
mendcode --worktree feature-branch
mendcode --tsm feature-branch
mendcode --tsm --all
```

Normal public docs should use `mendcode`. A local `mend` shim may exist in development checkouts, but it is not the public command.

## TUI Commands And Shortcuts

These are good demo moments because they show MendCode as a product surface, not just a model wrapper.

| Input | Behavior |
| --- | --- |
| `Ctrl+P` | Command palette. Search for Usage Insights, Memory, Home, Prompt, Presentation, Status, Worktrees, TSM, mflow, packages, models, themes, or help. |
| `Shift+Tab` | Open the mode picker. This is the fast path for switching the operating mode without typing a command. |
| `Tab` | Cycle primary agents. |
| `F2` / `Shift+F2` | Cycle recently used models forward/back. |
| `F3` / `Shift+F3` | Cycle or list model variants. |
| `Ctrl+X`, then `m` | Open model list through the leader key binding. |
| `Ctrl+X`, then `a` | Open primary agent list through the leader key binding. |
| `Ctrl+X`, then `s` | Open runtime status. |
| `Ctrl+X`, then `l` | Switch/resume sessions. |
| `Ctrl+X`, then `n` | Start a new session. |
| `Esc` | Interrupt the current session or leave focused route views. |

Slash commands are also registered for common surfaces:

```text
/stats
/usage
/insights
/activity
/stats-project
/project-usage
/memory
/mem
/memories
/sessions
/resume
/new
/models
/agents
/variants
/mcps
/connect
/status
/themes
/help
/exit
/tsm
/worktrees
/mflow
```

## Custom Terminal UI

MendCode turns the terminal into a profile. The stable config lives in `.mendcode/tui/profile.json`; dynamic runtime extensions live in TUI plugins.

Configurable surfaces include:

- prompt chrome presets: `box`, `top-bottom`, `minimal`, `ascii-box`
- prompt lead string: `❭`, `>`, `mendcode>`, `ship>`, team-specific markers
- prompt status row: mode, model, provider, reasoning, context, permission mode, command hints, agent hints, script-backed status
- home identity: generated ASCII title or custom ASCII mascot
- home layout: centered welcome or split layout
- split panel: actions or Agent View
- chat presentation: raw, minimal, or MendCode activity-oriented rendering
- activity mascot states for thinking, reading, searching, running, patching, testing, blocked, done, and error phases
- widgets, slots, custom routes, dialogs, footer entries, and themes through plugins

Good demo profile:

```jsonc
{
  "identity": {
    "logoMode": "mascot",
    "productName": "MendCode"
  },
  "surfaces": {
    "homeWelcome": {
      "mode": "split",
      "rightPanel": "agentManager"
    }
  },
  "promptChrome": {
    "preset": "top-bottom",
    "glyphs": {
      "leadText": "mendcode>"
    }
  },
  "promptStatus": {
    "placementByPreset": {
      "top-bottom": "outside",
      "ascii-box": "inside"
    }
  }
}
```

## Package Your Harness

Runtime packages are how a team shares a tuned MendCode environment. A package can include:

- `.mendcode/commands`
- `.mendcode/agents`
- `.mendcode/modes`
- `.mendcode/skills`
- `.mendcode/prompts`
- MCP config/files
- context docs and rules
- plugins, widgets, components, and scripts
- TUI profile and theme tokens
- model roles and focus defaults
- budget posture
- memory defaults
- permissions defaults
- worktree policy

Packages must not include provider tokens, OAuth state, `.env*`, `.mendcode/auth`, local DB files, local mflow room secrets, or machine-local run/cache state.

Useful commands:

```bash
mendcode packages create --id acme-standard --title "Acme Standard" --include all --version 1.0.0
mendcode packages status
mendcode packages list
mendcode packages sources
mendcode packages search acme
mendcode packages show acme-standard
mendcode packages install acme-standard
mendcode packages enable acme-standard
mendcode packages disable acme-standard
```

## Plan Mode

Plan Mode is built for users who want the agent to think first without silently editing files.

The flow:

1. The planning agent researches and writes a Markdown plan.
2. It calls the `plan_review` tool.
3. MendCode renders the plan in a TUI modal.
4. The user can approve, edit, add comments, reject, or close.
5. Approval resolves `planExitAgent` and switches the session to the configured implementation agent.
6. The approved or edited Markdown becomes the source of truth for implementation.

This is stronger than a normal “is this okay?” message because approval is an explicit terminal action and the implementation agent receives the reviewed plan.

## Memory, Memory Page, And Dream

Baseline memory behavior:

- global and project scopes
- explicit `mendcode memory add`
- `mendcode memory search`
- `mendcode memory preview`
- generated memory proposals
- apply/reject/edit proposal flow
- transient prompt injection through `<mendcode_memory>`
- approval-first defaults for generated memory

Memory Center expands this into:

- route-level Memory page
- workspace/project registry
- saved and pending memory views
- category map and category policy controls
- memory graph sidecar with legacy bridge
- category-aware retrieval labels
- Dream run ledger, safety report, redacted evidence manifest, and logs
- manual/scheduled Dream semantics with missed-window handling
- constrained memory side chat
- reviewable proposals for add, update, remove, verify, expire, recategorize, and scope changes

The memory side agent can answer memory-specific questions, inspect saved
entries/categories/policies, explain retrieval and proposal risk, and draft
reviewable memory/category/policy/Dream changes. It is powerful inside the
memory workspace, but it is not a normal coding agent and does not apply changes
without review.

Important safety model:

- Dream does not apply memory directly by default.
- Dream does not edit source files.
- Dream does not mutate git state.
- Git/session/file evidence is opt-in and bounded.
- Memory side chat does not become a normal coding agent.
- Generated mutations remain proposals or explicit user actions.

## Usage Insights

Usage Insights is local observability for the coding harness, not cloud analytics and not a productivity guarantee.

It can show:

- global, project, or directory scope
- daily token heatmap
- sessions and active days
- user prompts and user words
- AI generation time
- tool runtime
- changed files from session summaries
- input/output/reasoning/cache token mix
- peak token pressure
- longest task time
- top tools
- top agents
- top models and cost totals when provider metadata is available
- optional weather through Open-Meteo

Open it from the command palette:

```text
Ctrl+P -> Usage Insights
Ctrl+P -> Project Usage Insights
```

Or with slash commands:

```text
/stats
/usage
/insights
/activity
/project-usage
```

## Model Roles

MendCode avoids hardcoding one model for every task. Model config can route different jobs through different roles:

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

Examples:

- use a stronger model for planning and build work
- use a cheaper/smaller model for titles or simple summaries
- use a dedicated reviewer model for smart permission review
- use `memoryExtractor` for proposal generation
- use `memoryDream` for memory maintenance proposals
- use `memoryAssistant` for Memory page side chat

## Permissions And Safety

Permission modes:

| Mode | Behavior |
| --- | --- |
| `approval` | Manual approval remains the normal review posture. |
| `smart` | Risky prompts can be routed to a configured `permissionReviewer` model role. If the role is not usable, MendCode asks instead of silently approving. |
| `full_access` | Reduces prompts for the current trust posture, while explicit deny rules still matter. |

Safety principles:

- public packages do not carry secrets
- generated memory is reviewable
- risky work can stay approval-gated
- worktree operations are preview-first
- mflow is optional and local-first
- Usage Insights stays local
- internal/debug commands stay hidden from normal help

## Coordination: mflow, TSM, Worktrees

mflow is optional coordination for same-repo agent work. It provides local-first state, relay setup, and lock/status surfaces so multiple sessions can avoid stomping the same files.

TSM and worktree support are for terminal/worktree orchestration:

- inspect existing worktree state
- plan worktree creation before mutating anything
- open or adopt worktrees
- reset/remove through gated flows
- start TSM workspace sessions with MendCode panes

Public commands:

```bash
mendcode mflow status
mendcode mflow setup
mendcode mflow activate --room <room> --accept-public-relay-limits
mendcode mflow deactivate
mendcode worktree status
mendcode worktree plan
mendcode worktree create
mendcode worktree open
mendcode worktree adopt
mendcode tsm status
mendcode tsm plan
mendcode tsm setup
mendcode --worktree [branch|path|id]
mendcode --tsm [branch|path|id|--all]
```

## Feature Demo Checklist

For a README, website, or creator demo, show these in order:

1. `mendcode` opens the terminal harness.
2. `Ctrl+P` opens the command palette.
3. `Shift+Tab` opens mode picker.
4. `Tab` cycles agents.
5. `F2` cycles recent models.
6. Prompt marker changes from `❭` to `mendcode>` or a team marker.
7. Home layout switches to split mode with Agent View.
8. Plan Mode displays a Markdown plan in the review modal.
9. Usage Insights shows local activity.
10. Memory Center shows saved/pending memories, categories, Dream, and side chat.
11. Packages show how a team shares commands, agents, modes, skills, prompts, TUI profile, widgets, permissions, memory defaults, and worktree policy.
12. mflow/TSM/worktree surfaces show parallel workflow coordination.

## Source Map

- `src/mendcode/packages/opencode/src/mend/cli/public-bin.ts`: public `mendcode` command router and help.
- `src/mendcode/packages/opencode/src/config/keybinds.ts`: default keybindings such as `Shift+Tab`, `Tab`, `F2`, and `F3`.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/app.tsx`: command palette entries, slash commands, route registration, and MendCode TUI actions.
- `src/mendcode/packages/opencode/src/mend/profile.ts`: TUI profile schema and defaults.
- `src/mendcode/packages/opencode/src/mend/tui/`: prompt chrome, prompt status, presentation, mascot, and profile actions.
- `src/mendcode/packages/opencode/src/tool/plan-review.ts`: Plan Mode tool and post-approval agent switch.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/session/plan-review.tsx`: Plan Review modal UI.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/stats/index.tsx`: Usage Insights route.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/util/usage-insights.ts`: Usage Insights aggregation.
- `src/mendcode/packages/opencode/src/mend/memory/`: memory config, store, retrieval, proposals, graph, Dream, side chat, workspaces, and category policy.
- `src/mendcode/packages/opencode/src/cli/cmd/tui/routes/memory/index.tsx`: route-level Memory page.
- `src/mendcode/packages/opencode/src/mend/runtime/pack.ts`: runtime package snapshot creation.
- `src/mendcode/packages/opencode/src/mend/runtime/packages.ts`: installed/enabled package projection.
- `src/mendcode/packages/plugin/src/tui.ts`: public TUI plugin/widget type contract.
