/**
 * The feature manifest and the `tier` setting (docs/tiers.md). Data and pure functions only, no imports, so the
 * daemon, the thin terminal client and tests share one declaration.
 *
 * One `tier` (minimalist, balanced, full) selects a bundle of switches that already exist; it gives them no new meaning.
 * Setup presets (`minimal`, `full`), TUI density and prompt modes keep their own names and values. A tier only picks
 * which of them to set (TIER_BUNDLES, applied once by `/tier`) and which feature modules are on (FEATURES, live).
 * Every feature stays individually switchable: `features.<id>` beats the tier.
 */

export const TIERS = ["minimalist", "balanced", "full"] as const
export type Tier = (typeof TIERS)[number]
const RANK: Readonly<Record<Tier, number>> = { minimalist: 0, balanced: 1, full: 2 }

/** True when `tier` includes something that belongs to `needs`. No tier set means no gating: everything behaves as before tiers existed. */
export const tierIncludes = (tier: Tier | undefined, needs: Tier) => tier === undefined || RANK[tier] >= RANK[needs]

export const FEATURE_IDS = ["slash_menu", "extensions", "packages", "package_tools", "hooks", "mcp", "codegraph", "subagents", "script_workflows", "jev", "pets", "pet_generator", "voice", "computer", "browser", "code_mode", "snip", "worktree_tool", "usage_resume", "threads", "pr_watch", "pr_review", "output_filters", "forecast", "pi", "thread_mcp", "acp_registry", "storage_compact", "review_order", "session_meta", "fanout", "limit_checkpoint", "graph_context", "handoff", "instruction_includes", "package_capabilities", "caveman", "webfetch_modes", "tool_discovery", "official_packages", "orchestration_receipts", "autoresearch", "web_routing", "panel", "panel_orbit", "panel_models", "file_viewer", "memory_ux", "single_process", "lean_tools", "aux_tools", "harness_tools", "plan_tools", "find_tools", "ui_tool", "orientation", "git_hub", "git_actions", "quota_refresh", "idle_compact", "wait_cache", "compact_notice", "backlog", "task_worktree", "task_fork", "cheap_subagents", "claude_compact", "cache_countdown", "one_tree"] as const
export type FeatureId = (typeof FEATURE_IDS)[number]

/** Where a feature costs the user: tokens on every request (tools, prompt), screen chrome, or a model call of its own. */
export type FeatureCost = "tools" | "prompt" | "chrome" | "calls"
export type FeatureSpec = {
  label: string
  /** The lowest tier that includes it. */
  tier: Tier
  /**
   * `tier`: on when the tier includes it. `permit`: the tier only allows it, its own switch (named in `own`) must also be on,
   * so nothing risky turns itself on. `kernel`: not tier-gated, only safe mode turns it off.
   */
  mode: "tier" | "permit" | "kernel"
  cost: readonly FeatureCost[]
  /** State when no tier is set (today's default); for `permit` it is "allowed". */
  legacy: boolean
  /** On only when the user switched it on (`/tier <id> on`, i.e. `features.<id>: true`): no tier turns it on. Without a tier it keeps `legacy`. */
  optIn?: true
  /** The existing switch that also controls it. */
  own: string
  /** Built-in tool names (`*` globs) that stay out of the model's tool list while the feature is off. */
  tools?: readonly string[]
  /** The `experimental` flag that carries it. */
  flag?: string
  experimental?: true
  /** Safe mode (`--safe-mode`) turns it off. */
  safe?: true
  /** Settings forced while it is off, only where the setting exists: `undefined` removes the key, an object merges. */
  off?: Readonly<Record<string, unknown>>
  doc: string
}

