# Feature Map

This page is the product-facing inventory for MendCode. It is meant to be the source page for the website feature page, README refreshes, screenshots, and demos. Keep it tied to implemented behavior; do not add aspirational claims without a matching source path or spec status.

## What MendCode Is

MendCode is a terminal-first coding harness you can shape around your own workflow. The public surface is the `mendcode` CLI plus the TUI, setup flow, model-role configuration, permission policy, memory system, runtime packages, optional mflow coordination, optional TSM/worktree orchestration, Usage Insights, Plan Mode, Changes Review, and TUI customization.

The pitch is not “another chat box.” The pitch is a configurable coding terminal: prompt chrome, status rows, model roles, memory policy, team packages, workflow coordination, and review gates live together.

## Headline Features

| Feature                         | What it gives users                                                                                                                                                                                    | Where to go deeper                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Custom terminal UI              | Prompt frame, input marker, status row, home logo, split home, Agent View, chat presentation, themes, widgets, and plugin-driven surfaces.                                                             | [Customization](customization.md), [TUI plugins and widgets](tui-plugins-and-widgets.md) |
| Package system                  | Bundle commands, agents, modes, skills, prompts, MCP config, TUI profile, widgets, model roles, permission defaults, memory defaults, and worktree policy.                                             | [Packages and team sharing](packages-and-team-sharing.md)                                |
| Plan Mode                       | The agent presents a Markdown plan inside a TUI review modal; the user can approve, edit, comment, or reject before implementation starts. Approval switches into the configured implementation agent. | [Plan Mode](plan-mode.md)                                                                |
| Mermaid ASCII canvases          | Mermaid fences render as centered terminal diagrams with fit/layout zoom, local horizontal and vertical scrolling, pan controls, and documented stress fixtures.                                 | [Mermaid ASCII rendering](mermaid-ascii-rendering.md)                                    |
| Changes Review                  | `/changes` opens a responsive TUI diff workspace with file/block/line navigation, comments, reload, return-to-chat behavior, and agent-visible review context between model turns.                     | [Changes Review](changes-review.md)                                                      |
| Loop Workflows                  | Durable, monitorable loop sessions with `/loop` creation, `/loops` supervision, Agent View roots, contract-aware report-only mode, and a per-project OS background service.                                     | [Loop Workflows](loop-workflows.md)                                                      |
| Automation runtime              | Let another local agent create, continue, inspect, wait for, stream, and cancel real MendCode sessions through the same runtime, with versioned JSON output and shared model selection.                | [Automation runtime](automation-runtime.md)                                              |
| Usage Insights                  | Local activity dashboard for tokens, sessions, AI time, words, tools, agents, models, changed files, daily activity, selected-day detail, cache mix, and optional weather.                              | [Usage Insights](usage-insights.md)                                                      |
| Approval-gated memory           | Memory can retrieve context without silently turning every session into permanent state. Generated memories become reviewable proposals first.                                                         | [CLI, setup, and configuration](cli-setup-configuration.md#permissions-and-memory)       |
| Memory Center, graph, and Dream | Route-level memory workspace with saved/pending memories, categories, policy controls, Dream logs, and constrained memory side chat.                                                                   | [Memory Center](memory-center.md)                                                        |
| Smart permissions               | Choose `approval`, `smart`, or `full_access`. Smart mode auto-approves bounded read-only shell work and can route risky decisions through a configured `permissionReviewer` role.                         | [CLI, setup, and configuration](cli-setup-configuration.md#permissions-and-memory)       |
| Model roles                     | Configure task-specific roles for default, small, plan, build/code, subagent, title, compaction, summary, memory extraction, Dream, memory side chat, and permission review.                     | [CLI, setup, and configuration](cli-setup-configuration.md#models)                       |
| Local provider bridges          | Connect local provider CLIs such as Claude Code through validated setup/auth surfaces while keeping credentials in local tool state.                                                                    | [CLI, setup, and configuration](cli-setup-configuration.md#connect-provider)             |
| mflow coordination              | Optional local-first coordination and locks for multiple agents working around the same repo.                                                                                                          | [mflow coordination](mflow.md)                                                           |
| TSM and worktrees               | Open MendCode in managed/adopted worktrees or TSM terminal workspaces with preview-first safety.                                                                                                       | [TSM and worktrees](tsm-and-worktrees.md)                                                |
| Plugins and widgets             | Add status entries, editor widgets, slots, command palette entries, slash commands, routes, dialogs, themes, and package-distributed TUI behavior.                                                     | [TUI plugins and widgets](tui-plugins-and-widgets.md)                                    |

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

Drive the same session runtime from another local agent:

```bash
mendcode session create --title "Implement the feature" --format json
mendcode session send ses_... "Inspect the repository and implement the change" --format json
mendcode session wait ses_... --timeout-ms 1800000 --format json
mendcode session events ses_... --follow --format json
```

Automation output is newline-delimited `mendcode.cli.v1` JSON. Use `inspect` or
`export` for a snapshot, `events` for progress, and `cancel` to stop active
work. The detailed command contract, lifecycle states, model precedence, and
redaction rules live in [Automation runtime](automation-runtime.md).

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
mendcode loops status
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

| Input              | Behavior                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctrl+P`           | Command palette. Search for Usage Insights, Memory, Home, Prompt, Presentation, Status, Worktrees, TSM, mflow, packages, models, themes, or help. |
| `Shift+Tab`        | Open the mode picker. This is the fast path for switching the operating mode without typing a command.                                            |
| `Tab`              | Cycle primary agents.                                                                                                                             |
| `F2` / `Shift+F2`  | Cycle recently used models forward/back.                                                                                                          |
| `F3` / `Shift+F3`  | Cycle or list model variants.                                                                                                                     |
| `Ctrl+X`, then `m` | Open model list through the leader key binding.                                                                                                   |
| `Ctrl+X`, then `a` | Open primary agent list through the leader key binding.                                                                                           |
| `Ctrl+X`, then `s` | Open runtime status.                                                                                                                              |
| `Ctrl+X`, then `l` | Switch/resume sessions.                                                                                                                           |
| `Ctrl+X`, then `n` | Start a new session.                                                                                                                              |
| `Ctrl+_`           | Undo the most recent prompt edit. On many keyboards this is `Ctrl+Shift+-`.                                                                       |
| `Ctrl+Y`           | Redo a prompt edit.                                                                                                                                 |
| `⌘Z` / `⌘⇧Z`       | Undo / redo prompt edits on macOS.                                                                                                                  |
| `Ctrl+Z`           | Suspend the terminal on POSIX systems; it is not the prompt undo shortcut.                                                                         |
| `Esc`              | Interrupt the current session or leave focused route views.                                                                                       |

Prompt undo/redo history is temporary and stays in memory only. It can recover text
cleared while the prompt remains open, but it is not persisted as a prompt archive.

Slash commands are also registered for common surfaces:

```text
/stats
/usage
/insights
/activity
/changes
/diff
/review-changes
/stats-project
/project-usage
/memory
/mem
/memories
/sessions
/resume
/new
/loop
/loops
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
- independent Home and session ASCII art: large `surfaces.homeLogo.text` plus compact activity mascot states
- home layout: centered welcome or split layout
- split panel: actions or Agent View
- chat presentation: raw, minimal, or MendCode activity-oriented rendering
- activity mascot states for thinking, reading, searching, running, patching, testing, blocked, done, and error phases
- profile/package sharing for team-created logos and mascots; first-class ASCII-pack import is not available yet
- widgets, slots, custom routes, dialogs, footer entries, and themes through plugins

Good demo profile:

```jsonc
{
  "identity": {
    "logoMode": "mascot",
    "productName": "MendCode",
  },
  "surfaces": {
    "homeWelcome": {
      "mode": "split",
      "rightPanel": "agentManager",
    },
  },
  "promptChrome": {
    "preset": "top-bottom",
    "glyphs": {
      "leadText": "mendcode>",
    },
  },
  "promptStatus": {
    "placementByPreset": {
      "top-bottom": "outside",
      "ascii-box": "inside",
    },
  },
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

## Changes Review

Changes Review is the review surface for the current working-tree diff:

```text
/changes
```

It provides a responsive terminal diff viewer with a file sidebar on wide
terminals and a stacked scroll layout on compact terminals. Users can move by
file, diff block, or line, add comments, reload the diff, and leave the route with
`Esc` or `q` without stopping the active chat/session.

The agent integration is intentionally bounded. MendCode injects compact
`<mendcode_review_context>` into model turns when a review is active, including
the selected file/block/line and comments. If a user comments while an agent is
working, the agent can see that updated review context on the next model turn,
including the turn after a tool call completes. MendCode does not interrupt an
already-running token stream to splice in new comments mid-generation.

The assistant can also use the `review` tool to inspect the active selection,
read a specific file summary, navigate, reload, and manage comments. The route
does not require any external diff review app to be installed; it is
MendCode-native and uses `@pierre/diffs` for patch structure.

## Loop Workflows

Loop Workflows are durable agent workflows for verified goals, recurring jobs,
and exact-count runs. Completion and cadence are independent contracts:

- `max-goal` uses concrete completion criteria and finishes as soon as the goal
  is verified. A positive `maxTurns` is an optional safety cap, not a schedule.
- `unbounded-monitor` repeatedly executes the objective on its manual, interval,
  daily, self-paced, adaptive, or external-signal trigger. Omit `maxTurns` and
  stop it explicitly when the recurring job is no longer needed.
- `fixed` uses a positive `maxTurns` for exactly bounded iterations.

A recurring loop's objective describes the work for each wakeup; it is not an
early-completion condition after the first successful run.

Core commands:

```bash
mendcode loops examples
mendcode loops draft --template research-digest --name "Loop test"
mendcode loops activate loop_...
mendcode loops tick loop_... --execute --report-only
mendcode loops monitor loop_...
mendcode loops service start
```

For a durable report-only/read-only workflow, `--execute --report-only` wakes the loop root session and records transcript activity without exposing mutation, shell, or subagent tools. It does not downgrade an edit-capable contract. Real agent execution uses `mendcode loops tick ... --execute`; `run` / `run_once` records a monitor iteration without a model call, still consumes iteration budget, and can block a `max-goal` workflow when that budget is exhausted.

Supervised completion can combine allowlisted executable validations, evidence-only success checks, independent judgment, deterministic rubric coverage, authenticated local HTTP signal ingress, audited non-critical overrides, and bounded append-triggered artifact retention.

The per-project service persists scheduler state, repairs overdue wakeups, and
uses leases to prevent duplicate execution. `/loops` presents the persisted
`nextWakeup` as a live countdown alongside scheduler health and bounded evidence.
Permission or user-decision gates move the current run to durable `needs_input`;
providing input resumes that run rather than completing, failing, or duplicating
the workflow.

See [Loop Workflows](loop-workflows.md) for lifecycle, monitor, Agent View behavior, and service details.

Important release notes for this page:

- loops are durable database records, not just long-running prompts
- activation creates a root session visible in Agent View under `Looping`
- run journals record created, activated, wake, started, completed, failed, paused, resumed, and stopped events
- report-only/read-only workflow contracts suppress mutation and shell/subagent tools during execution
- service mode is per project and requests report-only execution by default, while the durable workflow contract remains authoritative
- scheduled wakeups survive closing the TUI when the project service is running; persisted scheduler state remains the source of truth
- `needs_input` is a durable wait on the existing run, not a terminal state or a reason to recreate the loop

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
- keyboard/mouse day selection
- selected-day token, cache, session, prompt, word, file, AI time, and tool runtime details
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

## Markdown, Streaming Output, And Shell Feedback

MendCode renders assistant output inside a terminal, so Markdown support has to
work while text is still streaming and after messages complete.

Current rendering surfaces include:

- headings, lists, links, inline code, bold/italic text, code fences, tables, and blockquotes
- terminal-friendly Mermaid text diagrams for common chart/diagram shapes
- styled Plan Mode and compaction summaries
- progressive streaming Markdown tails that avoid rendering incomplete tables or fences too early
- hex color swatches in rich Markdown output
- live shell output that deduplicates replayed deltas while commands are still running

This keeps long model answers, plans, shell commands, and compaction summaries
readable without waiting for the entire response to finish.

## Local Provider Bridges

MendCode can expose local provider CLIs through the same provider/model setup
surface used by hosted providers. The Claude Code bridge validates the local
`claude` binary, checks local CLI auth status, reads version-compatible models,
and keeps credentials in the Claude Code CLI's own local state instead of
placing secrets in MendCode packages or repository files.

## Provider-Aware Context Continuity

Provider adapters keep transport details aligned with the model contract instead of
making the rest of the runtime provider-specific. For ChatGPT OAuth Responses Lite,
MendCode normalizes supported model aliases, preserves session affinity while the
effective instructions stay the same, and rotates that affinity when instructions
change. GPT-5.6 OAuth models expose a 256K effective input/context limit and a
provider-aware compaction threshold so long sessions compact before the provider
rejects the request.

## Model Roles

MendCode avoids hardcoding one model for every task. Model config can route different jobs through different roles:

- `default`
- `small`
- `plan`
- `build`
- `code`
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

| Mode          | Behavior                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval`    | Manual approval remains the normal review posture.                                                                                                   |
| `smart`       | Bounded read-only shell requests pass automatically. Risky or ambiguous requests stay gated and may use a configured `permissionReviewer`; the reviewer cannot auto-approve non-read-only commands. |
| `full_access` | Reduces prompts for the current trust posture, while explicit deny rules still matter.                                                               |

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

## Implementation paths

The implementation and test paths for all product surfaces are maintained in the dedicated [MendCode Source Map](source-map.md). This feature page stays focused on behavior and user-visible contracts.
