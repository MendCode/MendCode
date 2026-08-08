import { Buffer } from "buffer"
import { readMendConfig } from "../config/project"
import { mendPaths } from "../config/paths"
import { readWorktreePolicy, tsmStatus } from "../config/worktree"
import { readMflowConfig } from "../config/mflow"
import { readPromptMode, type MendPromptMode } from "./mode"
import { readCustomPrompt, type CustomPromptResolution } from "./custom"
import {
  focusNames,
  promptBehaviorForModel,
  promptBehaviorText,
  readPromptSource,
  resolvePromptSourceFile,
  sourceForFocus,
} from "./sources"
import { composeCustomizationCapabilitySection } from "./capabilities"
import { advancedCommands, deprecatedAliases, internalCommands, primaryCommands } from "../cli/public-bin"

export type PromptBaseSource = "mendcode-harness-source" | "opencode-generic-provider-fallback" | "minimal-base"

export type PromptSection = {
  id: string
  label: string
  source: PromptBaseSource | "mendcode-context" | "integration-context" | "mode-boundary" | "project-custom"
  text: string
  bytes: number
  preview: string
}

export type PromptCustomStatus = Omit<CustomPromptResolution, "text">

export type PromptComposition = {
  mode: MendPromptMode
  focusID: string
  promptOrigin: "preset" | "project-custom"
  basePromptSource: PromptBaseSource
  includeProjectInstructions: boolean
  includeSkillsByDefault: boolean
  includeCustomInstructions: boolean
  includeMcpContext: boolean
  usesOpenCodeGenericProviderPrompt: boolean
  usesMendCodeHarnessPrompt: boolean
  fallbackReason: string | null
  customPrompt: PromptCustomStatus | null
  source: {
    label: string
    license: string
    sourcePolicy: string
    promptPath: string | null
    sourceRepo: string | null
    sourceCommit: string | null
    copiedAt: string | null
    promptAvailable: boolean
    rawSourceModeExposed: false
  } | null
  sections: PromptSection[]
  instructions: string
  instructionsBytes: number
  instructionsPreview: string
  policyInstructions: string
  policyInstructionsBytes: number
  policyInstructionsPreview: string
  basePrompt: string | null
  basePromptBytes: number
}

type ComposeInput = {
  root?: string
  mode?: string
  focusID?: string
  modelID?: string | null
  role?: string | null
  workflow?: string | null
  customFile?: string | null
}

function assertMode(mode: string): MendPromptMode {
  if (mode === "minimal" || mode === "focus" || mode === "full" || mode === "custom") return mode
  if (mode === "dev-js") return "full"
  throw new Error("prompt mode must be one of: minimal, focus, full, custom")
}

function preview(text: string, limit = 240) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text
}

function section(input: Omit<PromptSection, "bytes" | "preview">): PromptSection {
  return {
    ...input,
    bytes: Buffer.byteLength(input.text),
    preview: preview(input.text),
  }
}

type PromptSourceMetadata = {
  sourceRepo?: string | null
  sourceCommit?: string | null
  copiedAt?: string | null
}

function relativePath(root: string, file: string | null) {
  if (!file) return null
  return file.startsWith(root) ? file.slice(root.length + 1) : file
}

function promptSourceMetadata(value: unknown): PromptSourceMetadata | null {
  if (!value || typeof value !== "object") return null
  return value as PromptSourceMetadata
}

function minimalBoundary() {
  return [
    "You are MendCode CLI. Answer the user directly.",
    "Use the available terminal coding tools accurately.",
    "For monitored loops or repeated autonomous iterations, use the `loop` tool; `/loop` creates/activates and `/loops` lists or shows existing workflows. Ask only for missing critical settings.",
    "Before creating another loop for the same goal, list/show existing workflows; if a loop shows completed 0/0 or no next wakeup unexpectedly, report the invalid zero-budget state instead of recreating loops.",
    "Never set loop maxTurns to 0. Use a positive cap for bounded/fixed loops; omit maxTurns for an uncapped max-goal or unbounded monitor.",
    "Loop cost/token budgets are opt-in: use the Setup budget policy as the source of truth, and omit maxCost and maxTokens when no budget is configured; do not infer a token cap from the selected provider or auth mode.",
    "If the user asks the loop to write, edit, fix, implement, code, or create files, use normal execution rather than report-only; report-only is for inspection/monitoring/reporting objectives.",
    "Do not claim tests, builds, provider calls, or file writes passed unless they actually ran.",
    "Do not expose secrets or raw auth tokens.",
    "Background subagents:",
    "- `task` with `background: true` returns a `task_id` immediately. Do not call `task_status` or `wait` repeatedly in the same turn.",
    "- If no independent parent work remains, end the current turn and let the runtime completion notification/owner wake resume the parent; do not sleep, poll, or retry a timed-out `wait`.",
    "- Use `task_status` later to inspect, cancel, or collect a result, and never claim background work is complete without its evidence.",
  ].join("\n")
}

