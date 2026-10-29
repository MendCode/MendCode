import { ConsoleUrl } from "./console"
import { AgentConfig, ModelMetadata, ModelParameters, ModelVariants, ProviderConfig } from "./model-config"
export { AgentConfig, ModelParameters, ModelVariant, ModelVariants } from "./model-config"
import { MemoryDetails } from "./memory-model"
import { CompactionConfig } from "./compaction"
import { CacheConfig } from "./cache"
import { BudgetPolicy, SetupPreset } from "./setup"
import { ReasoningReport } from "./reasoning"
import { MemoryConfigPatch } from "./memory-control"
import { PermissionConfig, PermissionRule, PermissionProvenance, PermissionReview } from "./permissions"
import { PackageAuthorManifest } from "./package-authoring"
import { z } from "zod"
import { CompoundPricing } from "./compound"
import { QuotaSnapshot, SessionEvent } from "./events"
import { AGENT_MODES, EVOLUTION_MODES, FOOTER_SEGMENTS, MAX_FRAME_BYTES, MEMORY_CATEGORY_IDS, MEMORY_POLICIES, MODEL_ROLES, OUTPUT_STYLES, PROMPT_CACHE_MODES, REASONING_EFFORTS, SERVICE_TIERS, SESSION_COLORS, TIMELINE_PREVIEW_CHARS } from "./constants"
import { FEATURE_IDS, TIERS } from "./tier-data"
import { CACHE_LIFETIME_MINUTES_RANGE, CACHE_TTLS } from "./idle-compaction-data"
import { MODEL_CONTEXT_LIMIT, MODEL_CONTEXT_RANGE } from "./model-context"
import { BlobRef, ItemId, MemoryId, SessionId, TurnId } from "./ids"
import { ForegroundState } from "./states"
import { DEFAULT_PROFILE, PROFILE_NAME } from "./profiles"
import { ImageGenerationSettings } from "./image-generation"
import { VoiceSettings } from "./voice"
import { lazySchema } from "./lazy"
import { SessionDraft, SessionLifecycle } from "./session-lifecycle"

/** Read-only queries answered in the command ack. They read projections; they never scan history. */

export const SessionSummary = lazySchema(() => z.strictObject({
  lifecycle: SessionLifecycle.optional(),
  summary: z.string().max(500).optional(),
  sessionId: SessionId,
  title: z.string().max(200),
  directory: z.string().max(4096),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  detached: z.boolean().optional(),
  /** Foreground state if the session has a live actor, otherwise "idle". */
  state: ForegroundState,
  queued: z.number().int().nonnegative(),
  /** Live detail of a running turn, present only while it lasts: epoch ms it started, the tool in flight, and the request it waits on. */
  since: z.number().int().nonnegative().optional(),
  tool: z.string().max(200).optional(),
  pending: z.string().max(200).optional(),
  /** True while the session is paused (`session.control`): it finishes the running turn and starts nothing until resumed. */
  paused: z.boolean().optional(),
  parentId: SessionId.optional(),
  agent: z.string().max(100).optional(),
  model: z.lazy(() => ModelChoice).optional(),
  permission: z.enum(["plan", "ask", "smart", "edits", "full"]).optional(),
  status: z.string().optional(),
  archivedAt: z.number().int().nonnegative().optional(),
  /** Free tags the user put on the session (its agent-view metadata, `session.agent-view.metadata.patch`). */
  tags: z.array(z.string().max(40)).max(20).optional(),
  /** The user's color mark of the session (the same metadata); a name, so every theme draws it. */
  color: z.enum(SESSION_COLORS).optional(),
  /** True when the user gave the session its title (`session.rename`), not the first message. */
  named: z.boolean().optional(),
  /** The session's unsent draft; only `session.list` fills it, and not for a read-only token (which cannot call `draft.get` either). A list labels an untitled session with it. */
  draft: SessionDraft.optional(),
}))
export type SessionSummary = z.infer<typeof SessionSummary>

/** One user message of a session, to jump to or fork at (`session.timeline`). `preview` is the message's first 120 characters. */
export const TimelineEntry = lazySchema(() => z.strictObject({
  turnId: TurnId,
  itemId: ItemId,
  at: z.number().int().nonnegative(),
  preview: z.string().max(TIMELINE_PREVIEW_CHARS * 2),
  reverted: z.boolean(),
  /** The bookmark the user set with `session.label`. */
  label: z.string().max(400).optional(),
}))
export type TimelineEntry = z.infer<typeof TimelineEntry>

/**
 * One session of a fork family (`session.tree`). `parentId` and `atItemId` say where a branch was cut; `labels` are the
 * bookmarked messages of that session with the start of their text.
 */
export const SessionTreeNode = lazySchema(() => z.strictObject({
  sessionId: SessionId,
  parentId: SessionId.optional(),
  atItemId: ItemId.optional(),
  atPreview: z.string().max(400).optional(),
  title: z.string().max(400),
  directory: z.string().max(4096),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  current: z.boolean(),
  labels: z.array(z.strictObject({ itemId: ItemId, label: z.string().max(400), preview: z.string().max(400) })).max(200),
  /** "fork" (a branch of the conversation) or "task" (a sub-agent the parent started); absent on older daemons, read as "fork". */
  kind: z.enum(["fork", "task"]).optional(),
  /** The model the session runs on (its id); absent when it uses the default. */
  model: z.string().max(200).optional(),
  /** Task: queued, running, needs_input, completed, failed, cancelled, interrupted. Fork: running or idle. */
  state: z.string().max(40).optional(),
  /** Task: the agent that runs it and what it was asked to do. */
  agent: z.string().max(64).optional(),
  description: z.string().max(200).optional(),
  /** Task: the first line of its result, cut to 160 characters. Left out for remote and peer clients. */
  headline: z.string().max(200).optional(),
  /** Fork: how many turns it has that were not merged back into its parent yet. */
  unmerged: z.number().int().nonnegative().optional(),
}))
export type SessionTreeNode = z.infer<typeof SessionTreeNode>

/** What `session.merge` queued: `turns` of the fork went into `intoSessionId` as context (about `tokens`), `omitted` older ones stayed behind. The context goes with that session's next turn. */
export const SessionMergeReport = lazySchema(() => z.strictObject({
  fromSessionId: SessionId,
  intoSessionId: SessionId,
  turns: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** Merged contexts waiting for the next turn of that session, this one included. */
  pending: z.number().int().positive(),
}))
export type SessionMergeReport = z.infer<typeof SessionMergeReport>

/** Why a file of an undone turn could not be put back (or forward): no snapshot was possible. */
export const RewindSkipReason = z.enum(["binary", "too_large", "unreadable", "not_tracked"])
export type RewindSkipReason = z.infer<typeof RewindSkipReason>

/**
 * What `session.undo` / `session.redo` did. `files.restored` are paths written with their other state, `files.removed`
 * paths deleted (a file the turn created, when undoing). `history.messages` is how many model messages left (or came back)
 * and `history.tracked` is false when the model's history lives in an external engine (it still remembers the turn).
 * `shellUntracked` is true when the turn ran shell commands: what they changed is not tracked and not reverted.
 */
export const RewindReport = lazySchema(() => z.strictObject({
  turnIds: z.array(TurnId).min(1).max(64),
  itemId: ItemId.optional(),
  files: z.strictObject({
    restored: z.array(z.string().max(4096)).max(500),
    removed: z.array(z.string().max(4096)).max(500),
    skipped: z.array(z.strictObject({ path: z.string().max(4096), reason: RewindSkipReason })).max(500),
  }),
  history: z.strictObject({ messages: z.number().int().nonnegative(), tracked: z.boolean() }),
  shellUntracked: z.boolean(),
  notes: z.array(z.string().max(300)).max(8),
  /** Local worktree files were captured; shell effects beyond those files still cannot be rewound. */
  worktreeTracked: z.boolean().optional(),
  prompt: z.strictObject({ text: z.string().max(40_000), attachments: z.array(BlobRef).max(32) }).optional(),
  canRedo: z.boolean().optional(),
  changes: z.array(z.strictObject({ path: z.string().max(4096), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() })).max(300).optional(),
  /** A part-level revert: only files went back, the transcript was not cut. `partId` is the part it started at. */
  partial: z.boolean().optional(),
  partId: ItemId.optional(),
}))
export type RewindReport = z.infer<typeof RewindReport>

/** `session.export` ack. */
export const SessionExportResult = lazySchema(() => z.strictObject({
  format: z.enum(["markdown", "json", "html"]),
  /** Cut by the daemon to what fits one frame; `EXPORT_MAX_CHARS` bounds the text it collects before formatting. */
  text: z.string().max(MAX_FRAME_BYTES),
  turns: z.number().int().nonnegative(),
  truncated: z.boolean(),
}))
export type SessionExportResult = z.infer<typeof SessionExportResult>

/** One background shell command as the agent view lists it. */
export const BackgroundTaskEntry = lazySchema(() => z.strictObject({
  sessionId: SessionId,
  id: z.string(),
  command: z.string(),
  cwd: z.string(),
  status: z.enum(["running", "exited", "killed"]),
  exitCode: z.number().int().optional(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().optional(),
}))
export type BackgroundTaskEntry = z.infer<typeof BackgroundTaskEntry>

/** One secret the user pasted into a session, as `secrets.list` shows it: the marker number, what it is and its last characters, never the value. */
export const SecretInfo = lazySchema(() => z.strictObject({
  n: z.number().int().positive(),
  kind: z.string().max(64),
  tail: z.string().max(8),
  createdAt: z.number().int().nonnegative(),
}))
export type SecretInfo = z.infer<typeof SecretInfo>

export const UsageDay = lazySchema(() => z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  costUnknownCalls: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
}))
export type UsageDay = z.infer<typeof UsageDay>