export const FEATURES: Readonly<Record<FeatureId, FeatureSpec>> = {
  slash_menu: { label: "Slash menu layouts", tier: "minimalist", mode: "kernel", cost: ["chrome"], legacy: true, own: "/customize · slashMenu · slashCommands (minimalist lists 20 commands, flat)", safe: true, doc: "docs/customize.md" },
  panel: { label: "Session panel cards", tier: "balanced", mode: "permit", cost: ["chrome"], legacy: true, own: "/panel", doc: "docs/sidebar.md" },
  panel_orbit: { label: "Session galaxy", tier: "full", mode: "permit", cost: ["chrome"], legacy: true, own: "/panel galaxy", doc: "docs/sidebar.md" },
  panel_models: { label: "Panel model tokens", tier: "balanced", mode: "permit", cost: ["chrome"], legacy: true, own: "/panel ledger", doc: "docs/sidebar.md" },
  // A click on a path opens the file in the right slot (a page on a narrow terminal). Off with no tier and in minimalist, where a click leaves the path to the terminal's own link; `pathClick: panel` turns it on anywhere.
  file_viewer: { label: "File viewer (click a path)", tier: "balanced", mode: "tier", cost: ["chrome"], legacy: false, own: "/customize · pathClick · /open", doc: "docs/file-viewer.md" },
  // /git: tabs for Changes, Commit and Worktrees, and a local commit of the files you tick. Nothing leaves the machine. Off with no tier and in minimalist, where /changes and /worktrees are the pages they were.
  git_hub: { label: "Git page (review, commit, worktrees)", tier: "balanced", mode: "tier", cost: ["chrome"], legacy: false, own: "/git · git.defaultTab", doc: "docs/git.md" },
  // Push, "publish to GitHub (private)" and "create pull request" from the Git page, and its PR tab: they reach the network through the user's own git and gh logins. Allowed from balanced; `experimental.git_actions` must also be on, so no tier turns network on by itself. No tool, no prompt text.
  git_actions: { label: "Git page push and pull request", tier: "balanced", mode: "permit", cost: [], legacy: true, own: "experimental.git_actions", flag: "git_actions", doc: "docs/git.md" },
  memory_ux: { label: "Memory consent and management", tier: "minimalist", mode: "kernel", cost: [], legacy: true, own: "memoryEnabled · memoryRequireApproval · /memory", safe: true, doc: "docs/memory.md" },
  // Not a feature that turns on or off: the setting every tier has, with the value the minimalist bundle picks.
  single_process: { label: "One process per terminal (solo)", tier: "minimalist", mode: "kernel", cost: [], legacy: true, own: "/customize · processMode · --process (auto in every tier: one process while one terminal is open, less RAM; a second client moves the daemon to its own process; solo keeps it in the terminal; daemon keeps the separate process)", safe: true, doc: "docs/design/memory-single-process.md" },
  official_packages: { label: "Official package kit", tier: "balanced", mode: "permit", cost: [], legacy: true, own: "Explicit local catalog install", doc: "docs/packages.md" },
  orchestration_receipts: { label: "Durable orchestration receipts", tier: "minimalist", mode: "kernel", cost: [], legacy: true, own: "clientRequestId on thread mutations", safe: true, doc: "docs/thread-mcp.md" },
  autoresearch: { label: "Metric experiments", tier: "full", mode: "permit", cost: [], legacy: true, own: "On-demand metric-experiment skill", doc: "docs/loops.md" },
  web_routing: { label: "Explicit web routes", tier: "balanced", mode: "permit", cost: [], legacy: true, own: "On-demand explicit-web skill", doc: "docs/tools-web.md" },
  review_order: { label: "Suggested review order", tier: "balanced", mode: "tier", cost: [], legacy: true, own: "/changes · o preview · O apply", doc: "docs/changes.md" },
  session_meta: { label: "Session lifecycle", tier: "balanced", mode: "tier", cost: ["tools"], legacy: false, own: "/tier session_meta on", tools: ["session_meta"], safe: true, doc: "docs/sessions.md" },
  fanout: { label: "Fan-out comparison", tier: "full", mode: "tier", cost: [], legacy: false, own: "/tier fanout on", safe: true, doc: "docs/agents.md" },
  // Permit: nothing runs until the user lists a provider in `quotaRefresh`; the tier never turns it on, safe mode always turns it off.
  quota_refresh: { label: "Quota refresh probe", tier: "minimalist", mode: "permit", cost: ["calls"], legacy: true, own: "/customize · quotaRefresh (off until a provider is listed; each probe spends some of the quota it measures)", safe: true, doc: "docs/usage-limit.md" },
  limit_checkpoint: { label: "Pre-limit checkpoint", tier: "balanced", mode: "tier", cost: [], legacy: false, own: "/tier limit_checkpoint off", doc: "docs/usage-limit.md" },
  graph_context: { label: "Graph orientation and impact", tier: "balanced", mode: "permit", cost: ["prompt"], legacy: false, optIn: true, own: "/tier graph_context on (off until then: the model calls the graph tools itself)", doc: "docs/code-graph.md" },
  // Sessions sharing one checkout: a line on a tool result only when it names a file another live session is changing; nothing while a session works alone.
  one_tree: { label: "One tree: sessions sharing a checkout", tier: "balanced", mode: "tier", cost: ["prompt"], legacy: false, own: "/tier one_tree off", doc: "docs/one-tree.md" },
  handoff: { label: "Focused session handoff", tier: "balanced", mode: "tier", cost: [], legacy: false, own: "/handoff <goal>", doc: "docs/sessions.md" },
  instruction_includes: { label: "Instruction includes", tier: "balanced", mode: "tier", cost: ["prompt"], legacy: false, own: "@relative/path in AGENTS.md", doc: "docs/prompt-modes.md" },
  package_capabilities: { label: "Package capability preview", tier: "balanced", mode: "tier", cost: [], legacy: false, own: "/marketplace preview", doc: "docs/packages.md" },
  caveman: { label: "Caveman prose style", tier: "balanced", mode: "permit", cost: [], legacy: false, own: "/output-style caveman", doc: "docs/prompt-modes.md" },
  webfetch_modes: { label: "PDF and repository fetch", tier: "balanced", mode: "permit", cost: [], legacy: false, own: "webfetch mode", doc: "docs/tools-web.md" },
  tool_discovery: { label: "Deferred MCP tools", tier: "full", mode: "tier", cost: [], legacy: false, own: "experimental.tool_discovery", doc: "docs/tool-discovery.md" },
  // The two request-size features (docs/tool-discovery.md, "Lean catalogue"): on with any tier, off with none, so an unconfigured install is unchanged.
  lean_tools: { label: "Lean tool catalogue", tier: "minimalist", mode: "tier", cost: ["tools"], legacy: false, own: "/tier lean_tools off", doc: "docs/tool-discovery.md" },
  harness_tools: { label: "MendCode tools inside Claude Code", tier: "balanced", mode: "tier", cost: ["tools"], legacy: false, own: "/tier harness_tools on", doc: "docs/claude-code.md" },
  // Off in every tier: these join the request when their situation arises, or with tool_search, instead of riding along in every first request (docs/tool-discovery.md).
  aux_tools: { label: "Auxiliary tools in every request", tier: "balanced", mode: "tier", cost: ["tools"], legacy: true, optIn: true, own: "/tier aux_tools on", doc: "docs/tool-discovery.md" },
  plan_tools: { label: "Plan and goal tools in every request", tier: "full", mode: "tier", cost: ["tools"], legacy: true, optIn: true, own: "/tier plan_tools on", doc: "docs/tool-discovery.md" },
  // On from minimalist: without them its first request fell under the provider's 1,024-token cacheable minimum and the second request was always paid in full (docs/tool-discovery.md).
  find_tools: { label: "glob and grep in every request", tier: "minimalist", mode: "tier", cost: ["tools"], legacy: true, own: "/tier find_tools off", doc: "docs/tool-discovery.md" },
  // customize_ui listed: a model asked to hide a bar used it 20 times of 20; deferred, 14 of 20 (docs/tool-discovery.md).
  ui_tool: { label: "Screen settings tool in every request", tier: "balanced", mode: "tier", cost: ["tools"], legacy: true, own: "/tier ui_tool on", doc: "docs/tool-discovery.md" },
  orientation: { label: "Orientation block in the first message", tier: "balanced", mode: "tier", cost: ["prompt"], legacy: false, own: "/tier orientation off", doc: "docs/tool-discovery.md" },
  acp_registry: { label: "ACP registry", tier: "full", mode: "tier", cost: [], legacy: false, own: "/tier acp_registry on", safe: true, doc: "docs/acp-engine.md" },
  storage_compact: { label: "Lossless storage compaction", tier: "minimalist", mode: "permit", cost: [], legacy: true, own: "storage --compact --offline --dir DATA", doc: "docs/storage.md" },
  extensions: { label: "Extensions", tier: "minimalist", mode: "kernel", cost: [], legacy: true, own: "MENDCODE_EXTENSIONS=0 · --pure", safe: true, doc: "docs/extensions.md" },
  packages: { label: "Installed packages", tier: "minimalist", mode: "kernel", cost: ["prompt", "tools"], legacy: true, own: "disabledPackages · /marketplace", safe: true, doc: "docs/packages.md" },
  package_tools: { label: "Package chat tools", tier: "balanced", mode: "tier", cost: ["tools"], legacy: false, own: "features.package_tools", tools: ["packages"], safe: true, doc: "docs/packages.md" },
  usage_resume: { label: "Auto-resume at usage limit", tier: "minimalist", mode: "tier", cost: [], legacy: true, own: "/limit cancel", doc: "docs/usage-limit.md" },
  hooks: { label: "Shell hooks", tier: "minimalist", mode: "kernel", cost: [], legacy: true, own: "MENDCODE_HOOKS=0", safe: true, doc: "docs/hooks.md" },
  mcp: { label: "MCP servers", tier: "full", mode: "tier", cost: ["tools"], legacy: true, own: "mcp.json", tools: ["mcp__*", "mcp_resource_*"], safe: true, doc: "docs/mcp-oauth.md" },
  // REST pending approval belongs to MCP's full tier; its security gate is mandatory even with a feature override.
  thread_mcp: { label: "Thread MCP bridge", tier: "full", mode: "permit", cost: ["tools"], legacy: false, own: "/tier thread_mcp on claude|codex|acp:<name>", safe: true, doc: "docs/thread-mcp.md" },
  codegraph: { label: "Code graph tools", tier: "balanced", mode: "tier", cost: ["tools"], legacy: true, own: "MENDCODE_CODEGRAPH=0", tools: ["graph_*", "code_search"], doc: "docs/code-graph.md" },
  subagents: { label: "Sub-agents (task)", tier: "balanced", mode: "tier", cost: ["tools"], legacy: true, own: "tools.task", tools: ["task"], doc: "docs/agents.md" },
  claude_compact: { label: "Claude Code compacts at MendCode's point", tier: "balanced", mode: "tier", cost: ["calls"], legacy: false, own: "/tier claude_compact off · compactAtTokens", doc: "docs/claude-code.md" },
  cheap_subagents: { label: "Sub-agents on a cheaper model", tier: "balanced", mode: "tier", cost: ["calls"], legacy: false, own: "/tier cheap_subagents off · /model roles · subagent", doc: "docs/agents.md" },
  // One optional `isolation` argument on `task`: the child gets a git worktree of HEAD and its changes end on a branch of their own, never merged. Off with no tier, so the argument costs nothing there.
  task_worktree: { label: "Sub-agent worktrees", tier: "full", mode: "tier", cost: ["tools"], legacy: false, own: "/tier task_worktree off · task isolation: \"worktree\"", doc: "docs/agents.md" },
  // One optional `fork` argument on `task`: a new child starts from the parent's latest request (same model, so its cached prefix is read) instead of a fresh context. Opt-in: a fork reads the parent's whole context on every call, cached or not (docs/agents.md#forked-sub-agents).
  task_fork: { label: "Sub-agent forks (parent's cached context)", tier: "full", mode: "permit", cost: ["tools", "calls"], legacy: false, optIn: true, experimental: true, own: "/tier task_fork on · task fork: true", doc: "docs/agents.md" },
  script_workflows: { label: "Script workflows", tier: "balanced", mode: "tier", cost: ["tools"], legacy: true, own: "tools.workflow_script", tools: ["workflow_script"], doc: "docs/workflows.md" },
  jev: { label: "Adaptive reasoning (JEV)", tier: "full", mode: "tier", cost: ["calls"], legacy: false, own: "experimental.reasoning_auto", flag: "reasoning_auto", doc: "docs/reasoning.md" },
  pets: { label: "Pet companion", tier: "full", mode: "tier", cost: ["chrome"], legacy: true, own: "pet", off: { pet: undefined }, doc: "docs/customize.md" },
  pet_generator: { label: "Experimental pet generator", tier: "full", mode: "permit", cost: ["calls"], legacy: false, own: "/pet new (explicit confirmation)", experimental: true, safe: true, doc: "docs/customize.md" },
  voice: { label: "Voice dictation", tier: "full", mode: "permit", cost: ["calls"], legacy: true, own: "voice.enabled", off: { voice: { enabled: false } }, doc: "docs/voice.md" },
  computer: { label: "Computer control", tier: "balanced", mode: "permit", cost: ["tools"], legacy: false, optIn: true, own: "/tier computer on (macOS; off until then)", tools: ["computer_*"], doc: "docs/computer.md" },
  browser: { label: "Headless browser", tier: "full", mode: "permit", cost: ["tools"], legacy: true, own: "MENDCODE_BROWSER=1", tools: ["browser"], doc: "docs/browser.md" },
  code_mode: { label: "Code Mode", tier: "full", mode: "permit", cost: ["tools"], legacy: true, own: "experimental.code_mode", flag: "code_mode", doc: "docs/code-mode.md" },
  // One compaction call of its own, in an idle session of at least `idleCompactAtTokens`, just before the provider's prompt cache expires: the history is read at the cached price one last time instead of at the full price on the next message. Off with no tier.
  idle_compact: { label: "Compact while idle", tier: "full", mode: "tier", cost: ["calls"], legacy: false, own: "/tier idle_compact off · /settings · idle compact", doc: "docs/compaction.md" },
  // No call of its own: a native session on Anthropic whose calls were twice 5 to 60 minutes apart writes its cache at the 1-hour lifetime from then on (writes at 2x the input price instead of 1.25x; each later wait reads the prefix instead of rewriting it). Ignored while `promptCacheTtl` is `1h`. Off with no tier.
  // A footer segment, never placed by a tier: full allows it, `/footer +warm` shows it. How long the prompt cache of the last call lasts, from the lifetime the idle compaction uses.
  cache_countdown: { label: "Cache countdown (footer)", tier: "full", mode: "permit", cost: ["chrome"], legacy: false, own: "/footer +warm", doc: "docs/layout.md" },
  wait_cache: { label: "1h cache after long waits", tier: "full", mode: "tier", cost: [], legacy: false, own: "/tier wait_cache off · /settings · cache ttl", doc: "docs/prompt-cache.md" },
  snip: { label: "Snip stale output", tier: "full", mode: "permit", cost: ["tools"], legacy: true, own: "experimental.snip", flag: "snip", doc: "docs/compaction.md" },
  worktree_tool: { label: "Worktree tool", tier: "full", mode: "permit", cost: ["tools"], legacy: true, own: "experimental.worktree_tool", flag: "worktree_tool", doc: "docs/worktrees.md" },
  threads: { label: "Thread tools", tier: "balanced", mode: "tier", cost: ["tools"], legacy: false, own: "experimental.thread_tools", tools: ["threads"], flag: "thread_tools", doc: "docs/sessions.md" },
  // Allowed from balanced, but it reaches the network through `gh`: the user's own switch must also be on, so it is never on by itself.
  pr_watch: { label: "PR watch", tier: "balanced", mode: "permit", cost: ["tools"], legacy: true, own: "experimental.pr_watch", tools: ["pr_watch"], flag: "pr_watch", doc: "docs/pr-watch.md" },
  // Model calls and GitHub posts with the user's own gh login: the tier only allows it, experimental.pr_review turns it on, and the repo's own config turns publishing on.
  pr_review: { label: "PR reviewer", tier: "balanced", mode: "permit", cost: ["calls"], legacy: false, own: "experimental.pr_review", flag: "pr_review", doc: "docs/pr-review.md" },
  // Both are savings aids, not costs: the filters add a one-line header only when they shorten a result, the forecast is one footer segment.
  output_filters: { label: "Command output filters", tier: "balanced", mode: "tier", cost: [], legacy: false, own: "tool_output.filters", doc: "docs/advanced-config.md" },
  forecast: { label: "Context forecast", tier: "balanced", mode: "tier", cost: ["chrome"], legacy: false, own: "/footer +forecast", doc: "docs/layout.md" },
  // One muted transcript line, once per crossing, when the context reaches `compactNoticePercent` (80) of the compaction point: tokens left, turns left when the session has three turns of growth, and `/compact`. No call, no prompt text. Off with no tier.
  compact_notice: { label: "Notice before a compaction", tier: "balanced", mode: "tier", cost: ["chrome"], legacy: false, own: "/tier compact_notice off · /settings · compact notice", doc: "docs/compaction.md" },
  // The user's own list of pending things for a project, kept by the daemon across sessions. No tool and no prompt text: the model reads it with `mendcode backlog list` and never writes it. Off with no tier.
  backlog: { label: "Project backlog", tier: "full", mode: "tier", cost: [], legacy: false, own: "/tier backlog off · /backlog · /panel widget backlog", doc: "docs/sidebar.md" },
  // An outside program with its own login and tools: the tier only allows it, `pi.json` (or `/tier pi on`) opts in, and nothing starts until a session picks a pi model.
  pi: { label: "pi engine (RPC)", tier: "full", mode: "permit", cost: [], legacy: true, own: "pi.json · /tier pi on", safe: true, doc: "docs/pi-engine.md" },
}

