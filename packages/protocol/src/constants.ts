// No runtime dependency on zod (imported by wire.ts for thin clients).
export const PROTOCOL_VERSION = 1 as const

/** Text-only estimate in UTF-16 code units, rounded up. Provider usage remains authoritative. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4)

/** The native engine's compaction threshold when the compactAtTokens setting is unset; the footer's ctx % uses the same number. */
export const DEFAULT_COMPACT_AT_TOKENS = 160_000

/**
 * Footer segments a user can toggle and order (`/footer`). `notice` always renders when there is one. `forecast` (turns
 * left before compaction, from the last turns' growth) follows the tier's `forecast` feature unless `/footer` places it. The ten before it
 * (session cache hit, token counters, reasoning effort, background jobs, sandbox mode, vim mode, update available,
 * first-token time, output speed, session spend) are opt-in: no default order includes them.
 * `/footer stats` sets the telemetry order in `FOOTER_STATS`.
 */
export const FOOTER_SEGMENTS = ["state", "permission", "context", "model", "quota", "today", "cost", "branch", "notice", "goal", "cache", "tokens", "effort", "jobs", "sandbox", "vim", "update", "ttft", "tps", "spend", "forecast", "ctx", "hit", "think", "calls", "directory", "codegraph", "time", "warm"] as const
export type FooterSegment = (typeof FOOTER_SEGMENTS)[number]
/**
 * The segments added after `forecast`: stat parts of the session stats registry, then the project directory, the code graph, the clock
 * and the prompt cache's countdown (`warm`, only where the `cache_countdown` feature allows it). Opt-in, left out of the full view's everything-on footer.
 */
export const FOOTER_OPT_IN: readonly FooterSegment[] = ["ctx", "hit", "think", "calls", "directory", "codegraph", "time", "warm"]
export const DEFAULT_FOOTER: FooterSegment[] = ["state", "permission", "context", "quota", "notice"]
/** The stats footer: token flow, cache hit, spend and speed. */
export const FOOTER_STATS: FooterSegment[] = ["state", "tokens", "cache", "spend", "ttft", "tps", "notice"]

/**
 * What a model is used for. Every role falls back to `main`; a session's own choice (`/model`) replaces
 * `main` for that session. `plan` answers turns in plan mode, `subagent` runs `task`, `dream` curates memory,
 * `aside` answers `/btw` side questions. `small` is the shared default for cheap auxiliary calls (today: `aside`
 * falls back to it before `main`). `permissionReviewer` classifies a pending approval in `smart` permission mode and
 * has no fallback: without its own setting no reviewer runs. Roles added later stay at the end so stored settings keep their meaning.
 */
export const MODEL_ROLES = ["main", "plan", "subagent", "compaction", "dream", "aside", "small", "permissionReviewer", "memoryExtractor", "memoryAssistant", "memoryConsolidator", "title", "summary", "workflow"] as const
export type ModelRole = (typeof MODEL_ROLES)[number]
/**
 * Every reasoning level a model may offer. `max` is the top level some catalogs list (DeepSeek, GLM, the Codex catalog's
 * gpt-6 models) and `none` turns thinking off where the catalog offers that; both were added after the first five, so
 * they come last and every stored value keeps its meaning. A model's own `efforts` list says which of these it takes.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "none"] as const
/** Color marks a session can carry (in its agent-view metadata, `session.agent-view.metadata.patch`). */
export const SESSION_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const
export type SessionColor = (typeof SESSION_COLORS)[number]
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * How the native engine asks providers to cache the prompt (`promptCache` setting). `legacy` (default) = one
 * `prompt_cache_key` per session and the Anthropic breakpoints MendCode always set (system, last user message) ·
 * `off` = no cache hint of any kind · `smart` = keys per lineage (session + compaction generation) and Anthropic
 * breakpoints at tools, system and the last user message. See docs/prompt-cache.md.
 */
export const PROMPT_CACHE_MODES = ["legacy", "off", "smart"] as const
export type PromptCacheMode = (typeof PROMPT_CACHE_MODES)[number]

/** `serviceTier` setting (`/fast`): `fast` asks OpenAI-family Responses hosts for priority processing (faster, billed higher); `standard` is the default. */
export const SERVICE_TIERS = ["standard", "fast"] as const
export type ServiceTier = (typeof SERVICE_TIERS)[number]