export const UsageModel = lazySchema(() => z.strictObject({
  provider: z.string(),
  model: z.string(),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
  costUnknownCalls: z.number().int().nonnegative().optional(),
}))
export type UsageModel = z.infer<typeof UsageModel>

/** Per-day activity: user prompts and words, model generation time and tool runtime (ms). */
export const UsageActivityDay = lazySchema(() => z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prompts: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  aiMs: z.number().int().nonnegative(),
  toolMs: z.number().int().nonnegative(),
  /** Longest completed model/reasoning item; absent before this projection existed. */
  longestAiMs: z.number().int().nonnegative().optional(),
}))
export type UsageActivityDay = z.infer<typeof UsageActivityDay>

/** Completed tool calls in the range, bucketed by tool name (raw shell commands are "shell"). */
export const UsageTool = lazySchema(() => z.strictObject({
  tool: z.string(),
  calls: z.number().int().nonnegative(),
  ms: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
}))
export type UsageTool = z.infer<typeof UsageTool>

/** One slice of what is sent to the model. `tokens` is an estimate: chars / 4, rounded. */
export const ContextSection = lazySchema(() => z.strictObject({
  id: z.string(),
  label: z.string(),
  chars: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  /** Messages for history sections, tools for the tools section. */
  count: z.number().int().nonnegative().optional(),
}))
export type ContextSection = z.infer<typeof ContextSection>

export const ContextMessage = lazySchema(() => z.strictObject({
  role: z.enum(["user", "assistant", "tool"]),
  chars: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  preview: z.string(),
}))
export type ContextMessage = z.infer<typeof ContextMessage>

/**
 * What one tool charges every request (its schema, chars / 4) against how often the session used it: the owner is
 * `built-in`, `mcp:<server>` or `extension:<name>`. `uses` counts the calls still in the history, so after a compaction
 * it can understate; an estimate of schema cost, never a billed figure.
 */
export const ContextRent = lazySchema(() => z.strictObject({
  tool: z.string().max(200),
  owner: z.string().max(200),
  tokens: z.number().int().nonnegative(),
  uses: z.number().int().nonnegative(),
}))
export type ContextRent = z.infer<typeof ContextRent>

/** What fills a session's context, by source. Estimates are chars / 4; `measuredTokens` is exact (last model call's usage). */
export const ContextReport = lazySchema(() => z.strictObject({
  model: z.string(),
  sessionId: SessionId.optional(),
  /** Known model window; absent when the engine/catalog cannot supply it. */
  contextWindow: z.number().int().positive().optional(),
  /** Disjoint estimated slices, retaining the original sections for older clients. */
  categories: z.array(ContextSection).optional(),
  mcpTools: z.array(ContextSection).optional(),
  /** Estimated tokens each extension adds (its tool schemas, already counted in `tools`), biggest first. */
  extensions: z.array(ContextSection).max(64).optional(),
  /** Per-tool schema cost against observed uses, most expensive first; at most 200. Absent from older daemons and engines. */
  rent: z.array(ContextRent).max(200).optional(),
  repeatedReads: z.array(z.strictObject({ path: z.string(), count: z.number().int().positive(), tokens: z.number().int().nonnegative() })).optional(),
  sections: z.array(ContextSection),
  /** The five largest history messages, biggest first. */
  largest: z.array(ContextMessage).max(5),
  /** Attached images in history; their token cost is not estimated. */
  images: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  measuredTokens: z.number().int().nonnegative().optional(),
  compactAtTokens: z.number().int().positive(),
  /** True when `contextWindow` is the user's `session.context-window` override, not the catalog's. */
  contextWindowOverride: z.boolean().optional(),
  /** True when `contextWindow` is the model's `modelContext` window (no session override). */
  contextWindowModelSetting: z.boolean().optional(),
  /** Files the history still holds (read, edited or written by a tool), biggest first; at most 100. */
  files: z.array(z.strictObject({ path: z.string().max(4096), reads: z.number().int().nonnegative(), edits: z.number().int().nonnegative(), tokens: z.number().int().nonnegative() })).max(100).optional(),
}))
export type ContextReport = z.infer<typeof ContextReport>

/** The subscription account, from the login's identity claims; every field is optional. */
export const UsageProfile = lazySchema(() => z.strictObject({ name: z.string().max(200).optional(), email: z.string().max(320).optional(), plan: z.string().max(60).optional() }))
export type UsageProfile = z.infer<typeof UsageProfile>

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Count = z.number().int().nonnegative()

/** One session ranked by tokens; `ms` is the time its turns ran (not wall time since it was opened). */
export const UsageSession = lazySchema(() => z.strictObject({ sessionId: z.string(), title: z.string(), directory: z.string(), tokens: Count, ms: Count, turns: Count }))
export type UsageSession = z.infer<typeof UsageSession>

/**
 * All-time figures (lifetime, peak day, streaks, longest session) and range figures (efforts, skills, top
 * sessions). Streaks count local days with any tokens or prompts; `current` ends today or yesterday.
 */
export const UsageInsights = lazySchema(() => z.strictObject({
  lifetime: z.strictObject({ tokens: Count, since: Day }).optional(),
  peakDay: z.strictObject({ day: Day, tokens: Count }).optional(),
  streak: z.strictObject({ current: Count, longest: Count }),
  longestSession: UsageSession.optional(),
  efforts: z.array(z.strictObject({ effort: z.string(), turns: Count })).max(20),
  skills: z.array(z.strictObject({ skill: z.string(), runs: Count })).max(20),
  topSessions: z.array(UsageSession).max(20),
}))
export type UsageInsights = z.infer<typeof UsageInsights>

export const UsageReport = lazySchema(() => z.strictObject({
  from: z.string(),
  to: z.string(),
  days: z.array(UsageDay),
  models: z.array(UsageModel),
  quotas: z.array(QuotaSnapshot),
  /** Distinct sessions in the range; summing `days[].sessions` counts multi-day sessions once per day. */
  sessions: z.number().int().nonnegative().optional(),
  /** Absent from older daemons. Sparse: days without activity are missing. */
  activity: z.array(UsageActivityDay).optional(),
  /** Top 10 tools by calls; absent from older daemons. */
  tools: z.array(UsageTool).optional(),
  /** Tokens command-output filters kept out of the model's context in the range (estimate, chars / 4), by filter; absent from older daemons and when none ran. */
  savings: z.array(z.strictObject({ source: z.string().max(64), calls: Count, tokens: Count })).max(20).optional(),
  /** Absent from older daemons, and when no login identity is readable. */
  profile: UsageProfile.optional(),
  /** Absent from older daemons. */
  insights: UsageInsights.optional(),
  /** Scope identity and known projects; absent from older daemons. Quotas remain account-wide. */
  scope: z.strictObject({ kind: z.enum(["global", "project", "directory"]), directory: z.string().optional(), project: z.string().optional() }).optional(),
  projects: z.array(z.strictObject({ id: z.string(), directory: z.string() })).optional(),
  /** Current saved agent labels, ranked by recorded turns in the selected scope/range. */
  agents: z.array(z.strictObject({ name: z.string(), turns: Count })).max(10).optional(),
  /** Local file evidence only. Older/pruned snapshots and shell changes are not counted. */
  outcomes: z.strictObject({ changedFiles: Count, sessionsWithCodeChanges: Count, coverage: z.literal("retained-snapshots") }).optional(),
}))
export type UsageReport = z.infer<typeof UsageReport>

/** Complete-turn history is paged independently from the chat's event window. */
export const HistoryItem = lazySchema(() => z.strictObject({
  itemId: ItemId,
  kind: z.enum(["user_message", "agent_message", "tool_call", "reasoning", "compaction", "approval", "artifact"]),
  text: z.string(),
  status: z.string(),
  tool: z.string().optional(),
  title: z.string().optional(),
  attachments: z.array(z.string()).optional(),
  truncated: z.boolean().optional(),
  attachmentRefs: z.array(BlobRef).max(20).optional(),
}))
export type HistoryItem = z.infer<typeof HistoryItem>
export const HistoryTurn = lazySchema(() => z.strictObject({
  turnId: TurnId,
  at: z.number(),
  seq: z.number(),
  preview: z.string(),
  outcome: z.string(),
  items: z.array(HistoryItem),
  truncated: z.boolean().optional(),
}))
export type HistoryTurn = z.infer<typeof HistoryTurn>
export const HistoryReport = lazySchema(() => z.strictObject({
  turns: z.array(HistoryTurn),
  older: z.number().optional(),
  newer: z.number().optional(),
}))
export type HistoryReport = z.infer<typeof HistoryReport>
const ResourceKind = z.enum(["skill", "command", "agent"])
export const ResourceFindings = lazySchema(() => z.strictObject({
  overridden: z.array(z.strictObject({ kind: ResourceKind, name: z.string(), layer: z.string(), by: z.string() })),
  dropped: z.array(z.strictObject({ kind: ResourceKind, name: z.string(), layer: z.string(), reason: z.string() })),
  ignored: z.array(z.strictObject({ kind: ResourceKind, name: z.string(), layer: z.string(), fields: z.array(z.string()) })),
  notes: z.array(z.strictObject({ kind: ResourceKind, name: z.string(), layer: z.string(), note: z.string() })),
  problems: z.array(z.strictObject({ file: z.string(), message: z.string() })),
}))
export type ResourceFindings = z.infer<typeof ResourceFindings>
export const SkillsReport = lazySchema(() => z.strictObject({ skills: z.array(z.strictObject({
  name: z.string(), description: z.string(), source: z.enum(["project", "user"]),
  dir: z.string(), pkg: z.string().optional(), enabled: z.boolean(), onDemand: z.boolean().optional(),
  /** Compatibility fields (additive): where it came from, what the file declared, what was read but not applied. */
  layer: z.string().optional(), userInvocable: z.boolean().optional(), disableModelInvocation: z.boolean().optional(), argumentHint: z.string().optional(),
  allowedTools: z.array(z.string()).optional(), model: z.string().optional(), effort: z.string().optional(),
  ignoredFields: z.array(z.string()).optional(), notes: z.array(z.string()).optional(),
})), findings: ResourceFindings.optional() }))
export type SkillsReport = z.infer<typeof SkillsReport>