/**
 * What `/tier <name>` writes to the existing switches, once, like a setup preset (it does not touch the preset or its
 * memory and approval choices). Later changes to a single switch stay as they are.
 */
export type TierBundle = {
  /** Settings `view`: the chat presentation (transcript detail). */
  view: "minimal" | "balanced" | "full"
  /** Project prompt mode (`/prompt-mode`). */
  promptMode: "minimal" | "focus" | "full"
  /** Terminal profile `density`. */
  density: "compact" | "comfortable"
  /** Terminal profile `rightSidebar`: hidden for minimalist, the user's choice otherwise. */
  hideRightSidebar: boolean
  /** Terminal profile `processMode`: every tier hosts the daemon in the terminal's own process while one terminal is open (`auto`: less RAM; a hard-killed terminal interrupts its running turn; slower first frame); `daemon` keeps the separate one. */
  processMode: "auto" | "daemon"
  summary: string
}
export const TIER_BUNDLES: Readonly<Record<Tier, TierBundle>> = {
  minimalist: { view: "minimal", promptMode: "minimal", density: "compact", hideRightSidebar: true, processMode: "auto", summary: "Almost no chrome and a small prompt that still carries your AGENTS.md. No MCP, code graph, sub-agents, JEV, pets or voice. Essentials stay." },
  balanced: { view: "balanced", promptMode: "focus", density: "comfortable", hideRightSidebar: false, processMode: "auto", summary: "The normal experience: your AGENTS.md and the skill catalog in the prompt, and the savings tools (code graph, sub-agents), and hold-space dictation where it runs on the machine. No MCP, JEV, pets or other extras." },
  full: { view: "full", promptMode: "full", density: "comfortable", hideRightSidebar: false, processMode: "auto", summary: "Everything: MCP, JEV when configured, pets, voice and Code Mode where their own switches allow." },
}