function loopWorkflowBrief() {
  return [
    "MendCode Loop Workflow:",
    "- Treat `/loop`, `turn this session into a loop`, `run this every N minutes`, or `run 5 monitored iterations` as Loop Workflow tool requests.",
    "- Use the `loop` tool; `/loop` creates or activates, `/loops` lists workflows unless a concrete loop id is provided for show.",
    "- Ask with the `question` tool only when objective, cadence, model/provider, max runtime, permissions, or stop condition are missing; ask for an iteration limit only when bounded execution is intended.",
    "- Create a reviewable loop draft first; activate only after explicit user confirmation. A current request that explicitly asks to activate that exact loop counts as confirmation; otherwise ask with `question`.",
    "- Use report-only mode unless the user explicitly allows edits; do not write `Iteration 1/5` through `Iteration 5/5` manually in the current chat turn.",
    "- A user request to write, edit, fix, implement, code, or create files is explicit edit approval for that loop; create it with normal execution instead of report-only.",
    "- Never use `maxTurns: 0`; fixed loops need a positive cap, while max-goal may omit maxTurns for no iteration cap and unbounded-monitor loops should omit it.",
    "- If a loop appears completed without runs, `completed 0/0`, or missing an expected next wakeup, inspect it with list/show and report the invalid state instead of creating replacement loops repeatedly.",
    "- Report the loop id, current phase, next wakeup, and where the user can monitor it in the TUI.",
  ].join("\n")
}

function focusMendCodeBasics() {
  return [
    "MendCode basics:",
    "- For independent work that can run concurrently, call `task` with `background: true` and keep each returned `task_id`; do not poll with `task_status` or `wait` in the same turn.",
    "- If no useful parent work remains, end the turn and let the runtime notification/owner wake resume it; use `task_status` later to inspect, cancel, or collect results.",
    "- Keep `task` in foreground when the next step depends on its result. A foreground task blocks this session, so wait for it to finish before launching the next subagent and do not claim parallel execution.",
    "- Report a subagent as started only after `task` returns its `task_id`; if a foreground call is still running, the next subagent has not started.",
    "- Use `loop` for durable or repeated work after the current turn; do not emulate scheduled iterations inline.",
  ].join("\n")
}

function backgroundSubagentFull() {
  return [
    "MendCode background subagents:",
    "- Before launching any `task` subagent or deliberately waiting/awaiting one, always obtain an explicit user choice (use `question` when it is not already answered): no delegation, foreground/await, or background/notify.",
    "- State the purpose, model/cost tier, edit scope, and completion behavior. Do not silently turn ordinary work into background work or infer consent from task complexity.",
    "- For independent work that can run concurrently, call `task` with `background: true`, keep the returned task_id, and continue useful parent work immediately.",
    "- After a background launch, do not call `task_status` or `wait` just to monitor it in the same turn. If no useful parent work remains, end the turn and let the runtime completion notification/owner wake resume the parent.",
    "- Do not busy-poll, sleep, or retry a timed-out `wait` in the same turn. Use `task_status` later to inspect, rediscover, collect, or `cancel` a task.",
    "- Keep `task` in foreground when the very next step depends on its result; if background work is already running, end the turn instead of waiting synchronously.",
    "- A `wait` timeout releases only the waiter and does not cancel the child. Background completion, failure, cancellation, and needs-input notifications automatically deliver at most one coalesced internal runtime wake to an idle parent; it is not a user message. This is the default CLI behavior and can be disabled with `subagent_owner_wake: false`.",
    "- Collect relevant background results before claiming completion; surface failed, waiting, or retrying tasks honestly.",
    "- Background subagents are runtime-scoped concurrent jobs, not durable scheduled workflows. Use `loop` for monitored repetition or wakeups after MendCode exits.",
  ].join("\n")
}