export const ReasoningEffort = z.enum(REASONING_EFFORTS)
export type ReasoningEffort = z.infer<typeof ReasoningEffort>
/** A model and, optionally, its reasoning effort (the model's default when absent). */
/** `fast`: this session's `/fast` (priority processing); absent follows the `serviceTier` setting. */
export const ModelChoice = lazySchema(() => z.strictObject({ model: z.string().min(1).max(100), effort: ReasoningEffort.optional(), variant: z.string().min(1).max(100).optional(), parameters: ModelParameters.optional(), fast: z.boolean().optional() }))
export type ModelChoice = z.infer<typeof ModelChoice>
export const ModelRoles = lazySchema(() => z.partialRecord(z.enum(MODEL_ROLES), ModelChoice))
export type ModelRoles = z.infer<typeof ModelRoles>

/** A model recipe from an extension layer's `recipes/<name>.json`: a named, versioned set of roles. */
export const RecipeInfo = lazySchema(() => z.strictObject({
  name: z.string(),
  file: z.string(),
  source: z.enum(["user", "project"]),
  pkg: z.string().optional(),
  description: z.string(),
  version: z.string().optional(),
  roles: ModelRoles,
  problem: z.string().optional(),
}))
export type RecipeInfo = z.infer<typeof RecipeInfo>

export const RecipesReport = lazySchema(() => z.strictObject({ recipes: z.array(RecipeInfo), active: z.string().optional() }))
export type RecipesReport = z.infer<typeof RecipesReport>

/**
 * A profile by folder (`company` for `~/Code/acme/*`): sessions under its folders use its memory, its model roles and
 * its default permission. Everything outside every profile is `personal`, which uses the top-level settings.
 */
export const Profile = lazySchema(() => z.strictObject({
  name: z.string().regex(PROFILE_NAME).refine((name) => name !== DEFAULT_PROFILE, { message: `"${DEFAULT_PROFILE}" is the default profile` }),
  directories: z.array(z.string().min(1).max(4096)).min(1).max(16),
  models: ModelRoles.optional(),
  defaultPermission: z.enum(["ask", "edits", "full", "smart"]).optional(),
}))
export type Profile = z.infer<typeof Profile>

/** User settings, owned by the daemon and pushed to every terminal on change. All fields optional. */
/** ACP configuration exposed to clients: environment names only. Values stay in acp-agents.json. */
export const AcpAgentSettings = lazySchema(() => z.strictObject({
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(200).optional(),
  envKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(200).optional(),
}))
export type AcpAgentSettings = z.infer<typeof AcpAgentSettings>
export const AcpAgentName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)