/**
 * The slash commands the minimalist tier lists in its menu, `/help` and palette (docs/tiers.md, "Slash commands"): twenty-one, three
 * fewer than pi's twenty-four. `tier` and `settings` stay in it so every other command is one step away. Every other built-in
 * command is listed from balanced (`slashTier`); a command of a feature also keeps that feature's own gate. Order is the menu's own.
 */
export const MINIMALIST_SLASH = ["new", "sessions", "model", "connect", "compact", "settings", "fork", "export", "copy", "rename", "usage", "tree", "undo", "redo", "plan", "permissions", "tier", "trust", "help", "shortcuts", "quit"] as const

/** The lowest tier that lists a built-in slash command. */
export const slashTier = (name: string): Tier => (MINIMALIST_SLASH as readonly string[]).includes(name) ? "minimalist" : "balanced"

/**
 * Estimated tokens of system prompt plus tool definitions on every request, per tier, for the test pool of tools
 * (packages/daemon/test/tier.test.ts holds each tier to it). Setup and the tutorial quote it as "what it costs in context".
 */
export const TIER_BASELINE_TOKENS: Readonly<Record<Tier, number>> = { minimalist: 3_500, balanced: 5_000, full: 6_400 }

/** The slice of Settings the manifest reads; a real Settings object fits. */
export type TierSettings = {
  tier?: Tier | undefined
  features?: Partial<Record<FeatureId, boolean>> | undefined
  experimental?: Record<string, unknown> | undefined
  tools?: Record<string, boolean> | undefined
}
export type FeatureWhy = "safe-mode" | "override" | "setting" | "tier" | "legacy"
export type FeatureState = { on: boolean; why: FeatureWhy }
export type TierOptions = { safeMode?: boolean | undefined }