/** `outputStyle` setting (`/output-style`): tone presets the native engine appends to its system prompt. `default` adds nothing. */
export const OUTPUT_STYLES = ["default", "explanatory", "learning", "terse", "caveman"] as const
export type OutputStyle = (typeof OUTPUT_STYLES)[number]

/**
 * The boolean `experimental` settings, all off when unset (`/experimental` lists and toggles them). The schema in
 * queries.ts keeps its own keys; a test holds both lists equal. `primary_tools` is a list, not a flag.
 */
export const EXPERIMENTAL_FLAGS = [
  { id: "async_tools", summary: "Background tool jobs the model can start and poll", doc: "docs/async-tools.md" },
  { id: "async_questions", summary: "Questions that wait for an answer without blocking the turn", doc: "docs/async-tools.md" },
  { id: "session_recall", summary: "Let the model search earlier sessions of this project", doc: "docs/sessions.md" },
  { id: "auto_recall", summary: "After a compaction, bring back the earlier turns that match each request", doc: "docs/compaction.md" },
  { id: "tool_discovery", summary: "Secondary tool schemas load on demand through tool_search", doc: "docs/tool-discovery.md" },
  { id: "code_mode", summary: "Confined JavaScript that orchestrates tool calls", doc: "docs/code-mode.md" },
  { id: "reasoning_auto", summary: "Pick the reasoning effort per request", doc: "docs/reasoning.md" },
  { id: "snip", summary: "Let the model drop stale tool output from its own context", doc: "docs/compaction.md" },
  { id: "worktree_tool", summary: "Let the model enter and leave a git worktree for this session", doc: "docs/worktrees.md" },
  { id: "thread_tools", summary: "Let the model list, read, message, wait on and interrupt this project's other sessions", doc: "docs/sessions.md" },
  { id: "pr_watch", summary: "Let the model watch a pull request through gh (checks, reviews, conflicts) and wake only on a change", doc: "docs/pr-watch.md" },
  { id: "pr_review", summary: "Review pull requests of a watched repository through gh and publish verified findings once the repo config allows it", doc: "docs/pr-review.md" },
  { id: "git_actions", summary: "Push the branch and create a pull request from the Git page, and read its PR tab, through your own git and gh logins", doc: "docs/git.md" },
  { id: "continue_loop_on_deny", summary: "Keep a loop running after a denied tool call", doc: "docs/permissions.md" },
  { id: "openTelemetry", summary: "Export spans through OTLP when an endpoint is configured", doc: "docs/tracing.md" },
] as const
export type ExperimentalFlag = (typeof EXPERIMENTAL_FLAGS)[number]["id"]

/** `session.events`: the window size when `limit` is absent, and the most a client may ask for. */
export const EVENTS_PAGE_DEFAULT = 200
export const EVENTS_PAGE_MAX = 1000

/** Custom agents: how the agent modes read. `primary` agents are selectable for a session, `subagent` ones are callable by `task`, `all` is both. */
export const AGENT_MODES = ["primary", "subagent", "all"] as const
export type AgentMode = (typeof AGENT_MODES)[number]

/** Largest accepted frame. Anything bigger is a protocol violation, not something to buffer. */
export const MAX_FRAME_BYTES = 256 * 1024

/**
 * Longest text a `session.export` returns (the rest is cut and the ack says `truncated`). The ack is one frame
 * (MAX_FRAME_BYTES) and JSON escaping can double the text, so the daemon also cuts to what the frame allows.
 */
export const EXPORT_MAX_CHARS = 120_000

/** Characters of the user message a timeline entry shows. */
export const TIMELINE_PREVIEW_CHARS = 120

/** Bytes of file content one turn's pre-change snapshot may hold (per turn, all files together); a file over what is left, or a binary one, is skipped and reported. */
export const TURN_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024

/** Longest unsent prompt a session keeps; the client truncates to it and says so. */
export const MAX_DRAFT_CHARS = 65_536
/** Largest text one paste may send as an attachment (`attachment.put` in parts): the prompt keeps its label, the model gets the text. */
export const TEXT_PUT_MAX_BYTES = 4 * 1024 * 1024
/** Bytes of one `attachment.put` piece: its base64 stays under the command's 190,000-character limit. */
export const ATTACHMENT_PART_BYTES = 140_000