const SharedSettings = lazySchema(() => z.strictObject({
  /** settings.set merges entries; null removes one. Backed by the existing ACP config file. */
  acpAgents: z.record(AcpAgentName, AcpAgentSettings).optional(),
  /** Folder profiles (at most 8, unique names); see `Profile`. */
  profiles: z
    .array(Profile)
    .max(8)
    .refine((profiles) => new Set(profiles.map((profile) => profile.name)).size === profiles.length, { message: "profile names must be unique" })
    .optional(),
  /** Model per role; unset roles use `main`, an unset `main` uses the engine default. */
  models: ModelRoles.optional(),
  theme: z.string().max(40).optional(),
  view: z.enum(["minimal", "balanced", "full"]).optional(),
  /** Permission mode for new sessions. */
  defaultPermission: z.enum(["ask", "edits", "full", "smart", "plan"]).optional(),
  /** `smart` mode: command prefixes (e.g. "bun test", "git status") that run without asking, on top of the built-in read-only list. Risky patterns still ask. */
  permissionAllow: z.array(z.string().min(1).max(200)).max(100).optional(),
  /** `smart` mode: with the OS `sandbox` on and its network off, shell commands smart mode merely does not know run without asking (rules that flag a risk still ask). Off by default; local clients only. */
  smartSandboxTrust: z.boolean().optional(),
  /** Claude Code in `full` access still asks when its own safety checks flag a command (for example a dangerous `rm`). Unset or `true`: that request is shown to you (allow once or reject, never "always"; headless `--approve` rejects it, `--dangerously-skip-permissions` allows it). `false`: it is allowed unattended, as full access did before. Local clients only. */
  engineSafetyPrompts: z.boolean().optional(),
  /** The session's `/env` credentials also go to Claude Code, Codex, pi and ACP agents (their process environment, and the names to their model). Unset or `true`: they do. `false`: only the native engine gets them. Local clients only. */
  engineEnvironment: z.boolean().optional(),
  /** URL patterns (`*` spans any characters) that `http` hooks in `hooks.json` may POST to. Unset or empty: http hooks never run. */
  allowedHttpHookUrls: z.array(z.string().min(1).max(500)).max(50).optional(),
  /** Native engine compacts after a turn whose context reached this many tokens. */
  compactAtTokens: z.number().int().min(8_000).max(2_000_000).optional(),
  /**
   * Context per model, keyed by the reference `mendcode models` prints (`chatgpt/gpt-6-astra`): `window` replaces the catalog's
   * window (and the provider's input limit) for every session on that model, never above its known `maxContextWindow`; `compactAt`
   * replaces `compactAtTokens` for it (capped by the window). A
   * session's `/context-window` still wins; `/context-window <n> --always` writes `window` (docs/compaction.md C7).
   */
  modelContext: z.record(
    z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}\/\S{1,200}$/, "use the reference mendcode models prints (provider/model)"),
    z.strictObject({ window: z.number().int().min(MODEL_CONTEXT_RANGE.min).max(MODEL_CONTEXT_RANGE.max).optional(), compactAt: z.number().int().min(MODEL_CONTEXT_RANGE.min).max(MODEL_CONTEXT_RANGE.max).optional() })
      .refine((entry) => entry.window !== undefined || entry.compactAt !== undefined, { message: "set window, compactAt or both" }),
  ).refine((entries) => Object.keys(entries).length <= MODEL_CONTEXT_LIMIT, { message: `at most ${MODEL_CONTEXT_LIMIT} models` }).optional(),
  /** Compaction while idle (feature `idle_compact`, docs/compaction.md): the least context, in tokens, a session must hold to be compacted before its prompt cache expires. Default 100000. */
  idleCompactAtTokens: z.number().int().min(8_000).max(2_000_000).optional(),
  /** Notice before a compaction (feature `compact_notice`, docs/compaction.md): the share of the compaction point, in percent, at which the transcript says once how far the compaction is. Default 80; `off` never says it. */
  compactNoticePercent: z.union([z.literal("off"), z.number().int().min(10).max(99)]).optional(),
  /** Minutes a provider keeps a prompt prefix after the last call, by provider id; replaces the built-in lifetime, and gives one to a provider that has none (compaction while idle stays off for it until then). */
  cacheLifetimeMinutes: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.number().int().min(CACHE_LIFETIME_MINUTES_RANGE.min).max(CACHE_LIFETIME_MINUTES_RANGE.max)).optional(),
  /** How long Anthropic keeps what the native engine caches (docs/prompt-cache.md, "Cache lifetime"): `5m` (default, no `ttl` sent) or `1h` (`ttl: "1h"` on every breakpoint; writes cost 2x the input price instead of 1.25x). Anthropic API and Claude on Vertex only. */
  promptCacheTtl: z.enum(CACHE_TTLS).optional(),
  /** Opt-in: a `promptCacheTtl` of `1h` is also given to Claude Code when it is the engine, as `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` in its process environment (Claude Code v2.1.242 or later). Off when unset. */
  claudeCacheTtl: z.boolean().optional(),
  /** Tokens (4 characters each) of earlier conversation handed to an engine that did not run it: switching between native, Claude Code and ACP agents, a fork into one, a merge-back. Default 16000; 0 turns the engine-switch handoff off. */
  handoffTokenCap: z.number().int().min(0).max(200_000).optional(),
  reducedMotion: z.boolean().optional(),
  /** Companion next to the prompt: `codex:<id>` (from ~/.codex/pets) or `user:<id>` (from the data dir's pets); off when unset or "off". */
  pet: z.string().max(120).optional(),
  /** Project roots whose `.mendcode/tools` custom tools the user trusted to run; project tools stay off elsewhere. */
  trustedToolDirs: z.array(z.string().max(4096)).max(200).optional(),
  /** Installed packages turned off (`user:name` / `project:name`); everything else installed is on. */
  disabledSkills: z.record(z.string().max(4096), z.array(z.string().max(100)).max(100)).optional(),
  disabledPackages: z.array(z.string().max(200)).max(500).optional(),
  /** Extension names turned off (`extensions.disable`): never run in the daemon, skipped by terminals. */
  disabledExtensions: z.array(z.string().max(64)).max(200).optional(),
  /** Single resources of installed packages turned off (`user:pkg/skills/foo`, `project:pkg/commands/review`); `packages.resource` edits it. */
  disabledPackageResources: z.array(z.string().max(300)).max(1000).optional(),
  /** Daily local time ("HH:MM") for Dream in every project active in the last 24 h; off when unset. */
  dreamAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Model tokens one Dream run may spend in all its calls; DREAM_DEFAULT_MAX_TOKENS when unset. The run stops cleanly and its report says so. */
  dreamMaxTokens: z.number().int().min(1_000).max(2_000_000).optional(),
  /** What Evolution does while Dream runs; `off` when unset. */
  evolution: z.enum(EVOLUTION_MODES).optional(),
  /** Per memory category: what happens to an agent proposal (auto = saved, review = Pending, never = dropped); unset categories use their default. */
  subagentDepth: z.number().int().min(0).max(16).optional(),
  subagentMaxChildren: z.number().int().min(1).max(64).optional(),
  subagentMaxDescendants: z.number().int().min(1).max(256).optional(),
  subagentOwnerWake: z.boolean().optional(),
  /** Sub-agents the `task` tool's description names (built-ins first, 6 when unset); the rest are listed on demand (`agent: "?"`). */
  subagentCatalog: z.number().int().min(0).max(100).optional(),
  /** A prompt opening with `@name`: `address` (default) continues that agent's child of this session when it has one; `delegate` only tells the model to delegate. */
  agentMentions: z.enum(["address", "delegate"]).optional(),
  memoryMaintenance: z.enum(["disabled", "preview", "auto-consolidate"]).optional(),
  memoryEnabled: z.boolean().optional(),
  memoryUse: z.boolean().optional(),
  memoryGenerate: z.boolean().optional(),
  memoryRequireApproval: z.boolean().optional(),
  memoryMaxPromptTokens: z.number().int().min(1).max(32_000).optional(),
  memoryMaxEntries: z.number().int().min(1).max(10_000).optional(),
  memoryProjectMaxEntries: z.number().int().min(1).max(10_000).optional(),
  memoryPolicies: z.partialRecord(z.enum(MEMORY_CATEGORY_IDS), z.enum(MEMORY_POLICIES)).optional(),
  /** Once a day (03:30 local) remove sessions idle for this many days, then orphan blobs; off when unset. */
  retentionDays: z.number().int().min(7).max(3650).optional(),
  /** In the same daily pass (03:30 local): remove the daemon's merged, clean, unused worktrees idle this many days; off when unset. */
  worktreeGcDays: z.number().int().min(1).max(3650).optional(),
  /**
   * Branch names of worktrees the `worktree` tool creates (docs/worktrees.md): `static` (default) = `prefix` (default `mend/`) plus the name · `semantic` = the
   * model picks a short type prefix such as `fix` or `feat` and the branch is `<type>/<name>` · `custom` = the model follows `instruction` and names the whole branch.
   */
  worktreeBranch: z.strictObject({
    mode: z.enum(["static", "semantic", "custom"]).optional(),
    prefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}\/$/).optional(),
    instruction: z.string().min(1).max(500).optional(),
  }).optional(),
  /** The Git page (`/git`, docs/git.md): the tab it opens on, `changes` when unset. */
  git: z.strictObject({
    defaultTab: z.enum(["changes", "commit", "worktrees", "pr"]).optional(),
    /** A new session in a Git project is created in a fresh workspace, the way `/warp` → New workspace does (docs/worktrees.md). Off when unset. */
    newSessionWorktree: z.boolean().optional(),
  }).optional(),
  /** Footer segments in display order; DEFAULT_FOOTER when unset. */
  footer: z.array(z.enum(FOOTER_SEGMENTS)).max(FOOTER_SEGMENTS.length).optional(),
  /** Prompt-cache hints the native engine sends (docs/prompt-cache.md): `legacy` (default) = today's per-session key · `off` = none · `smart` = per-lineage keys and Anthropic breakpoints at tools, system and the last user message. */
  promptCache: z.enum(PROMPT_CACHE_MODES).optional(),
  /** `/fast`: `fast` sends `service_tier: priority` to OpenAI Responses hosts (API key and ChatGPT sign-in); standard when unset. */
  serviceTier: z.enum(SERVICE_TIERS).optional(),
  /** `/output-style`: tone preset appended to the native system prompt; `default` when unset. */
  outputStyle: z.enum(OUTPUT_STYLES).optional(),
  /** Set once the first-run setup page was completed or dismissed. */
  onboarded: z.boolean().optional(),
  memoryGlobalCompactionMaxEntries: z.number().int().min(1).max(10_000).optional(),
  dreamConsolidationPolicy: z.enum(["disabled", "preview", "auto-consolidate"]).optional(),
  memoryProjects: z.record(z.string().min(1).max(4096), MemoryConfigPatch).optional(),
  /** Primary destination after an explicitly applied plan; build when unset or unavailable. */
  planExitAgent: z.string().min(1).max(64).optional(),
  /** Ordered v1-style tool/path rules; last matching entry wins. */
  permission: PermissionConfig.optional(),
  tools: z.record(z.string().min(1).max(200), z.boolean()).optional(),
  /** Full-tier thread bridge, explicitly enabled for each external engine. */
  threadMcp: z.strictObject({ claude: z.boolean().optional(), codex: z.boolean().optional(), acp: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), z.boolean()).optional() }).optional(),
  experimental: z.strictObject({
    primary_tools: z.array(z.string().min(1).max(200)).max(100).optional(),
    continue_loop_on_deny: z.boolean().optional(),
    async_tools: z.boolean().optional(),
    async_questions: z.boolean().optional(),
    session_recall: z.boolean().optional(),
    /** Opt-in: after a compaction, each new request brings back the packed-away turns that match it, verbatim, after the request. */
    auto_recall: z.boolean().optional(),
    /** Opt-in secondary tool schemas, discovered locally through tool_search; off when unset. */
    tool_discovery: z.boolean().optional(),
    /** Opt-in confined JavaScript orchestration; nested calls retain their native permission gates. */
    code_mode: z.boolean().optional(),
    reasoning_auto: z.boolean().optional(),
    /** Opt-in `snip` tool: the model replaces stale tool output in its own context with a note. */
    snip: z.boolean().optional(),
    /** Opt-in `worktree` tool: the model creates a git worktree and moves the session into it, or back. */
    worktree_tool: z.boolean().optional(),
    /** The `threads` tool: the model lists, reads, searches, messages, waits on and interrupts this project's other sessions. */
    thread_tools: z.boolean().optional(),
    /** Opt-in network: the daemon polls watched pull requests through the user's own `gh` login and wakes the session only on a change. */
    pr_watch: z.boolean().optional(),
    /** Opt-in network and model calls: the daemon reviews pull requests of watched repositories through `gh` (docs/pr-review.md). */
    pr_review: z.boolean().optional(),
    /** Opt-in network: the Git page's push, create pull request and PR tab run git and gh on this machine, each after a confirmation card. */
    git_actions: z.boolean().optional(),
    openTelemetry: z.boolean().optional(),
  }).optional(),
  permissionReviewerRole: z.enum(MODEL_ROLES).optional(),
  logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).optional(),
  projectThemes: z.record(z.string().min(1).max(4096), z.string().min(1).max(40)).optional(),
  $schema: z.string().max(2048).optional(),
  shell: z.string().min(1).max(4096).optional(),
  /** OS sandbox for the agent's commands (docs/sandbox.md); unset or mode `off` runs them unconfined. `network` is off unless `on`. */
  sandbox: z.strictObject({
    mode: z.enum(["off", "read-only", "workspace-write"]).optional(),
    network: z.enum(["off", "on"]).optional(),
    /** Absolute paths writable in workspace-write besides the project and the temp directories. */
    writableRoots: z.array(z.string().min(1).max(4096)).max(20).optional(),
  }).optional(),
  /** Absolute directories outside the project that count as part of the workspace (docs/permissions.md "Extra directories"): no external-directory ask, and writable in the sandbox. */
  additionalDirectories: z.array(z.string().min(1).max(4096)).max(20).optional(),
  watcher: z.strictObject({ ignore: z.array(z.string().min(1).max(4096)).max(200).optional() }).optional(),
  disabled_models: z.array(z.string().min(1).max(100)).max(1000).optional(),
  enabled_providers: z.array(z.string().min(1).max(100)).max(200).optional(),
  subagent_variant: z.string().min(1).max(100).optional(),
  default_agent: z.string().min(1).max(64).optional(),
  plan_exit_agent: z.string().min(1).max(64).optional(),
  agent: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), AgentConfig).optional(),
  provider: z.record(z.string().min(1).max(32), ProviderConfig).optional(),
  /** `filters`: condense command output (ANSI, passing tests, repeats) with the full output kept on disk; unset follows the tier's `output_filters` feature. */
  tool_output: z.strictObject({ max_lines: z.number().int().positive().optional(), max_bytes: z.number().int().positive().optional(), filters: z.boolean().optional() }).optional(),
  /** Where the code graph indexes (docs/code-graph.md): `auto` (unset) a git repository under the size limit, `on` any folder, `off` none. Per project in `projectConfig` (`/graph on|off|auto`). */
  codegraph_index: z.enum(["auto", "on", "off"]).optional(),
  /** Explicit local instruction paths/globs; remote declarations are not fetched. */
  instructions: z.array(z.string().min(1).max(4096)).max(100).optional(),
  skills: z.strictObject({ paths: z.array(z.string().min(1).max(4096)).max(100).optional(), urls: z.array(z.string().url().max(4096)).max(100).optional() }).optional(),
  /** Load `.agents` and `.claude` skills, commands and agents next to MendCode's own folders; on unless false (docs/resources-config.md). */
  foreignResources: z.boolean().optional(),
  /** Instruction file names tried after AGENTS.md/CLAUDE.md/CONTEXT.md in each directory (Codex `project_doc_fallback_filenames`). */
  instructionFallbacks: z.array(z.string().regex(/^[^/\\\0]{1,200}$/)).max(20).optional(),
  /** Names that mark the project root when walking up for instruction files; `.git` when unset (Codex `project_root_markers`). */
  projectRootMarkers: z.array(z.string().regex(/^[^/\\\0]{1,200}$/)).max(20).optional(),
  /** Environment the model's shell commands inherit; unset passes everything (docs/resources-config.md). */
  shellEnvironment: z.strictObject({
    inherit: z.enum(["all", "core", "none"]).optional(),
    /** Names (with `*` globs, case-insensitive) removed after inheriting. */
    exclude: z.array(z.string().min(1).max(200)).max(100).optional(),
    /** When set, only these names (globs) survive from the inherited environment. */
    includeOnly: z.array(z.string().min(1).max(200)).max(100).optional(),
    /** Set last, always: name -> value. */
    set: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/), z.string().max(4096)).optional(),
    /** Keep names containing KEY, SECRET, TOKEN, PASSWORD or CREDENTIAL; they are dropped whenever a policy is set. */
    keepSecrets: z.boolean().optional(),
  }).optional(),
  /** Text run before every model shell command, in the same shell (pi `shellCommandPrefix`). */
  shellCommandPrefix: z.string().min(1).max(2000).optional(),
  /** Run the model's commands in a login shell (`-l`); off unless true. POSIX shells only. */
  loginShell: z.boolean().optional(),
  /** Outbound proxy and extra CA for the daemon's provider, search and fetch traffic (docs/resources-config.md). */
  proxy: z.strictObject({
    url: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), "proxy url must be http or https").optional(),
    noProxy: z.array(z.string().min(1).max(253)).max(100).optional(),
    caFile: z.string().min(1).max(4096).optional(),
  }).optional(),
  /** Domain rules for `webfetch` and `websearch`: a block wins; with an allow list only those domains (and subdomains) pass. */
  web: z.strictObject({
    allowDomains: z.array(z.string().min(1).max(253)).max(200).optional(),
    blockDomains: z.array(z.string().min(1).max(253)).max(200).optional(),
  }).optional(),
  /** Active-response prompt policy. Unset preserves v2's existing after-response behavior. */
  queue: z.strictObject({ mode: z.enum(["after-response", "after-tools", "immediate"]).optional() }).optional(),
  /** File snapshots default on; false keeps conversation undo/redo without changing files. */
  snapshot: z.boolean().optional(),
  /** Worktree capture is opt-in until the rollback scope decision is settled. */
  snapshotScope: z.enum(["tools", "worktree"]).optional(),
  /** Opt-in generated read-only workflow candidates; off when unset. */
  evolutionWorkflows: z.boolean().optional(),
  compaction: CompactionConfig.optional(),
  cache: CacheConfig.optional(),
  cacheProjects: z.record(z.string().min(1).max(4096), CacheConfig).optional(),
  /** Explicitly permit message/part revisions; off by default. */
  allowMessageEdits: z.boolean().optional(),
  defaultAgent: z.string().min(1).max(64).optional(),
  /** Off when unset; true installs stable patches only, notify only checks. */
  autoupdate: z.union([z.boolean(), z.literal("notify")]).optional(),
  share: z.enum(["manual", "auto", "disabled"]).optional(),
  enterprise: z.strictObject({ url: ConsoleUrl.optional() }).optional(),
}))
export const ProjectRuntimeConfig = lazySchema(() => SharedSettings.pick({ models: true, defaultPermission: true, defaultAgent: true, shell: true, permission: true, codegraph_index: true }))
export const Settings = lazySchema(() => SharedSettings.extend({
  projectConfig: z.record(z.string().min(1).max(4096), ProjectRuntimeConfig).optional(),
  budgets: BudgetPolicy.optional(),
  setupPreset: SetupPreset.optional(),
  /** One bundle of switches: minimalist, balanced or full (docs/tiers.md). Unset keeps every feature at its own default. */
  tier: z.enum(TIERS).optional(),
  /** Per-feature override of the tier: `false` turns a feature off, `true` includes it (a feature with its own opt-in switch still needs that switch). */
  features: z.partialRecord(z.enum(FEATURE_IDS), z.boolean()).optional(),
  image_generation: ImageGenerationSettings.optional(),
  voice: VoiceSettings.optional(),
}))
export type Settings = z.infer<typeof Settings>