export const isFeatureId = (value: string): value is FeatureId => (FEATURE_IDS as readonly string[]).includes(value)
export const isTier = (value: unknown): value is Tier => typeof value === "string" && (TIERS as readonly string[]).includes(value)

/** Precedence: safe mode, then `features.<id>`, then the feature's own flag, then the tier, then today's default. */
export function featureState(settings: TierSettings, id: FeatureId, options: TierOptions = {}): FeatureState {
  const spec = FEATURES[id]
  if (options.safeMode && spec.safe) return { on: false, why: "safe-mode" }
  const forced = settings.features?.[id]
  if (forced !== undefined && spec.mode !== "kernel") return { on: forced, why: "override" }
  if (spec.optIn) return settings.tier === undefined && spec.legacy ? { on: true, why: "legacy" } : { on: false, why: "tier" }
  if (spec.mode === "tier" && spec.flag) {
    const flag = settings.experimental?.[spec.flag]
    if (typeof flag === "boolean") return { on: flag, why: "setting" }
  }
  if (settings.tier === undefined) return { on: spec.legacy, why: "legacy" }
  return { on: spec.mode === "kernel" || tierIncludes(settings.tier, spec.tier), why: "tier" }
}
export const featureOn = (settings: TierSettings, id: FeatureId, options: TierOptions = {}) => featureState(settings, id, options).on