/** Model tokens one Dream run may spend (all its calls together) when the dreamMaxTokens setting is unset. */
export const DREAM_DEFAULT_MAX_TOKENS = 60_000
/** Pinned memories are always injected, so their number is bounded. */
export const MAX_PINNED_MEMORIES = 20

/** How much Evolution does: off = nothing · observe = count recurring corrections/preferences, keep no text, call no model · suggest = propose memories and skill/instruction suggestions for review · auto-safe = also save memory proposals whose category policy is `auto` (never skills, instructions, code or config). */
export const EVOLUTION_MODES = ["off", "observe", "suggest", "auto-safe"] as const
export type EvolutionMode = (typeof EVOLUTION_MODES)[number]

/** What happens to a memory the agent proposes: `auto` saves it directly · `review` waits in Pending · `never` drops it. */
export const MEMORY_POLICIES = ["auto", "review", "never"] as const
export type MemoryPolicyValue = (typeof MEMORY_POLICIES)[number]

/** The known memory categories (an entry's category is still free text; unknown ones follow `other`). */
export const MEMORY_CATEGORIES = [
  { id: "commands", label: "Commands", description: "Recurring commands, validation gates, release commands.", policy: "review" },
  { id: "conventions", label: "Conventions", description: "Code style, naming and workflow rules of the project.", policy: "review" },
  { id: "preferences", label: "Preferences", description: "How the user likes to work and be answered.", policy: "review" },
  { id: "architecture", label: "Architecture", description: "Durable module boundaries, data flow and services.", policy: "review" },
  { id: "stack", label: "Stack", description: "Frameworks, runtimes, package managers and core dependencies.", policy: "review" },
  { id: "release", label: "Release", description: "Versioning, changelog, branch and release rules.", policy: "review" },
  { id: "constraints", label: "Constraints", description: "Permanent constraints, compatibility promises and ownership rules.", policy: "review" },
  { id: "security", label: "Security", description: "Security posture, secret handling and permission rules.", policy: "review" },
  { id: "objective", label: "Objective", description: "Stable product purpose and goals.", policy: "review" },
  { id: "other", label: "Other", description: "Anything that fits no other category.", policy: "review" },
  { id: "volatile", label: "Volatile", description: "One-off or temporary details; proposals in it are dropped.", policy: "never" },
] as const satisfies ReadonlyArray<{ id: string; label: string; description: string; policy: MemoryPolicyValue }>
export type MemoryCategoryId = (typeof MEMORY_CATEGORIES)[number]["id"]
export const MEMORY_CATEGORY_IDS = MEMORY_CATEGORIES.map((category) => category.id) as [MemoryCategoryId, ...MemoryCategoryId[]]

/** An entry's free-text category as a catalogue id: case-insensitive, v1's `project.`/`user.` prefixes dropped, unknown or empty = `other`. */
export function memoryCategoryId(category: string): MemoryCategoryId {
  const key = category.trim().toLowerCase().replace(/^(?:project|user)\./, "")
  return MEMORY_CATEGORY_IDS.find((id) => id === key) ?? "other"
}

/** The policy for an agent proposal in `category`: the user's override, else the category's default. */
export function memoryPolicyFor(category: string, overrides?: Partial<Record<string, MemoryPolicyValue>>): MemoryPolicyValue {
  const id = memoryCategoryId(category)
  return overrides?.[id] ?? MEMORY_CATEGORIES.find((entry) => entry.id === id)!.policy
}

/**
 * Session goals (docs/goals.md). active: the agent keeps working turn after turn · paused: the user stopped it ·
 * blocked: the agent reported the same blocker for several turns · usage_limited: the provider's quota ran out ·
 * budget_limited: the token budget was reached · complete: the objective was achieved. The last two are terminal.
 */
export const GOAL_STATUSES = ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]
/** A goal in one of these statuses is finished: a new goal replaces it without asking. */
export const GOAL_TERMINAL_STATUSES: readonly GoalStatus[] = ["budget_limited", "complete"]
/** An objective longer than this is saved as a file and the goal points at it. */
export const GOAL_INLINE_OBJECTIVE_CHARS = 4_000
/** The longest objective `goal.set` accepts (it is saved as a file past GOAL_INLINE_OBJECTIVE_CHARS). */
export const GOAL_MAX_OBJECTIVE_CHARS = 60_000
/** The most tokens a goal budget may name. */
export const GOAL_MAX_TOKEN_BUDGET = 1_000_000_000_000