/** `sandbox.status` ack: the effective setting and whether this system can enforce it. Local clients only. */
export const SandboxStatus = lazySchema(() => z.strictObject({
  mode: z.enum(["off", "read-only", "workspace-write"]),
  network: z.enum(["off", "on"]),
  writableRoots: z.array(z.string().max(4096)).max(20),
  backend: z.enum(["seatbelt", "bwrap"]).optional(),
  /** False when a mode is set but no backend exists: commands then refuse to run rather than run unconfined. */
  enforced: z.boolean(),
  detail: z.string().max(500),
}))
export type SandboxStatus = z.infer<typeof SandboxStatus>

/** What the daemon knows about itself; never includes credentials. */
export const DaemonInfoReport = lazySchema(() => z.strictObject({
  engine: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  dataDir: z.string(),
  pid: z.number().int(),
  buildId: z.string().optional(),
  extensionsEnabled: z.boolean().optional(),
  /** True when the daemon runs with `--safe-mode`: no extensions, packages, hooks, MCP or project tools. */
  safeMode: z.boolean().optional(),
  /** Subscription login check; absent for engines that do not use one. `message` explains a failure. */
  login: z.strictObject({ ok: z.boolean(), message: z.string().optional() }).optional(),
  /** The quota refresh probe per listed provider (docs/usage-limit.md); absent when the user listed none. */
  quotaRefresh: z.array(z.strictObject({
    provider: z.enum(["codex", "claude"]),
    everyMinutes: z.number().int(),
    model: z.string().max(80).optional(),
    state: z.enum(["on", "waiting", "stopped"]),
    lastProbeAt: z.number().int().optional(),
    probesToday: z.number().int().nonnegative(),
    lastError: z.string().max(200).optional(),
  })).max(2).optional(),
}))
export type DaemonInfoReport = z.infer<typeof DaemonInfoReport>

/** One model the engine can use. `efforts` is empty when the model takes no reasoning effort. */
export const ModelInfo = lazySchema(() => z.strictObject({
  ...ModelMetadata.omit({ provider: true }).shape,
  id: z.string(),
  name: z.string(),
  efforts: z.array(ReasoningEffort),
  defaultEffort: ReasoningEffort.optional(),
  variants: ModelVariants.optional(),
  contextWindow: z.number().int().positive().optional(),
  /** The largest window the provider is known to serve for this model (the subscription's catalog); a larger `/context-window` or `modelContext` is lowered to it. Absent when unknown. */
  maxContextWindow: z.number().int().positive().optional(),
  /** `models.list` only: this model's `modelContext` setting (a window or compaction point the user made permanent for it). */
  contextSetting: z.strictObject({ window: z.number().int().positive().optional(), compactAt: z.number().int().positive().optional() }).optional(),
  /**
   * `models.list` only: where the native engine packs a session on this model under the settings in force (`compactAtTokens`, the
   * `compaction` object, provider and model overrides; 160k when no window is known). Absent for a model another engine runs.
   */
  compactAtTokens: z.number().int().positive().optional(),
  /** `false` when the provider is configured to refuse image input; absent otherwise (see also `modalities.input`). */
  images: z.literal(false).optional(),
  /** Set when another engine runs the whole session with this model (Claude Code, pi); absent for the native engine. */
  engine: z.enum(["claude", "pi", "codex", "opencode", "cursor"]).optional(),
  /** Set for a model of an API-key provider (its id is `<provider>:<model>`); absent for the ChatGPT subscription's models. */
  provider: z.string().optional(),
  compoundPricing: CompoundPricing.optional(),
  /**
   * An engine alias (`claude-opus`) always means the newest model of its family; this is the id it last resolved to on this
   * machine (`claude-opus-5-5`), remembered by the daemon so the alias reads `Opus 5.5` before the first answer. A display
   * hint only: requests keep using `id`. Absent until the alias has answered once.
   */
  resolved: z.string().min(1).max(128).optional(),
}))
export type ModelInfo = z.infer<typeof ModelInfo>