/**
 * The settings the daemon acts on: the stored ones with the tier's effects applied as defaults. Tools of a feature that is
 * off are denied unless the user's own `tools` entry says otherwise; a flag carried by a feature follows it. Nothing is
 * written back. Without a tier, safe mode or an override the same object comes back.
 */
export function effectiveSettings<S extends object>(settings: S, options: TierOptions = {}): S {
  const input = settings as S & TierSettings & Record<string, unknown>
  const denied: Record<string, boolean> = {}
  const experimental: Record<string, unknown> = { ...(input.experimental ?? {}) }
  const rest: Record<string, unknown> = {}
  let changed = false
  for (const id of FEATURE_IDS) {
    const spec = FEATURES[id]
    const state = featureState(input, id, options)
    if (state.why === "legacy" || state.why === "setting") continue
    if (spec.flag) {
      if (state.on && spec.mode === "tier" && experimental[spec.flag] !== true) { experimental[spec.flag] = true; changed = true }
      if (!state.on && experimental[spec.flag] !== false) { experimental[spec.flag] = false; changed = true }
    }
    if (state.on) continue
    for (const pattern of spec.tools ?? []) { denied[pattern] = false; changed = true }
    for (const [key, value] of Object.entries(spec.off ?? {})) {
      const current = (input as Record<string, unknown>)[key]
      if (current === undefined) continue
      rest[key] = value === undefined ? undefined : typeof value === "object" && value !== null && typeof current === "object" && current !== null ? { ...current, ...value } : value
      changed = true
    }
  }
  // Full-tier MCP defaults to discovery, but an explicit false remains authoritative.
  if (input.experimental?.tool_discovery === undefined && featureOn(input, "tool_discovery", options) && featureOn(input, "mcp", options)) {
    experimental.tool_discovery = true
    changed = true
  }
  if (!changed) return settings
  const result: Record<string, unknown> = { ...input, ...rest, tools: { ...denied, ...(input.tools ?? {}) } }
  for (const [key, value] of Object.entries(rest)) if (value === undefined) delete result[key]
  if (Object.keys(experimental).length) result.experimental = experimental
  return result as S
}