function loopWorkflowFull() {
  return [
    "MendCode Loop Workflow full contract:",
    "- A loop is a durable workflow backed by MendCode storage, a root session, Agent View state, loop runs, and a scheduler/service wakeup path.",
    "- The normal user-facing flow is chat-first through the `loop` tool: when the user asks to convert the current session into a loop, create a Loop Workflow for that objective, obtain confirmation when activation is not already explicit, activate it, and let the loop runner own future iterations.",
    "- Do not satisfy loop requests by performing all iterations inline in the current assistant turn. Inline iteration text is only a short preview when explicitly framed as a dry-run preview.",
    "- Drafts should capture name, objective, prompt, cadence or manual run mode, an optional iteration cap, max wall-clock runtime when useful, stop condition, permission mode, provider/model, agent profile, and whether report-only is required.",
    "- Choose the budget mode from the user's completion intent: `max-goal` with concrete completion criteria for a verifiable goal, `unbounded-monitor` without `maxTurns` for a recurring scheduled job, and `fixed` with a positive `maxTurns` for an exact iteration count.",
    "- Keep completion policy separate from wakeup policy. A positive `maxTurns` on `max-goal` is a safety cap rather than a schedule; finish as soon as the goal is verified and do not spread work across every available turn.",
    "- A recurring job still needs an objective, but it describes what every wakeup should do rather than a condition for completing after the first successful run. Use interval, daily with an explicit timezone, self-paced, adaptive, or external-signal triggers as requested.",
    "- Treat `needs_input` as a durable permission or user-decision wait that resumes the same run after resolution. Do not mark it complete/failed or create a duplicate loop; persisted `nextWakeup` remains scheduling truth while `/loops` renders its live countdown.",
    "- When model/provider is unspecified and it matters for cost, speed, capability, or the user's request, ask the user to choose from the configured providers/models that are visible in the session. If no choice is needed, use the current session default.",
    "- Activation should create or reuse the loop root session, show it as Looping/background in Agent View, and ensure the project loop service when available.",
    "- For safe tests, prefer report-only execution: the agent may read and analyze, but edit/write/shell/subagent escalation remains denied unless the user explicitly opts into normal execution.",
    "- If the requested loop objective includes writing, editing, fixing, implementing, coding, or creating files, that is explicit normal-execution intent; do not downgrade it to report-only just because it is a loop.",
    "- For a bounded test loop such as five directory-inspection iterations, create a loop with a 5-run cap, report-only permissions, a concise per-run diff/new-findings report, and a final summary after the fifth run.",
    "- Never use a zero iteration cap. Use positive maxTurns for bounded/fixed work; max-goal may omit maxTurns when no cap is configured, and unbounded-monitor cadence must omit it so scheduled loops do not complete as 0/0 before their first run.",
    "- Before recreating a loop, inspect existing workflows with list/show. A loop in completed 0/0, no-runs, or missing-next-wakeup state is an invalid workflow to report or fix, not a reason to create more loops blindly.",
    "- The loop service is responsible for durable wakeups after the TUI or chat session closes. SSE is a live refresh channel for open TUIs; storage is the source of truth when the TUI reopens.",
    "- Prefer the `loop` tool over shell commands. If the tool is unavailable, the CLI namespace is plural `mendcode loops`; never try `mendcode loop`.",
    "- Slash UX: `/loop <objective>` should produce an activate/draft flow; `/loops` should call list; `/loops <loop_id>` may call show with workflowID. For stop/pause/resume/run requests without a visible id, use the loop tool action and let it resolve the current session's contextual loop.",
    "- Fallback/debug commands are: `mendcode loops draft`, `mendcode loops activate <id>`, `mendcode loops tick <id> --execute --report-only`, `mendcode loops show <id>`, `mendcode loops tail <id>`, and `mendcode loops service status`.",
    "- Never promise always-on progress unless the loop service is installed/running for the project or another active scheduler is confirmed.",
    "- Do not push, merge, release, bump versions, run destructive commands, or allow normal edit execution from a loop unless the user's policy and the loop permission mode explicitly allow it.",
  ].join("\n")
}

function focusFallback(focusID: string, reason: string, behavior: string[] = []) {
  return [
    `Active focus: ${focusNames[focusID] || focusID} (${focusID}).`,
    `Harness prompt fallback: ${reason}.`,
    "Use a small MendCode coding baseline: inspect before editing, keep changes scoped, and verify with executable evidence.",
    "Preserve MendCode product identity. Do not claim to be an upstream CLI, company, or official harness.",
    ...(behavior.length ? ["Focus behavior baseline:", ...behavior.map((item) => `- ${item}`)] : []),
  ].join("\n")
}