/**
 * Models and who uses which. `selectable` is false for engines that choose their own model (codex, faux).
 * `session` is the session's own choice; `effective` is what its next answer would use.
 */
export const ModelsReport = lazySchema(() => z.strictObject({
  engine: z.string(),
  selectable: z.boolean(),
  models: z.array(ModelInfo),
  defaults: ModelChoice,
  roles: ModelRoles,
  session: ModelChoice.optional(),
  effective: ModelChoice.optional(),
  reasoning: z.lazy(() => ReasoningReport).optional(),
  /** `session.model.set` only: the conversation is handed to the new engine on the session's next turn (portable handoff, docs/sessions.md). */
  handoff: z.strictObject({ from: z.string().max(80), to: z.string().max(80), turns: z.number().int().nonnegative(), omitted: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), /** Already in the new engine's history (the native engine rebuilds it as its own messages), not waiting for the next message. */ rebuilt: z.literal(true).optional() }).optional(),
}))
export type ModelsReport = z.infer<typeof ModelsReport>

export const StorageSession = lazySchema(() => z.strictObject({
  sessionId: SessionId,
  title: z.string(),
  directory: z.string(),
  updatedAt: z.number().int().nonnegative(),
  /** Event payload bytes plus the bytes of blobs the session references. */
  bytes: z.number().int().nonnegative(),
}))
export type StorageSession = z.infer<typeof StorageSession>

/** Where the disk goes. Sizes are bytes; `otherBytes` is the database minus events and engine history (indexes, projections, free pages). */
export const StorageReport = lazySchema(() => z.strictObject({
  goalFiles: z.number().int().nonnegative().optional(),
  goalBytes: z.number().int().nonnegative().optional(),
  orphanGoalFiles: z.number().int().nonnegative().optional(),
  orphanGoalBytes: z.number().int().nonnegative().optional(),
  dbBytes: z.number().int().nonnegative(),
  walBytes: z.number().int().nonnegative(),
  blobBytes: z.number().int().nonnegative(),
  blobs: z.number().int().nonnegative(),
  orphanBlobs: z.number().int().nonnegative(),
  orphanBytes: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  eventBytes: z.number().int().nonnegative(),
  engineBytes: z.number().int().nonnegative(),
  otherBytes: z.number().int().nonnegative(),
  /** Free pages inside the database file: what a full vacuum can give back. */
  freeBytes: z.number().int().nonnegative(),
  /** none: the file never shrinks without a full vacuum. */
  autoVacuum: z.enum(["none", "full", "incremental"]),
  topSessions: z.array(StorageSession).max(10),
  /** Turns recorded (bytes per turn = eventBytes / turns). */
  turns: z.number().int().nonnegative().optional(),
  /** The event types that take the most bytes. */
  eventTypes: z.array(z.strictObject({ type: z.string().max(64), count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() })).max(10).optional(),
  /** File snapshots kept for undo: inline content plus the shared objects. */
  snapshotBytes: z.number().int().nonnegative().optional(),
  snapshotObjects: z.number().int().nonnegative().optional(),
  snapshotRefs: z.number().int().nonnegative().optional(),
  /** Values stored compressed (model messages, tool results, snapshot objects) and what compression and sharing save. */
  compressedRows: z.number().int().nonnegative().optional(),
  savedBytes: z.number().int().nonnegative().optional(),
  /** Daemon trash (worktrees removed with a safety copy kept); old entries go with `storage clean --worktrees`. */
  trashBytes: z.number().int().nonnegative().optional(),
  /**
   * Forks share the model history they start from instead of copying it: `forkRefs` histories point at a parent,
   * `sharedMessages` / `sharedBytes` are what they read through those references (logical size; stored once, so not in `engineBytes` again).
   */
  forkRefs: z.number().int().nonnegative().optional(),
  sharedMessages: z.number().int().nonnegative().optional(),
  sharedBytes: z.number().int().nonnegative().optional(),
  /** Large tool output events shared with forks: objects stored once, and the references sessions hold to them. */
  eventObjects: z.number().int().nonnegative().optional(),
  eventObjectBytes: z.number().int().nonnegative().optional(),
  eventObjectRefs: z.number().int().nonnegative().optional(),
}))
export type StorageReport = z.infer<typeof StorageReport>

export const StorageWorktree = lazySchema(() => z.strictObject({
  directory: z.string().max(4096),
  branch: z.string().max(300).nullable(),
  bytes: z.number().int().nonnegative(),
  /** merged: branch is in the project's HEAD · unmerged: has commits not merged · missing: directory is gone. */
  state: z.enum(["merged", "unmerged", "missing"]),
  clean: z.boolean(),
  idleDays: z.number().int().nonnegative(),
  /** A session, loop or workflow works in it. */
  occupied: z.boolean(),
  removable: z.boolean(),
  /** Why cleaning keeps it, when it does. */
  keep: z.string().max(200).optional(),
}))
export type StorageWorktree = z.infer<typeof StorageWorktree>

export const StorageWorktreesReport = lazySchema(() => z.strictObject({
  worktrees: z.array(StorageWorktree).max(500),
  totalBytes: z.number().int().nonnegative(),
  removableBytes: z.number().int().nonnegative(),
  trashBytes: z.number().int().nonnegative(),
  /** Bytes inside the daemon's loop worktree root (`loop-worktrees`). */
  loopBytes: z.number().int().nonnegative(),
}))
export type StorageWorktreesReport = z.infer<typeof StorageWorktreesReport>

export const StorageCleanResult = lazySchema(() => z.strictObject({
  goalFilesRemoved: z.number().int().nonnegative().optional(),
  dryRun: z.boolean(),
  olderThanDays: z.number().int().nonnegative(),
  sessionsRemoved: z.number().int().nonnegative(),
  eventsRemoved: z.number().int().nonnegative(),
  blobsRemoved: z.number().int().nonnegative(),
  /** Measured file-size difference (database + WAL + blobs + goal objectives); an estimate for a dry run. */
  bytesReclaimed: z.number().int().nonnegative(),
  /** Sessions old enough but kept: active turn, queued message, live loop root or currently open. */
  protectedSessions: z.number().int().nonnegative(),
  vacuumed: z.boolean(),
  /** Rows moved to the compact forms (model messages, tool results, snapshot content); `compactComplete` false: run it again to continue. */
  compactedRows: z.number().int().nonnegative().optional(),
  compactComplete: z.boolean().optional(),
  /** Streaming deltas dropped from finished messages. */
  deltaEventsRemoved: z.number().int().nonnegative().optional(),
  worktreesRemoved: z.number().int().nonnegative().optional(),
  /** Bytes the removed worktrees and old trash held (measured on the directories; an estimate for a dry run). */
  worktreeBytes: z.number().int().nonnegative().optional(),
}))
export type StorageCleanResult = z.infer<typeof StorageCleanResult>

/** user: every project of a profile · project: one directory · session: one session only (injected nowhere else, removed with the session). */
export const MemoryScope = z.enum(["user", "project", "session"])
export type MemoryScope = z.infer<typeof MemoryScope>
/** saved: injected into turns · pending: a proposal awaiting review · archived: kept, never injected. */
export const MemoryStatus = z.enum(["saved", "pending", "archived"])
export type MemoryStatus = z.infer<typeof MemoryStatus>

/** What a pending proposal asks for: a new memory, a revision of `targetId`, or retiring `targetId`. Absent = new. */
export const MemoryKind = z.enum(["new", "update", "archive"])
export type MemoryKind = z.infer<typeof MemoryKind>

export const MemoryEntry = lazySchema(() => z.strictObject({
  memoryId: MemoryId,
  scope: MemoryScope,
  /** Project root for project scope (and the session's project for session scope). */
  directory: z.string().optional(),
  /** Session scope only: the one session the memory belongs to. */
  sessionId: SessionId.optional(),
  text: z.string().min(1).max(2_000),
  category: z.string().max(64),
  status: MemoryStatus,
  source: z.enum(["user", "agent"]),
  /** Pinned saved memories are always injected, whatever the prompt (at most MAX_PINNED_MEMORIES). Absent = not pinned. */
  pinned: z.boolean().optional(),
  /** User-scope memories belong to one profile; absent = personal. Project memories follow their directory. */
  profile: z.string().max(24).optional(),
  /** Only on pending proposals from Dream that change an existing memory. `text` is the proposed text (update) or the current text (archive). */
  kind: MemoryKind.optional(),
  targetId: MemoryId.optional(),
  details: MemoryDetails.optional(),
  reason: z.string().max(500).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}))
export type MemoryEntry = z.infer<typeof MemoryEntry>

/** related / conflicts are symmetric (stored lowest id first); supports / supersedes point from → to. */
export const MemoryLinkKind = z.enum(["related", "supports", "conflicts", "supersedes"])
export type MemoryLinkKind = z.infer<typeof MemoryLinkKind>
export const MemoryLink = lazySchema(() => z.strictObject({ from: MemoryId, to: MemoryId, kind: MemoryLinkKind, createdAt: z.number().int().nonnegative() }))
export type MemoryLink = z.infer<typeof MemoryLink>