export type TierRow = {
  id: FeatureId
  label: string
  tier: Tier
  mode: FeatureSpec["mode"]
  cost: readonly FeatureCost[]
  /** Included by each tier, in TIERS order. */
  perTier: readonly [boolean, boolean, boolean]
  now: FeatureState
  /** True when `features.<id>` or its own flag decides, not the tier. */
  overridden: boolean
}
/** One row per feature: what each tier includes, what is on now and why. The data of `/tier` and `/experimental`. */
export function tierRows(settings: TierSettings, options: TierOptions = {}): TierRow[] {
  return FEATURE_IDS.map((id) => {
    const spec = FEATURES[id]
    const now = featureState(settings, id, options)
    return {
      id, label: spec.label, tier: spec.tier, mode: spec.mode, cost: spec.cost,
      perTier: [tierIncludes("minimalist", spec.tier), tierIncludes("balanced", spec.tier), tierIncludes("full", spec.tier)],
      now,
      overridden: now.why === "override" || now.why === "setting",
    }
  })
}

/** The features that differ between two tiers, so a tier change shows what it adds and removes. */
export function tierDiff(from: Tier, to: Tier): { added: FeatureId[]; removed: FeatureId[] } {
  const added: FeatureId[] = [], removed: FeatureId[] = []
  for (const id of FEATURE_IDS) {
    const was = tierIncludes(from, FEATURES[id].tier), now = tierIncludes(to, FEATURES[id].tier)
    if (now && !was) added.push(id)
    if (was && !now) removed.push(id)
  }
  return { added, removed }
}