function tuiMarkdownRendering() {
  return [
    "MendCode TUI rendering:",
    "- Full text Markdown is supported in assistant responses: headings, bold/italic text, inline code, fenced code blocks, links, lists, checklists, blockquotes, and tables.",
    "- Mermaid fenced blocks are supported for flowcharts and other useful diagrams. Built-in local families include flowchart/graph, sequence, ER, class, state, pie, gantt, quadrant, GitGraph, requirement, C4, XY, Sankey, block, packet, architecture, mindmap, timeline, journey, and kanban; other families remain fenced code unless optional `termaid` renders them.",
    "- Valid `#RGB` and `#RRGGBB` values are colorized in ordinary rendered text; code fences, Markdown tables, and inline code stay uncolored.",
    "- Embedded HTML and Markdown images are outside the terminal text rendering contract.",
  ].join("\n")
}

function taskLifecycleContract() {
  return [
    "MendCode task lifecycle and cost policy:",
    "- Use `todowrite` for non-trivial, multi-step, or explicitly requested task lists; skip it for trivial single-step or informational replies.",
    "- Keep TODO items concrete and actionable. Use `pending`, `in_progress`, `completed`, or `cancelled`; keep at most one item `in_progress`, update statuses immediately, and leave blocked work pending while awaiting a focused user answer.",
    "- If progress is blocked on a user choice, ask with `question`, leave the related TODO `pending`, and resume only after the answer; never mark it `completed` while awaiting.",
    "- TODO state is the source of progress; do not manufacture progress or repeat a large checklist in every response.",
    "- For low-risk planning, summaries, monitoring, and repetitive loop iterations, prefer the configured `small`/`subagent` role or another available lower-cost model. Keep edits, security, architecture, and final verification on the stronger configured model unless the user chooses otherwise.",
    "- Never invent model IDs, prices, provider capabilities, or billing behavior. Use only models exposed by the current MendCode session; ask before a model switch when cost, quality, capability, or auth/billing changes matter.",
  ].join("\n")
}

function marketplaceExtensionContract() {
  return [
    "MendCode marketplace and extension contract:",
    "- Marketplace packages are reusable .mendcode bundles, not npm runtime installs. Prefer `mendcode marketplace install <pack-id> [source-id]` and package registry sources over installing arbitrary npm packages.",
    "- Package commands include status/list, create/update/delete-local, install/install-source, enable/disable/disable-all/remove, search/show, and sources/add-source/remove-source; `mendcode packages` is a compatibility alias for `mendcode marketplace`.",
    "- Packages may include commands, agents, modes, skills, plugins, tools, prompts, MCP config, context files, custom pages, widgets, extensions, TUI profiles, themes, and worktree policy. Selectable settings also include models, focus, budget, memory, and permissions.",
    "- Package manifests use `mend-package.json` or `.mendcode/package.json`; installed, enabled, and currently active are distinct states, and compatibility/trust checks may block activation.",
    "- Use the public TUI plugin API from `@mendcode/plugin/tui` for command palette entries, slash commands, routes/pages, dialogs, slots, footer/status entries, themes, KV state, lifecycle cleanup, and simple shell-backed widgets.",
    "- Custom Prompt Mode is one of `minimal`, `focus`, `full`, or `custom`; `custom` reads the bounded project prompt at `.mendcode/prompts/custom.md` while preserving the MendCode boundary. It is project instruction text, not an upstream hidden prompt.",
    "- Custom AI tools live in `.mendcode/tools/*.{ts,js}` and can invoke bounded scripts; expose only the smallest safe interface and keep secrets out of tools and packages.",
    "- Custom pages/routes render through the public plugin route/slot API. Custom widgets use `api.ui.runtime.setWidget` with `aboveEditor`, `belowEditor`, or `sessionBottomDock` placement and clean up with the plugin lifecycle.",
    "- Ctrl+T toggles the current session's TODO view. Ctrl+P -> Customize TUI or `/customize` opens live customization; these controls do not replace the public plugin API.",
    "- Custom pages can build terminal-native ASCII/Solid UIs similar to built-in Usage, Memory Center, or Loop pages when the required state is available through the public API.",
    "- Shell-backed widgets use `api.shell.spawn()` for bounded stdout/stderr streams. This is not a PTY; do not implement full-screen terminal apps, cursor-addressing programs, alternate-screen apps, Doom, or real cava by piping stdout into the main TUI.",
    "- If a package needs private MendCode runtime data, add or request a public API first. Do not import private runtime internals from packages.",
    "- Packages must not include provider tokens, OAuth state, `.env*`, `.mendcode/auth`, local databases, room secrets, cache files, or machine-local run state.",
    "- Disabling a marketplace package should deselect it without deleting project config; removing a package deletes only the installed package copy and state entry.",
  ].join("\n")
}