/** empty: no saved memories · disconnected: no links · partial: some isolated · connected: every memory has a link. */
export const MemoryGraphHealth = lazySchema(() => z.strictObject({
  nodes: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
  connected: z.number().int().nonnegative(),
  isolated: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  state: z.enum(["empty", "disconnected", "partial", "connected"]),
}))
export type MemoryGraphHealth = z.infer<typeof MemoryGraphHealth>

/** The saved memories visible from a directory (at most 200, most linked first) and the links among them. */
export const MemoryGraphReport = lazySchema(() => z.strictObject({ nodes: z.array(MemoryEntry).max(200), links: z.array(MemoryLink).max(2_000), health: MemoryGraphHealth }))
export type MemoryGraphReport = z.infer<typeof MemoryGraphReport>

/** One memory category with the policy in force (`policy`) and the built-in one (`defaultPolicy`). */
export const MemoryCategoryInfo = lazySchema(() => z.strictObject({
  id: z.enum(MEMORY_CATEGORY_IDS),
  label: z.string(),
  description: z.string(),
  defaultPolicy: z.enum(MEMORY_POLICIES),
  policy: z.enum(MEMORY_POLICIES),
}))
export type MemoryCategoryInfo = z.infer<typeof MemoryCategoryInfo>

export const ChangedFile = lazySchema(() => z.strictObject({
  path: z.string(),
  /** Last tracked session turn that touched it; absent from working-tree reports and older daemons. */
  touchedAt: z.number().int().nonnegative().optional(),
  oldPath: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  /** Unified diff of this file (hunks only, no header), cut at a byte cap; `truncated` says so. */
  diff: z.string(),
  truncated: z.boolean(),
}))
export type ChangedFile = z.infer<typeof ChangedFile>

/** Working tree vs HEAD (staged + unstaged + untracked) of the repository containing `directory`. */
export const ChangesReport = lazySchema(() => z.strictObject({
  root: z.string(),
  branch: z.string().optional(),
  files: z.array(ChangedFile),
  /** More files changed than were returned. */
  omittedFiles: z.number().int().nonnegative(),
  scope: z.enum(["session", "message"]).optional(),
  /** False when a snapshot was disabled, pruned, incomplete, or unavailable. */
  complete: z.boolean().optional(),
}))
export type ChangesReport = z.infer<typeof ChangesReport>

export const McpServerState = z.enum(["stopped", "starting", "running", "failed"])
export type McpServerState = z.infer<typeof McpServerState>

export const McpServerStatus = lazySchema(() => z.strictObject({
  name: z.string(),
  /** Command line for display; `key=value` argument values are masked. */
  command: z.string(),
  enabled: z.boolean(),
  state: McpServerState,
  pid: z.number().int().positive().optional(),
  tools: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  /** Last ~20 lines of the server's stderr, newest last. */
  stderr: z.array(z.string()),
  transport: z.literal("remote").optional(),
  auth: z.enum(["none", "needs_auth", "pending", "authorized"]).optional(),
  authStored: z.boolean().optional(),
  authExpiresAt: z.number().optional(),
  pending: z.strictObject({ revision: z.string(), scope: z.enum(["user", "project"]), expiresAt: z.number(), details: z.array(z.string()) }).optional(),
  /** A project server that does not start, connect or list tools until the project is trusted (`tools.trust`, `/trust on`). */
  needsTrust: z.boolean().optional(),
}))
export type McpServerStatus = z.infer<typeof McpServerStatus>

export const McpIssue = lazySchema(() => z.strictObject({ source: z.string(), server: z.string().optional(), message: z.string() }))
export type McpIssue = z.infer<typeof McpIssue>

export const McpStatusReport = lazySchema(() => z.strictObject({ servers: z.array(McpServerStatus), issues: z.array(McpIssue) }))
export type McpStatusReport = z.infer<typeof McpStatusReport>

export const CustomToolInfo = lazySchema(() => z.strictObject({
  name: z.string(),
  /** The name the model sees (`custom__<name>`). */
  toolName: z.string(),
  description: z.string(),
  source: z.enum(["project", "user"]),
  file: z.string(),
  command: z.array(z.string()),
  /** User tools are always trusted; project tools follow the directory's trust. */
  trusted: z.boolean(),
  /** The package that ships the tool, if any. */
  pkg: z.string().optional(),
}))
export type CustomToolInfo = z.infer<typeof CustomToolInfo>

/** One extension module found for a project (code that changes the daemon and/or the terminal); untrusted project ones are listed but never imported. */
export const ExtensionInfo = lazySchema(() => z.strictObject({
  name: z.string(),
  /** `package` for an installed package's extension, else the folder it was found in. */
  source: z.enum(["user", "project", "package"]),
  file: z.string(),
  /** The module exports a `daemon` half / a `tui` half (false for a module that did not load). */
  daemon: z.boolean(),
  tui: z.boolean(),
  /** What the daemon half registered. */
  tools: z.array(z.string()),
  commands: z.array(z.string()),
  hooks: z.array(z.string()),
  /** Load and hook errors, the first 20. */
  errors: z.array(z.string()),
  /** User extensions are always trusted; project ones follow the directory's trust (`tools.trust`). */
  trusted: z.boolean(),
  pluginId: z.string().optional(),
  abi: z.enum(["v1-adapter", "tool-module"]).optional(),
  authProvider: z.string().optional(),
  provider: z.string().optional(),
  /** CLI flags it declares (`--name`), MCP servers it adds, virtual models it lists (`virtual:<id>`), event names it listens to. */
  flags: z.array(z.string().max(40)).max(64).optional(),
  mcpServers: z.array(z.string().max(64)).max(64).optional(),
  virtualModels: z.array(z.string().max(64)).max(64).optional(),
  events: z.array(z.string().max(64)).max(64).optional(),
  /** Turned off with `extensions.disable`: listed, never run. */
  disabled: z.boolean().optional(),
  /** Collisions this extension is part of, winner and loser named (the full list is `ExtensionsReport.conflicts`). */
  conflicts: z.array(z.string().max(300)).max(40).optional(),
  /** Handlers or commands the circuit breaker stopped for this session after repeated failures; a reload re-enables them. */
  breaker: z.array(z.string().max(120)).max(40).optional(),
  /** A reload failed and this is the previous working version, still running. */
  kept: z.string().max(400).optional(),
  /** Estimated cost in model context: the tool schemas it adds (chars / 4) that the user's tier offers, and the hooks that rewrite context by an amount nobody measures. */
  context: z.strictObject({
    tokens: z.number().int().nonnegative(),
    tools: z.array(z.strictObject({ name: z.string().max(64), tokens: z.number().int().nonnegative(), offered: z.boolean() })).max(200),
    rewrites: z.array(z.string().max(40)).max(10),
  }).optional(),
}))
export type ExtensionInfo = z.infer<typeof ExtensionInfo>

/** Two extensions (or an extension and the host) claiming the same tool or command: who won and who lost. */
export const ExtensionConflict = lazySchema(() => z.strictObject({
  kind: z.enum(["tool", "command", "builtin-tool", "name"]),
  name: z.string().max(100),
  winner: z.string().max(100),
  losers: z.array(z.string().max(100)).max(20),
  note: z.string().max(300),
}))
export type ExtensionConflict = z.infer<typeof ExtensionConflict>

export const ExtensionsReport = lazySchema(() => z.strictObject({ extensions: z.array(ExtensionInfo), conflicts: z.array(ExtensionConflict).max(100).optional() }))
export type ExtensionsReport = z.infer<typeof ExtensionsReport>

/** One configured shell hook. `active` is false for a project hook while the directory is not trusted. */
export const HookInfo = lazySchema(() => z.strictObject({
  event: z.string(),
  matcher: z.string().optional(),
  command: z.string(),
  timeoutMs: z.number().int().positive(),
  source: z.enum(["user", "project"]),
  pkg: z.string().optional(),
  file: z.string(),
  active: z.boolean(),
  /** How the hook runs; absent from daemons that only had commands. */
  kind: z.enum(["command", "http", "prompt"]).optional(),
  /** Which layer's `hooks.json` it came from: `user`, `project` or `package <name>`. */
  layer: z.string().max(200).optional(),
  /** Why an inactive hook does not run (project directory untrusted, http hook not allowed). */
  inactiveReason: z.string().max(200).optional(),
}))
export type HookInfo = z.infer<typeof HookInfo>

/** One recent hook run; the message is the clipped, masked first line of what the hook printed. */
export const HookRunInfo = lazySchema(() => z.strictObject({
  at: z.number(),
  event: z.string(),
  tool: z.string().optional(),
  source: z.enum(["user", "project"]),
  command: z.string(),
  outcome: z.enum(["ok", "blocked", "failed", "timeout"]),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative(),
  message: z.string().optional(),
  kind: z.enum(["command", "http", "prompt"]).optional(),
}))
export type HookRunInfo = z.infer<typeof HookRunInfo>

/** Shell hooks of a project, the recent runs, and what project-local code still waits for `tools.trust`. */
export const HooksReport = lazySchema(() => z.strictObject({
  directory: z.string(),
  /** False when the daemon runs with `MENDCODE_HOOKS=0`. */
  enabled: z.boolean(),
  trusted: z.boolean(),
  hooks: z.array(HookInfo),
  runs: z.array(HookRunInfo),
  problems: z.array(z.string()),
  pending: z.strictObject({ hooks: z.number().int().nonnegative(), tools: z.number().int().nonnegative(), extensions: z.number().int().nonnegative(), mcp: z.number().int().nonnegative().optional() }),
}))
export type HooksReport = z.infer<typeof HooksReport>

/** One installed package: a folder of extensions (tools, skills, commands, themes, mcp.json, extensions/) with a manifest. */
export const PackageInfo = lazySchema(() => z.strictObject({
  name: z.string(),
  source: z.enum(["user", "project"]),
  /** `user:name` / `project:name`, as used by `packages.enable` and `Settings.disabledPackages`. */
  key: z.string(),
  dir: z.string(),
  enabled: z.boolean(),
  manifest: z
    .strictObject({ name: z.string(), version: z.string(), description: z.string(), author: z.string().optional(), homepage: z.string().optional(), license: z.string().optional(), extensions: z.boolean().optional(), capabilities: z.array(z.enum(["hooks", "tools", "commands", "network", "processes", "filesystem"])).max(32).optional() }).extend(PackageAuthorManifest.shape)
    .optional(),
  install: z.strictObject({ source: z.string(), commit: z.string().optional(), integrity: z.string().optional(), pinned: z.boolean().optional(), installedAt: z.number() }).optional(),
  /** `extensions`: TypeScript modules in `extensions/` (code that runs in the daemon); absent from daemons that predate it. */
  contents: z.strictObject({ tools: z.number(), skills: z.number(), commands: z.number(), themes: z.number(), mcp: z.boolean(), extensions: z.number().optional(), agents: z.number().optional() }),
  /** Estimated text cost of data commands/skills, summed across resources; not a provider bill. */
  contextCost: z.strictObject({ idleTokens: z.number().int().nonnegative(), onDemandTokens: z.number().int().nonnegative(), method: z.literal("chars/4") }).optional(),
  problem: z.string().optional(),
}))
export type PackageInfo = z.infer<typeof PackageInfo>

export const PackagesReport = lazySchema(() => z.strictObject({ directory: z.string(), packages: z.array(PackageInfo) }))
export type PackagesReport = z.infer<typeof PackagesReport>

/** A theme file from an extension layer; `json` is the parsed file (the client validates it), or `problem` says why not. */
export const ThemeFile = lazySchema(() => z.strictObject({
  name: z.string(),
  file: z.string(),
  source: z.enum(["user", "project"]),
  pkg: z.string().optional(),
  json: z.unknown().optional(),
  problem: z.string().optional(),
}))
export type ThemeFile = z.infer<typeof ThemeFile>

export const ThemesReport = lazySchema(() => z.strictObject({ themes: z.array(ThemeFile) }))
export type ThemesReport = z.infer<typeof ThemesReport>

export const CustomToolsReport = lazySchema(() => z.strictObject({
  directory: z.string(),
  tools: z.array(CustomToolInfo),
  issues: z.array(z.strictObject({ file: z.string(), message: z.string() })),
}))
export type CustomToolsReport = z.infer<typeof CustomToolsReport>

/**
 * One agent a session can run as (`agents.list`). `build` and `plan` are built in; the rest come from `agents/*.md` of
 * an extension layer. A project agent (the project's own or its packages') is `trusted` only once the directory is
 * trusted for project tools; an untrusted one is listed but cannot be selected or called.
 */
export const AgentInfo = lazySchema(() => z.strictObject({
  name: z.string(),
  description: z.string(),
  mode: z.enum(AGENT_MODES),
  source: z.enum(["builtin", "user", "project"]),
  /** The package that ships the agent, if any. */
  pkg: z.string().optional(),
  file: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(REASONING_EFFORTS).optional(),
  /** Allow list of tool names (a trailing `*` matches a prefix); absent = every tool. */
  tools: z.array(z.string()).optional(),
  /** Tools taken away after the allow list. */
  deny: z.array(z.string()).optional(),
  /** The most permissive permission mode the agent may run in: the session's mode is lowered to it, never raised. */
  permission: z.enum(["plan", "ask", "smart", "edits", "full"]).optional(),
  permissionRules: z.array(PermissionRule).max(500).optional(),
  trusted: z.boolean(),
  hidden: z.boolean().optional(),
  disable: z.boolean().optional(),
  color: AgentConfig.shape.color,
  temperature: AgentConfig.shape.temperature,
  top_p: AgentConfig.shape.top_p,
  steps: AgentConfig.shape.steps,
  variant: AgentConfig.shape.variant,
  options: ModelParameters.optional(),
}))
export type AgentInfo = z.infer<typeof AgentInfo>

/**
 * Ack of `agents.list` and `session.agent.set`. `current` is the session's agent (`build` when none is selected, `plan`
 * while the session is in plan mode); absent without a session. `problems` are agent files that could not be used.
 */
export const AgentsReport = lazySchema(() => z.strictObject({
  directory: z.string(),
  agents: z.array(AgentInfo),
  current: z.string().optional(),
  problems: z.array(z.strictObject({ file: z.string(), message: z.string() })),
  /** Agents another layer replaced (additive): `{ name, layer, by }`. */
  overridden: z.array(z.strictObject({ kind: ResourceKind, name: z.string(), layer: z.string(), by: z.string() })).optional(),
}))
export type AgentsReport = z.infer<typeof AgentsReport>

export const AgentCreateReport = lazySchema(() => z.strictObject({ file: z.string(), agent: AgentInfo, generation: z.enum(["deterministic", "model"]), callsProviders: z.boolean(), fallback: z.string().max(300).optional() }))
export type AgentCreateReport = z.infer<typeof AgentCreateReport>
export const AgentDebugReport = lazySchema(() => z.strictObject({
  agent: AgentInfo.extend({ prompt: z.string() }),
  tools: z.record(z.string(), z.boolean()),
  sessionId: SessionId.optional(),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  result: z.strictObject({ output: z.string(), truncated: z.boolean(), title: z.string(), isError: z.boolean() }).optional(),
  callsProviders: z.boolean(),
}))
export type AgentDebugReport = z.infer<typeof AgentDebugReport>

/**
 * Ack of `session.events`: `events` in ascending seq. `firstSeq`/`lastSeq` are the raw window bounds (events hidden as
 * undone are not in `events` but still count here, so the next page starts right after them), `more` says whether the
 * log continues beyond the window in the direction asked (older for the newest window and `before`, newer for `after`),
 * and `sessionLastSeq` is the log's newest seq now, to subscribe from.
 */
export const EventsWindow = lazySchema(() => z.strictObject({
  events: z.array(SessionEvent),
  firstSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  more: z.boolean(),
  sessionLastSeq: z.number().int().nonnegative(),
}))
export type EventsWindow = z.infer<typeof EventsWindow>

/** One `files.search` result: a path relative to the searched directory. */
export const FileEntry = lazySchema(() => z.strictObject({
  path: z.string().min(1).max(4096),
  kind: z.enum(["file", "dir"]),
}))
export type FileEntry = z.infer<typeof FileEntry>

/**
 * A tool the user approved "for this session": from then on its calls no longer ask (in `smart` mode, unless they are
 * high risk). `grantId` is what `permissions.revoke` takes.
 */
export const PermissionGrant = lazySchema(() => z.strictObject({
  grantId: z.string().min(1).max(200),
  tool: z.string().min(1).max(200),
  permission: z.enum(["read", "write", "execute"]),
  grantedAt: z.number().int().nonnegative(),
  pattern: z.string().max(4096).optional(),
  rulePermission: z.string().max(200).optional(),
  provenance: PermissionProvenance.optional(),
  recordId: z.string().max(200).optional(),
}))
export type PermissionGrant = z.infer<typeof PermissionGrant>

/** Ack of attachment.paste: media refs stay outside text and preserve their MIME on submit/replay. */
export const AttachmentPasteResult = lazySchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("image"), attachment: BlobRef, name: z.string().max(255), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }),
  z.strictObject({ kind: z.literal("document"), attachment: BlobRef, name: z.string().max(255) }),
  z.strictObject({ kind: z.literal("mention"), path: z.string().min(1).max(4096) }),
  z.strictObject({ kind: z.literal("text"), name: z.string().max(255), content: z.string().max(210_000), directory: z.literal(true).optional() }),
]))
export type AttachmentPasteResult = z.infer<typeof AttachmentPasteResult>
export const PermissionGrantHistory = lazySchema(() => z.strictObject({ grant: PermissionGrant, revokedAt: z.number().int().nonnegative().optional(), active: z.boolean() }))
export type PermissionGrantHistory = z.infer<typeof PermissionGrantHistory>
export const PermissionsHistoryReport = lazySchema(() => z.strictObject({ grants: z.array(PermissionGrantHistory).max(100), reviews: z.array(PermissionReview).max(500) }))
export type PermissionsHistoryReport = z.infer<typeof PermissionsHistoryReport>

export type PermissionsStatusReport = {
  mode: "approval" | "smart" | "full_access" | "edits" | "plan"
  defaultPermission: "ask" | "edits" | "full" | "smart" | "plan"
  reviewerRole: import("./constants").ModelRole
  permission: PermissionConfig
  tools: Record<string, boolean>
  primaryTools: string[]
  continueLoopOnDeny: boolean
}

export { AgentCommandsReport, AgentCommandPolicyReport } from "./agent-commands"
export type DiagnosticsReport = {
  scopes: number
  timers: number
  disposers: number
  connections: number
  actors: number
  jobs: number
  rssBytes: number
  memory?: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number }
  pid?: number
  uptime?: number
}

export { InteractionReport, MemorySideChatResponse } from "./interaction-http"