function fullProductCapabilityCatalog() {
  return [
    "MendCode complete product capability catalog:",
    "",
    "Availability and discovery:",
    "- Distinguish built-in capability, installed configuration, enabled state, connected runtime, and permission to act. A documented surface is not proof that it is active in the current session.",
    "- The actual tool schemas attached to the current model are authoritative. Use only tools present in the session and their declared arguments; provider, model, client, feature flags, package selection, agent permissions, and MCP connection state can change the list.",
    "- Use `mendcode --help` for public workflows, `mendcode help advanced` for support/debug families, Ctrl+P for the live command palette, and `/commands` for the current slash-command inventory. Packages, plugins, skills, project commands, and MCP prompts can extend that inventory at runtime.",
    "",
    "MendCode CLI map:",
    `- Primary public families: ${primaryCommands.map((item) => `\`mendcode ${item}\``).join(", ")}.`,
    `- Advanced/support families: ${advancedCommands.map((item) => `\`mendcode ${item}\``).join(", ")}.`,
    `- Internal/debug families hidden from normal help: ${internalCommands.map((item) => `\`mendcode ${item}\``).join(", ")}. Treat these as diagnostics, not the normal user workflow.`,
    `- Deprecated compatibility aliases: ${deprecatedAliases.map((item) => `\`mendcode ${item}\``).join(", ")}. Prefer the replacement shown by the CLI warning.`,
    "- `mendcode` opens the TUI; `mendcode run [message..]` opens it with a queued message; `mendcode -s <session_id>` restores a session; `mendcode session <operation>` provides automation output; `mendcode chat [message..]` performs a control-plane turn.",
    "- Primary management includes setup/status/doctor, marketplace/packages, Loop Workflows, first-class workflows, memory Dream service, mflow, worktrees, and optional TSM. Mutating, destructive, external, or background-service subcommands remain subject to their confirmation and permission gates.",
    "- Setup/model support: `status`, `doctor`, `check`, `setup status|plan|doctor`, `models status|show|plan|presets|set-default|use-preset`, `providers status|auth|adapters|smoke`, `auth status|login-plan|login`, `permissions status|set-default|set-reviewer-role`, and `focus status|list|show|use`.",
    "- Memory support: `memory status|search|preview|add|edit|delete|propose|list|apply|reject|import-codex|index|config`; Dream adds `status|run|consolidate|tick|daemon|service`.",
    "- Package support: `marketplace status|list|create|update|delete-local|install|install-source|enable|disable|disable-all|remove|search|show|sources|add-source|remove-source`; `install`, `packages`, and deprecated `package` provide narrower or compatibility aliases.",
    "- Automation support: `loops status|list|examples|draft|show|tail|monitor|tick|daemon|service|activate|run|pause|resume|stop` and `workflows list|preview|save|start|show|events|artifacts|pause|resume|stop|delete|retry-task|retry-phase`; singular `workflow` is an accepted compatibility route.",
    "- Collaboration support: `worktree status|plan|create|open|adopt|remove|reset|doctor`, `mflow status|setup|activate|deactivate|remove|scan|relay-guide|plan|doctor`, and `tsm status|plan|setup|install|activate|deactivate|remove|doctor`.",
    "",
    "TUI, command palette, and slash surfaces:",
    "- The TUI provides Home/Agent View, chat sessions, Setup, Usage Insights, Memory Center/Graph/Dream, Loop and Workflow dashboards, Changes review, package/marketplace managers, worktree/TSM/mflow managers, themes, diagnostics, and plugin-defined routes or slots.",
    "- Core navigation/configuration slashes include `/commands`, `/setup`, `/permission`, `/prompt-mode`, `/customize`, `/packages`, `/marketplace`, `/memory-manager`, `/memory-center`, `/memory-graph`, `/stats`, `/loops`, `/workflows`, `/changes`, `/worktrees`, `/tsm`, `/mflow`, `/models`, `/agents`, `/mcps`, `/variants`, `/connect`, `/provider`, `/budget`, `/skills`, `/editor`, `/warp`, `/status`, `/themes`, `/docs`, `/help`, `/diagnostics`, and `/exit`.",
    "- Session slashes include `/new`, `/sessions`, `/rename`, `/loop`, `/bg`, `/timeline`, `/fork`, `/context`, `/compact`, `/undo`, `/redo`, `/timestamps`, `/thinking`, `/copy`, and `/export`. Aliases and plugin-added commands are discoverable through `/commands` rather than assumed from this summary.",
    "- Slash commands may be UI actions, project command templates, skills, or MCP prompts. Do not imitate a slash action with shell commands when the matching native tool or TUI surface exists.",
    "",
    "Native assistant tool families:",
    "- Interaction and state: `question`, `todowrite`, plan review/exit tools when enabled, and the changed-files `review` workspace.",
    "- Local code and files: `bash`, `read`, `glob`, `grep`, `edit`, `write`, `apply_patch`, and optional LSP support. Follow read-before-edit, workspace, permission, and destructive-action boundaries.",
    "- Web and media: `webfetch`, provider-gated web search, and `image_gen` only when a compatible configured image model and permission are present.",
    "- Agent automation: `task`/`task_status` for bounded subagents, `skill` for injected workflows, `loop` for durable repeated or scheduled work, and `workflow` for independent declarative phase/task runs.",
    "- Durable context: `memory` for entries and categories and `memory_graph` for relationship-aware facts. Runtime memory injection remains transient context.",
    "- Browser automation, mflow controls, payment/domain integrations, and other namespaced tools may arrive from MCP servers or custom/plugin tool providers. Their presence and schema, not this catalog, establish availability.",
    "",
    "Custom commands, agents, skills, tools, and plugins:",
    "- MendCode merges global and project configuration directories, with `.mendcode` as the owned project surface and compatible legacy `.opencode` directories when enabled. Project `mendcode.json/jsonc`, instructions, command files, agents/modes, skills, plugins, and tools are discovered through the runtime config loader.",
    "- Custom command templates become slash commands. Skills are discoverable slash entries and load richer instructions through `skill`. Agent definitions can select prompts, models, variants, tools, permissions, and primary/subagent behavior.",
    "- Custom AI tools are loaded from `{tool,tools}/*.{ts,js}` in active config directories and from plugin `tool` exports. A module may expose a default tool or multiple named exports; definitions supply a description, typed argument schema, execution result, and optional metadata.",
    "- Plugin hooks may adjust tool definitions and observe before/after execution. Custom tools still pass through agent permissions, output truncation, session status, and runtime safety boundaries.",
    "",
    "MCP (Model Context Protocol):",
    "- MCP supports configured local process servers (`type: local`, command/args, optional cwd/environment) and remote servers (`type: remote`, URL, optional headers and OAuth). Servers can be enabled, disabled, connected, failed, or waiting for authentication; configuration alone does not mean connected.",
    "- Tools from connected servers are paginated, schema-converted, permission-checked, and exposed as sanitized `<server>_<tool>` names. The exact connected tool schemas are supplied directly to the model.",
    "- Connected MCP prompts are projected into the command/slash catalog; MCP resources are available through the runtime resource APIs and may also be returned by tool calls. Tools, prompts, and resources depend on each server's advertised capabilities.",
    "- Use `/mcps` for the configured TUI toggle surface and `mendcode mcp status|preview|add-local` for the public support route. OAuth credentials, headers, tokens, and server environment values are secrets and must not be printed or packaged.",
    "",
    "Packages, workflows, and runtime features:",
    "- Marketplace bundles can project commands, agents, modes, skills, plugins, tools, prompts, MCP, context, pages, widgets, extensions, themes, TUI profile, worktree policy, and selected model/focus/budget/memory/permission settings. Installation, enablement, compatibility, trust, and active projection are separate checks.",
    "- Loop Workflows own durable cadence and monitored repetition. The first-class `workflow` surface owns one-shot declarative plans with phases, dependencies, artifacts, verification tasks, retries, permissions, budgets, pause/resume/stop, and bounded inspection.",
    "- Setup coordinates providers/auth, model roles and variants, budgets, default approval mode, prompt context, and TUI profile. Current configured values must be read from Setup/runtime status rather than guessed.",
    "- Changes review, persistent memory, usage statistics, session export/import/sharing where enabled, local server/API/SDK clients, worktrees, mflow synchronization, TSM integration, themes, and TUI plugins are product surfaces with their own runtime and permission state.",
  ].join("\n")
}

async function fullKnowledge(root: string) {
  const [config, policy, mflow, tsm] = await Promise.all([
    Promise.resolve(readMendConfig(root)),
    readWorktreePolicy(root),
    readMflowConfig(root),
    tsmStatus(root),
  ])
  const lines = [
    "MendCode knowledge:",
    "- MendCode is a terminal coding TUI with MendCode-owned runtime configuration.",
    "- Public entrypoint: mendcode. Public CLI remains TUI-first.",
    "- Runtime config lives under .mendcode/ and typed runtime modules under src/mendcode/packages/opencode/src/mend/.",
    `- Default focus: ${config.focus?.default || "codex"}. Prompt mode is persisted in .mendcode/prompt-mode.json.`,
    "- Model roles are managed from ~/.mendcode/models.yaml and projected into each checkout generated runtime compatibility config.",
    "- Budget behavior is local policy; dry-run/status commands must not call providers.",
    "",
    "Current project/runtime context:",
    "- Memory inspection and updates should use the `memory` tool; project collaboration may use worktrees, mflow, or optional TSM only when their current status and the user request permit it.",
    "",
    "Memory operating contract:",
    "- Use `memory` when you detect a durable correction, user preference, project rule, or explicit memory-management request. Scope cross-project behavior as global and repo-specific behavior as project.",
    "- Use `memory_graph` only when relationships matter, such as conflicts, supersedes, supports, related facts, or graph validation.",
    "- Search/list/categories before update/delete unless the exact memory id was just returned by a memory tool.",
    "- If `memory` or `memory_graph` is used in a turn, the automatic post-turn extractor is skipped; do not duplicate the same fact through proposals.",
    "- Do not save transient task status, raw logs, secrets, or one-off debugging facts as durable memory.",
    "- Treat injected memories as soft context; current user instructions and repository evidence win.",
  ]
  const integration: string[] = []
  if (mflow.enabled) {
    integration.push(
      "Mflow context:",
      "- Runtime mflow coordination is enabled. File edit locks are enforced by MendCode hooks; do not call mflow manually unless the user asks.",
    )
  }
  if (
    tsm.enabled ||
    tsm.lifecycle === "active" ||
    tsm.lifecycle === "degraded" ||
    (tsm.policy?.mode && tsm.policy.mode !== "off")
  ) {
    integration.push(
      "TSM context:",
      `- TSM lifecycle=${tsm.lifecycle}, enabled=${tsm.enabled}, worktreeCapable=${tsm.worktreeCapable}. Do not install, activate, run, remove, or delegate worktrees to TSM unless explicitly requested.`,
    )
  }
  if (policy.mode === "live-sync" && !mflow.enabled) {
    integration.push(
      "Worktree context:",
      "- Worktree policy mentions live-sync, but Mflow is not fully enabled; keep live operations blocked.",
    )
  }
  return { knowledge: lines.join("\n"), integration: integration.join("\n") }
}

export async function composePromptPolicy(input: ComposeInput = {}): Promise<PromptComposition> {
  const root = input.root || process.env.MENDCODE_ROOT || mendPaths().root
  const mode = assertMode(input.mode || "focus")
  const focusID = input.focusID || "codex"
  const sourceInput = { ...input, root }
  const source = sourceForFocus(focusID)
  const harness = await readPromptSource(source, sourceInput)
  const found = source ? resolvePromptSourceFile(source, sourceInput) : null
  const modelBehavior = promptBehaviorForModel({ focusID, modelID: input.modelID })
  const customFile =
    mode === "custom" && input.customFile === undefined
      ? (await readPromptMode(root)).customPrompt.path
      : input.customFile
  const customPrompt = mode === "custom" ? await readCustomPrompt(root, customFile) : null
  const sections: PromptSection[] = []
  const includeProjectInstructions = mode === "full"
  const includeSkillsByDefault = mode === "full"
  const includeCustomInstructions = mode === "full"
  const includeMcpContext = mode === "full"

  sections.push(
    section({
      id: "mode-boundary",
      label: "MendCode mode boundary",
      source: "mode-boundary",
      text: minimalBoundary(),
    }),
  )

  let basePrompt: string | null = null
  let basePromptSource: PromptBaseSource = "minimal-base"
  let fallbackReason: string | null = null

  if (mode === "focus" || mode === "full") {
    if (harness) {
      basePrompt = harness.text
      basePromptSource = "mendcode-harness-source"
      sections.push(
        section({
          id: "harness",
          label: `${source?.label || focusID} harness prompt`,
          source: "mendcode-harness-source",
          text: harness.text,
        }),
      )
    } else {
      fallbackReason = source
        ? source.sourcePolicy === "oss-source"
          ? "MendCode prompt source file is missing"
          : `focus source policy is ${source.sourcePolicy}`
        : "unknown focus"
      basePromptSource = "opencode-generic-provider-fallback"
      sections.push(
        section({
          id: "fallback",
          label: "MendCode focus fallback",
          source: "opencode-generic-provider-fallback",
          text: focusFallback(focusID, fallbackReason, source?.behavior),
        }),
      )
    }
  }

  if (mode === "custom" && customPrompt?.available) {
    sections.push(
      section({
        id: "project-custom",
        label: customPrompt.name || "Project prompt",
        source: "project-custom",
        text: customPrompt.text,
      }),
    )
  }

  if (mode === "custom" && customPrompt && !customPrompt.available) fallbackReason = customPrompt.fallbackReason

  if ((mode === "focus" || mode === "full") && modelBehavior) {
    sections.push(
      section({
        id: "model-behavior",
        label: modelBehavior.label,
        source: "mendcode-context",
        text: promptBehaviorText(modelBehavior),
      }),
    )
  }

  if (mode === "focus") {
    sections.push(
      section({
        id: "focus-mendcode-basics",
        label: "MendCode basics",
        source: "mendcode-context",
        text: focusMendCodeBasics(),
      }),
    )
  }

  if (mode === "full") {
    sections.push(
      section({
        id: "background-subagents",
        label: "MendCode background subagents",
        source: "mendcode-context",
        text: backgroundSubagentFull(),
      }),
    )

    sections.push(
      section({
        id: "task-lifecycle",
        label: "MendCode task lifecycle and cost policy",
        source: "mendcode-context",
        text: taskLifecycleContract(),
      }),
    )

    sections.push(
      section({
        id: "loop-workflow-brief",
        label: "MendCode Loop Workflow",
        source: "mendcode-context",
        text: loopWorkflowBrief(),
      }),
    )

    sections.push(
      section({
        id: "tui-markdown-rendering",
        label: "MendCode TUI Markdown rendering",
        source: "mendcode-context",
        text: tuiMarkdownRendering(),
      }),
    )
  }

  if (mode === "full") {
    const full = await fullKnowledge(root)
    sections.push(
      section({
        id: "loop-workflow-full",
        label: "MendCode Loop Workflow full contract",
        source: "mendcode-context",
        text: loopWorkflowFull(),
      }),
    )
    sections.push(
      section({
        id: "mendcode-context",
        label: "MendCode knowledge",
        source: "mendcode-context",
        text: full.knowledge,
      }),
    )
    sections.push(
      section({
        id: "product-capability-catalog",
        label: "MendCode complete product capability catalog",
        source: "mendcode-context",
        text: fullProductCapabilityCatalog(),
      }),
    )
    sections.push(
      section({
        id: "marketplace-extension-contract",
        label: "MendCode marketplace and extension contract",
        source: "mendcode-context",
        text: marketplaceExtensionContract(),
      }),
    )
    if (full.integration) {
      sections.push(
        section({
          id: "integrations",
          label: "Active integration knowledge",
          source: "integration-context",
          text: full.integration,
        }),
      )
    }
    sections.push(
      section({
        id: "customization-capabilities",
        label: "MendCode customization capabilities",
        source: "mendcode-context",
        text: composeCustomizationCapabilitySection(),
      }),
    )
  }

  const instructions = sections.map((item) => item.text).join("\n\n")
  const policyInstructions = sections
    .filter((item) => item.id !== "harness")
    .map((item) => item.text)
    .join("\n\n")
  const metadata = promptSourceMetadata(harness?.metadata)
  return {
    mode,
    focusID,
    promptOrigin: mode === "custom" ? "project-custom" : "preset",
    basePromptSource,
    includeProjectInstructions,
    includeSkillsByDefault,
    includeCustomInstructions,
    includeMcpContext,
    usesOpenCodeGenericProviderPrompt: basePromptSource === "opencode-generic-provider-fallback",
    usesMendCodeHarnessPrompt: basePromptSource === "mendcode-harness-source",
    fallbackReason,
    customPrompt: customPrompt
      ? {
          name: customPrompt.name,
          path: customPrompt.path,
          bytes: customPrompt.bytes,
          available: customPrompt.available,
          fallbackReason: customPrompt.fallbackReason,
        }
      : null,
    source:
      mode === "custom"
        ? null
        : source
      ? {
          label: source.label,
          license: source.license,
          sourcePolicy: source.sourcePolicy,
          promptPath: relativePath(root, harness?.path || found),
          sourceRepo: metadata?.sourceRepo || null,
          sourceCommit: metadata?.sourceCommit || null,
          copiedAt: metadata?.copiedAt || null,
          promptAvailable: Boolean(harness),
          rawSourceModeExposed: false,
        }
      : null,
    sections,
    instructions,
    instructionsBytes: Buffer.byteLength(instructions),
    instructionsPreview: preview(instructions),
    policyInstructions,
    policyInstructionsBytes: Buffer.byteLength(policyInstructions),
    policyInstructionsPreview: preview(policyInstructions),
    basePrompt,
    basePromptBytes: Buffer.byteLength(basePrompt || ""),
  }
}

export async function promptModeInstructions(input: ComposeInput = {}) {
  return composePromptPolicy(input)
}
