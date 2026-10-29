import { createProjectSyncRecords } from "./project-sync"
import { createLimitCheckpoints } from "./limit-checkpoints"
import { createContinuityRecords } from "./continuity"
import { createMemorySharingRecords, sharedMemoryRevision } from "./memory-sharing"
import { createMessageRevisions } from "./message-revisions"
import { createTranscriptPrefix } from "./transcript-prefix"
import { Database } from "bun:sqlite"
import { openPrivateDatabase } from "./private-database"
import { createPrivateFiles } from "./private-files"
import { createEnvironment } from "./environment"
import { createHash, randomUUID } from "node:crypto"
import { createAgentCommandRecords } from "./agent-commands"
import { createSessionBackgroundRecords } from "./session-background"
import { createUsageWidgets } from "./usage-widgets"
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import {
  DEFAULT_PROFILE,
  type MemoryLink,
  type MemoryLinkKind,
  GlobalEvent,
  GoalId,
  Loop,
  MAX_WORKFLOW_RUN_BYTES,
  ModelChoice,
  DreamReport,
  DreamTrigger,
  type DreamRun,
  type EvolutionSuggestion,
  EvolutionReceipt,
  SessionEvent,
  Settings,
  WorkflowRun,
  type BlobRef,
  type ItemId,
  type MemoryEntry,
  type MemoryId,
  type MemoryStatus,
  type PermissionMode,
  type ClientId,
  type QueueId,
  type SessionId,
  type TurnId,
} from "@mendcode/protocol"
import type { GlobalEventDraft, SessionEventDraft } from "@mendcode/kernel"
import { createBlobFiles } from "./blobs"
import { createCodec, parseEvent } from "./compress"
import { createEngineHistory } from "./engine-history"
import { createEventObjects } from "./event-objects"
import { createStorageUpkeep, type CompactResult, type StorageExtras } from "./storage-upkeep"
import { createParityRecords } from "./parity-records"
import { createSessionRecallRecords } from "./session-recall"
import { createSessionStatsRecords } from "./session-stats"
import { createAutomationLedger } from "./automation-ledger"
import { createPermissionRecords } from "./permission-records"
import { createDrafts, draftBlobsSql } from "./drafts"
import { createEmptySessions, EXPLICIT_SESSION_KEY } from "./empty-sessions"
import { createSessionSearch } from "./session-search"
import { createSessionTree } from "./session-tree"
import { createSessionHandoff } from "./session-handoff"
import { createGoals } from "./goals"
import { createUsagePauses } from "./usage-pauses"
import { createAcpSettings } from "./acp-settings"
import { DDL, DEFAULT_PAGE_SIZE, PRAGMAS, SCHEMA_VERSION } from "./schema"
import { createSecrets } from "./secrets"
import { createPromptHistory, type PromptKind } from "./prompt-history"
import { createTurns, type PartialRevert } from "./turns"
import { createUsageInsights } from "./usage-insights"
import { createUsageScopes } from "./usage-scopes"
import { createUsageCalls } from "./usage-calls"
import { createWorkflowDefinitionRecords } from "./workflow-definitions"
import { createWorkflowJournal } from "./workflow-journal"
import { acquireWriterLock } from "./writer-lock"

/** Upper bound for one stored event row. Big content belongs in blobs (A9, FC-36). */
export const MAX_EVENT_BYTES = 80 * 1024

/** Retired adapter switches never invalidate unrelated saved feature overrides. New patches still reject them. */
function savedSetting(key: string, value: unknown): unknown {
  if (key !== "features" || !value || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([id]) => id !== "opencode" && id !== "cursor"))
}

type MemoryRow = {
  id: string
  scope: string
  directory: string | null
  text: string
  category: string
  status: string
  source: string
  created_at: number
  updated_at: number
  kind: string
  target_id: string | null
  reason: string
  profile: string
  session_id: string | null
  pinned: number
  model_data: string | null
}

function memoryColumns(prefix = "") {
  return ["id", "scope", "directory", "text", "category", "status", "source", "created_at", "updated_at", "kind", "target_id", "reason", "profile", "session_id", "pinned", "model_data"].map((column) => `${prefix}${column} AS ${column}`).join(", ")
}

/**
 * Which memories a listing or search sees: the profile's user scope, the project scope of `directory`, and session
 * scope only when asked for (one session, or `all` for management views). Parameters: ?1 directory, ?2 status, ?3 profile, ?4 session.
 */
const MEMORY_VISIBLE = `((scope = 'user' AND (?3 IS NULL OR profile = ?3)) OR (scope = 'project' AND (?1 IS NULL OR directory = ?1)) OR (scope = 'session' AND ?4 IS NOT NULL AND (?4 = 'all' OR session_id = ?4) AND (?1 IS NULL OR directory = ?1)))`
const MEMORY_SELECT = `SELECT ${memoryColumns()} FROM memories`
/** Links one memory may have, so the graph (and its payload) stays bounded (P11). */
export const MAX_MEMORY_LINKS = 16
/** The stored profile of a memory: '' for personal, so rows from before profiles belong to personal. */
const profileKey = (profile: string | undefined) => (profile === undefined ? null : profile === DEFAULT_PROFILE ? "" : profile)

function toMemory(row: MemoryRow): MemoryEntry {
  return {
    memoryId: row.id as MemoryId,
    scope: row.scope === "project" || row.scope === "session" ? row.scope : "user",
    ...(row.directory ? { directory: row.directory } : {}),
    ...(row.session_id ? { sessionId: row.session_id as SessionId } : {}),
    ...(row.model_data ? { details: JSON.parse(row.model_data) as MemoryEntry["details"] } : {}),
    text: row.text,
    category: row.category,
    status: row.status === "pending" || row.status === "archived" ? row.status : "saved",
    source: row.source === "agent" ? "agent" : "user",
    ...(row.pinned ? { pinned: true } : {}),
    ...(row.kind === "update" || row.kind === "archive" ? { kind: row.kind } : {}),
    ...(row.target_id ? { targetId: row.target_id as MemoryId } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** User text → FTS5 query: each word quoted (no operator injection) and prefix-matched, all required. */
export function ftsQuery(text: string) {
  const words = text.match(/[\p{L}\p{N}_-]+/gu) ?? []
  return words
    .slice(0, 12)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(" ")
}

const STOP_WORDS = new Set(
  "the and for with that this from have has had not but you your are was were will would can could should how what when where why who which into about just also then than them they their there here use using need want make like please para con que los las del una uno por como esto esta pero mas muy sus hay puede quiero necesito favor".split(" "),
)

/**
 * A prompt → FTS5 query where any of its distinctive words may match (OR, prefix-matched, at most 16; stop words and
 * words under 3 letters dropped). `ftsQuery` needs every word, which a whole prompt never satisfies.
 */
export function ftsAnyQuery(text: string) {
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((word) => word.length >= 3 && !STOP_WORDS.has(word)))
  return [...words]
    .slice(0, 16)
    .map((word) => `"${word.replaceAll('"', '""')}"*`)
    .join(" OR ")
}

const DREAM_RUNS_KEPT = 50
/** `dream.list` sends the report of this many newest runs; older ones are fetched one by one. */
const DREAM_REPORTS_SHOWN = 5
/** A stored digest is a few KB by design (packages/dream); anything bigger is a bug, not data. */
const MAX_DIGEST_PAYLOAD = 16_000
const EVOLUTION_EVIDENCE_DAYS = 30
const EVOLUTION_EVIDENCE_KEPT = 500
const EVOLUTION_PENDING_MAX = 100

type DreamRunRow = { id: number; directory: string; status: string; started_at: number; ended_at: number | null; proposed: number; notes: string | null; error: string | null; started_by: string | null; report: string | null }

function toDreamRun(row: DreamRunRow, withReport: boolean): DreamRun {
  const trigger = DreamTrigger.safeParse(row.started_by)
  const report = withReport && row.report ? DreamReport.safeParse(safeJson(row.report)) : undefined
  return {
    runId: row.id,
    directory: row.directory,
    status: row.status as DreamRun["status"],
    ...(trigger.success ? { trigger: trigger.data } : {}),
    startedAt: row.started_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    proposed: row.proposed,
    ...(row.notes ? { notes: row.notes } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(report?.success ? { report: report.data } : {}),
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type EvolutionSuggestionRow = { id: number; directory: string; kind: string; name: string; description: string; content: string; evidence: number; status: string; created_at: number; resolved_at: number | null; run_id: number | null; policy_revision: string | null; receipt: string | null }

function toSuggestion(row: EvolutionSuggestionRow): EvolutionSuggestion {
  const receipt = EvolutionReceipt.safeParse(row.receipt ? safeJson(row.receipt) : undefined)
  return {
    suggestionId: row.id,
    directory: row.directory,
    kind: row.kind === "instruction" || row.kind === "workflow" ? row.kind : "skill",
    name: row.name,
    description: row.description,
    content: row.content,
    evidence: row.evidence,
    status: row.status === "accepted" || row.status === "rejected" || row.status === "blocked" || row.status === "rolled_back" ? row.status : "pending",
    createdAt: row.created_at,
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    hash: createHash("sha256").update(JSON.stringify([row.directory, row.kind, row.name, row.description, row.content, row.evidence, row.policy_revision])).digest("hex"),
    ...(row.policy_revision ? { policyRevision: row.policy_revision } : {}),
    ...(receipt.success ? { receipt: receipt.data } : {}),
  }
}
export { cappedPromptHistoryEntry, PROMPT_HISTORY_LIMIT, PROMPT_HISTORY_MAX_CHARS, type PromptEntry, type PromptKind } from "./prompt-history"

export type UsageDay = {
  day: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  costMicros: number
  costUnknownCalls: number
  calls: number
  sessions: number
}

export type UsageActivityDay = { day: string; prompts: number; words: number; aiMs: number; toolMs: number; longestAiMs?: number }
export type UsageTool = { tool: string; calls: number; ms: number; errors: number }

export type StorageSession = { sessionId: string; title: string; directory: string; updatedAt: number; bytes: number }
export type StorageReport = {
  dbBytes: number
  walBytes: number
  blobBytes: number
  blobs: number
  orphanBlobs: number
  orphanBytes: number
  goalFiles: number
  goalBytes: number
  orphanGoalFiles: number
  orphanGoalBytes: number
  sessions: number
  events: number
  eventBytes: number
  engineBytes: number
  otherBytes: number
  freeBytes: number
  autoVacuum: "none" | "full" | "incremental"
  topSessions: StorageSession[]
  /** Fork histories that point at a parent, the messages and bytes they read through it (stored once, in the parent's rows). */
  forkRefs: number
  sharedMessages: number
  sharedBytes: number
  /** Tool output shared between a session and its forks: objects stored once, and the references to them. */
  eventObjects: number
  eventObjectBytes: number
  eventObjectRefs: number
} & StorageExtras
export type StorageCleanResult = {
  dryRun: boolean
  olderThanDays: number
  sessionsRemoved: number
  eventsRemoved: number
  blobsRemoved: number
  goalFilesRemoved: number
  bytesReclaimed: number
  protectedSessions: number
  vacuumed: boolean
}
const DAY_MS = 86_400_000
const CLEAN_BATCH = 25
/** A blob file no row knows about is an abandoned upload only after this long (an attachment may be about to be sent). */
const STRAY_GRACE_MS = 3_600_000
const TOP_SESSIONS = 10
/** Loops in these states are done; every other loop keeps its root session. */
const FINISHED_LOOP_STATES = new Set(["stopped", "completed"])
/** Workflow runs in these states are done: they are kept only up to MAX_FINISHED_WORKFLOWS and their sessions are not protected. */
const FINISHED_WORKFLOW_STATES = ["completed", "failed", "stopped"] as const
const FINISHED_WORKFLOW_SQL = FINISHED_WORKFLOW_STATES.map((state) => `'${state}'`).join(", ")
const MAX_FINISHED_WORKFLOWS = 50

/** The root, task and auditor sessions a workflow run owns. */
function workflowSessionIds(run: WorkflowRun): string[] {
  return [run.rootSessionId, ...run.tasks.flatMap((task) => (task.sessionId ? [task.sessionId] : [])), ...run.verifications.flatMap((verification) => (verification.audit ? [verification.audit.sessionId] : []))]
}

function localDay(at: number) {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

const TRACKED_ITEM_KINDS = new Set(["agent_message", "reasoning", "tool_call"])
const MAX_TOOL_NAME = 64

/** "shell: bun test" → "shell"; raw commands and unnamed titles → "shell"; "editar a, b" → "edit". */
export function toolBucket(tool: string | undefined) {
  const head = (tool ?? "").split(":")[0]!.trim()
  if (/^editar\b/.test(head)) return "edit"
  return /^[A-Za-z][\w.-]*$/.test(head) ? head.slice(0, MAX_TOOL_NAME) : "shell"
}

const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0)

/** The events of a turn a fork at a message takes along: what a transcript draws. */
const COPIED_EVENT_TYPES = ["turn.started", "turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed", "item.started", "item.delta", "item.completed", "server.request", "server.request.resolved"].map((type) => `'${type}'`).join(", ")

const TERMINAL_TURN_EVENTS = new Set(["turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"])

type SessionRow = { id: SessionId; title: string; directory: string; created_at: number; updated_at: number; last_seq: number; parent_id: string | null; archived_at: number | null }

/** First line of the first message, trimmed to a readable title. */
export function titleFrom(text: string) {
  const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ")
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line
}

/** Additive, idempotent migrations for databases created by earlier builds. */
function migrate(db: Database) {
  const columns = (table: string) => new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name))
  const sessions = columns("sessions")
  if (!sessions.has("active_turn")) db.run("ALTER TABLE sessions ADD COLUMN active_turn TEXT")
  if (!sessions.has("updated_at")) {
    db.run("ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0")
    db.run("UPDATE sessions SET updated_at = created_at")
  }
  if (!sessions.has("permission_mode")) db.run("ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'")
  if (!sessions.has("model")) db.run("ALTER TABLE sessions ADD COLUMN model TEXT")
  if (!sessions.has("effort")) db.run("ALTER TABLE sessions ADD COLUMN effort TEXT")
  if (!sessions.has("model_options")) db.run("ALTER TABLE sessions ADD COLUMN model_options TEXT")
  if (!sessions.has("agent")) db.run("ALTER TABLE sessions ADD COLUMN agent TEXT")
  if (!sessions.has("archived_at")) db.run("ALTER TABLE sessions ADD COLUMN archived_at INTEGER")
  if (!sessions.has("pinned_at")) db.run("ALTER TABLE sessions ADD COLUMN pinned_at INTEGER")
  if (!sessions.has("lifecycle")) db.run("ALTER TABLE sessions ADD COLUMN lifecycle TEXT")
  if (!sessions.has("fanout")) db.run("ALTER TABLE sessions ADD COLUMN fanout TEXT")
  if (!columns("queue_items").has("kind")) db.run("ALTER TABLE queue_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'")
  const memories = columns("memories")
  if (!memories.has("kind")) db.run("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'new'")
  if (!memories.has("target_id")) db.run("ALTER TABLE memories ADD COLUMN target_id TEXT")
  if (!memories.has("reason")) db.run("ALTER TABLE memories ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
  if (!memories.has("profile")) db.run("ALTER TABLE memories ADD COLUMN profile TEXT NOT NULL DEFAULT ''")
  if (!memories.has("session_id")) db.run("ALTER TABLE memories ADD COLUMN session_id TEXT")
  if (!memories.has("pinned")) db.run("ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
  if (!memories.has("model_data")) db.run("ALTER TABLE memories ADD COLUMN model_data TEXT")
  db.run("CREATE INDEX IF NOT EXISTS memories_session ON memories(session_id) WHERE session_id IS NOT NULL")
  const dreamRuns = columns("dream_runs")
  if (!dreamRuns.has("started_by")) db.run("ALTER TABLE dream_runs ADD COLUMN started_by TEXT")
  if (!dreamRuns.has("report")) db.run("ALTER TABLE dream_runs ADD COLUMN report TEXT")
  if (!columns("evolution_evidence").has("fingerprint")) db.run("ALTER TABLE evolution_evidence ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''")
  if (!columns("evolution_suggestions").has("policy_revision")) db.run("ALTER TABLE evolution_suggestions ADD COLUMN policy_revision TEXT")
  if (!columns("evolution_suggestions").has("receipt")) db.run("ALTER TABLE evolution_suggestions ADD COLUMN receipt TEXT")
  db.run("CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC)")
  if (!columns("queue_items").has("authority_text")) db.run("ALTER TABLE queue_items ADD COLUMN authority_text TEXT")
  if (!columns("turn_files").has("after_mode")) db.run("ALTER TABLE turn_files ADD COLUMN after_mode INTEGER")
  if (!columns("turn_files").has("after_skip_reason")) db.run("ALTER TABLE turn_files ADD COLUMN after_skip_reason TEXT")
  if (!columns("prompt_history").has("kind")) db.run("ALTER TABLE prompt_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'sent'")
  if (!columns("undo_stack").has("partial")) db.run("ALTER TABLE undo_stack ADD COLUMN partial TEXT")
}

function blobRefsOf(event: SessionEvent): BlobRef[] {
  if (event.type !== "item.completed") return []
  return [...(event.blob ? [event.blob] : []), ...(event.attachments ?? [])]
}

/**
 * The single writer of MendCode state (P1). Implements the kernel's event sinks: every append
 * assigns `seq`, validates, persists and updates projections in one transaction, so pages read
 * precomputed rows instead of scanning history (A8).
 */
export function openStore(options: { dir: string; warn?: (message: string) => void; now?: () => number; dayOf?: (at: number) => string; /** false writes the uncompressed legacy forms (how the "before" size is measured); reading handles both. */ compress?: boolean; /** Page size of a database created now (an existing file keeps its own); 4096 was the size before 16384. */ pageSize?: number }) {
  mkdirSync(options.dir, { recursive: true })
  const now = options.now ?? Date.now
  const dayOf = options.dayOf ?? localDay
  const lock = acquireWriterLock(path.join(options.dir, "mendd.lock"))
  let privateDb: ReturnType<typeof openPrivateDatabase> | undefined
  try {
  const dbPath = path.join(options.dir, "mendd.db")
  privateDb = openPrivateDatabase(options.dir, dbPath)
  const privacyDatabase = privateDb
  const privacyFiles = { beforeConvert: () => beginConversion(privacyDatabase.enabled()), enabled: privacyDatabase.enabled, sealed: privacyDatabase.sealed, warn: (message: string) => options.warn?.(message) }
  const blobs = createBlobFiles(path.join(options.dir, "blobs"), privacyFiles)
  const privateFiles = createPrivateFiles(options.dir, privacyFiles)
  const environment = createEnvironment(options.dir, now)
  const db = privateDb.db
  // Only a database that has no tables yet takes a new page size. A table whose rows are keyed by text (events) keeps a
  // payload over about a quarter of a page in overflow pages, so 4 KB pages turned every 1.2 KB event into 8 KB on disk
  // (measured: 16 KB pages hold the same synthetic sessions in two thirds of the space, at the same write speed).
  db.run(`PRAGMA page_size = ${options.pageSize ?? DEFAULT_PAGE_SIZE}`)
  for (const pragma of PRAGMAS) db.run(pragma)
  db.run(DDL)
  migrate(db)
  const transcript = createTranscriptPrefix(db)
  const eventObjects = createEventObjects(db)
  const messages = createMessageRevisions(db, eventObjects.load)
  db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])

  function matchMemories(match: string, options: { directory?: string; limit?: number; profile?: string; session?: SessionId | "all" }): Array<{ memory: MemoryEntry; rank: number }> {
    return db
      .query<MemoryRow & { rank: number }, [string, string | null, number, string | null, string | null]>(
        `SELECT ${memoryColumns("m.")}, memories_fts.rank AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.memory_id
         WHERE memories_fts MATCH ?1 AND m.status = 'saved' AND ((m.scope = 'user' AND (?4 IS NULL OR m.profile = ?4)) OR (m.scope = 'project' AND (?2 IS NULL OR m.directory = ?2)) OR (m.scope = 'session' AND ?5 IS NOT NULL AND (?5 = 'all' OR m.session_id = ?5) AND (?2 IS NULL OR m.directory = ?2))) ORDER BY rank LIMIT ?3`,
      )
      .all(match, options.directory ?? null, options.limit ?? 20, profileKey(options.profile), options.session ?? null)
      .map((row) => ({ memory: toMemory(row), rank: row.rank }))
  }

  /** A deleted session takes its session-scope memories (and their FTS rows and links) with it. */
  function dropSessionMemories(sessionId: string) {
    const ids = db.query<{ id: string }, [string]>("SELECT id FROM memories WHERE session_id = ?").all(sessionId)
    for (const { id } of ids) {
      db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(id)
      db.query("DELETE FROM memory_links WHERE from_id = ?1 OR to_id = ?1").run(id)
      db.query("DELETE FROM memories WHERE id = ?").run(id)
    }
  }

  const memorySharing = createMemorySharingRecords(db)
  db.run("CREATE TABLE IF NOT EXISTS memory_revision_bases (proposal_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, revision TEXT NOT NULL) WITHOUT ROWID")

  /**
   * One page of a session's log, newest or oldest first. `events_read` (own events UNION ALL the forked prefix) cannot
   * be paged through directly: SQLite builds the whole view for the session and sorts it before applying LIMIT (30,000
   * rows and about 20 ms for a 10,000-message session, in whichever process runs the query). Each branch is cut to the
   * page on its own index first and only those rows are merged; the rows are the same as the view's.
   */
  const eventsPage = (order: "ASC" | "DESC", bound: ">" | "<" | undefined) => {
    const where = bound ? `session_id = ?1 AND seq ${bound} ?2` : "session_id = ?1"
    const prefixWhere = bound ? `p.session_id = ?1 AND p.seq ${bound} ?2` : "p.session_id = ?1"
    const limit = bound ? "?3" : "?2"
    return `SELECT payload FROM (
      SELECT seq, payload FROM (SELECT seq, payload FROM events WHERE ${where} ORDER BY seq ${order} LIMIT ${limit})
      UNION ALL
      SELECT seq, payload FROM (SELECT p.seq AS seq, json_set(e.payload, '$.sessionId', p.session_id, '$.seq', p.seq) AS payload FROM transcript_prefix p JOIN events e ON e.session_id = p.parent_id AND e.seq = p.parent_seq WHERE ${prefixWhere} ORDER BY p.seq ${order} LIMIT ${limit})
    ) ORDER BY seq ${order} LIMIT ${limit}`
  }

  const q = {
    lastSeq: db.query<{ last_seq: number }, [string]>("SELECT last_seq FROM sessions WHERE id = ?"),
    setSeq: db.query("UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?"),
    autoTitle: db.query("UPDATE sessions SET title = ? WHERE id = ? AND title = ''"),
    queuedCount: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM queue_items WHERE session_id = ?"),
    queueInsert: db.query("INSERT OR REPLACE INTO queue_items(session_id, queue_id, position, text, attachments, kind, authority_text) VALUES (?, ?, 1000000, ?, ?, ?, ?)"),
    queueKeep: db.query("UPDATE queue_items SET position = ? WHERE session_id = ? AND queue_id = ?"),
    setActiveTurn: db.query("UPDATE sessions SET active_turn = ? WHERE id = ?"),
    insertSession: db.query("INSERT INTO sessions(id, directory, title, parent_id, created_at) VALUES (?, ?, ?, ?, ?)"),
    insertEvent: db.query("INSERT INTO events(session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)"),
    readAfter: db.query<{ payload: string }, [string, number, number]>(eventsPage("ASC", ">")),
    readBefore: db.query<{ payload: string }, [string, number, number]>(eventsPage("DESC", "<")),
    readNewest: db.query<{ payload: string }, [string, number]>(eventsPage("DESC", undefined)),
    recentUsage: db.query<{ payload: string }, [string, number]>(
      "SELECT e.payload FROM events e WHERE e.session_id = ? AND e.type = 'usage.recorded' AND NOT EXISTS (SELECT 1 FROM turns_read t WHERE t.session_id = e.session_id AND t.turn_id = json_extract(e.payload, '$.turnId') AND t.reverted = 1) ORDER BY e.seq DESC LIMIT ?",
    ),
    maxGseq: db.query<{ gseq: number | null }, []>("SELECT MAX(gseq) AS gseq FROM global_events"),
    insertGlobal: db.query("INSERT INTO global_events(gseq, type, at, payload) VALUES (?, ?, ?, ?)"),
    upsertUsage: db.query(`
      INSERT INTO usage_daily(day, provider, model, input, output, reasoning, cache_read, cache_write, cost_micros, cost_unknown_calls, calls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(day, provider, model) DO UPDATE SET
        input = input + excluded.input, output = output + excluded.output, reasoning = reasoning + excluded.reasoning,
        cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
        cost_micros = cost_micros + excluded.cost_micros, cost_unknown_calls = cost_unknown_calls + excluded.cost_unknown_calls,
        calls = calls + 1`),
    bumpPrompt: db.query(`
      INSERT INTO usage_activity(day, prompts, words) VALUES (?, 1, ?)
      ON CONFLICT(day) DO UPDATE SET prompts = prompts + 1, words = words + excluded.words`),
    bumpAi: db.query("INSERT INTO usage_activity(day, ai_ms) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET ai_ms = ai_ms + excluded.ai_ms"),
    bumpResponsePeak: db.query("INSERT INTO usage_response_peaks(day, longest_ms) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET longest_ms = MAX(longest_ms, excluded.longest_ms)"),
    bumpToolTime: db.query("INSERT INTO usage_activity(day, tool_ms) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tool_ms = tool_ms + excluded.tool_ms"),
    bumpTool: db.query(`
      INSERT INTO usage_tools(day, tool, calls, ms, errors) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(day, tool) DO UPDATE SET calls = calls + 1, ms = ms + excluded.ms, errors = errors + excluded.errors`),
    sessionDay: db.query("INSERT OR IGNORE INTO usage_session_days(day, session_id) VALUES (?, ?)"),
    bumpDaySessions: db.query("INSERT INTO usage_days(day, sessions) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET sessions = sessions + 1"),
    upsertQuota: db.query(
      "INSERT INTO quota_latest(provider, fetched_at, payload) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload WHERE excluded.fetched_at >= quota_latest.fetched_at",
    ),
    insertBlob: db.query("INSERT OR IGNORE INTO blobs(sha256, bytes, mime, created_at) VALUES (?, ?, ?, ?)"),
    insertBlobRef: db.query("INSERT OR IGNORE INTO blob_refs(sha256, session_id) VALUES (?, ?)"),
  }

  const insights = createUsageInsights({ db, dayOf })
  insights.backfill()
  const usageScopes = createUsageScopes({ db, dayOf, toolBucket })
  const usageCalls = createUsageCalls({ db, dayOf })
  usageCalls.backfill()
  const codec = createCodec({ enabled: options.compress ?? true, objects: eventObjects })
  const engineHistory = createEngineHistory(db)
  const turns = createTurns({ db, codec, history: engineHistory, writeTurn: transcript.writeTurn })
  const upkeep = createStorageUpkeep({ db, codec, turns, now, objects: eventObjects })
  // The per-turn projection is built once from the log written before it existed; afterwards every append keeps it current.
  if (!db.query("SELECT 1 FROM meta WHERE key = 'turns_backfill'").get()) {
    db.transaction(() => {
      turns.backfill()
      db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('turns_backfill', '1')")
    })()
  }
  const agentCommands = createAgentCommandRecords(db, now)
  const continuity = createContinuityRecords(db)
  const parity = createParityRecords(db)
  const sessionBackground = createSessionBackgroundRecords(db, now)
  const recall = createSessionRecallRecords(db, eventObjects.load)
  const sessionStats = createSessionStatsRecords(db)
  const sessionSearch = createSessionSearch(db)
  const automationLedger = createAutomationLedger(db)
  const workflowJournal = createWorkflowJournal(db)
  // Existing projections can seed available evidence, never reconstruct their missing event history.
  db.transaction(() => {
    for (const row of db.query<{ payload: string }, []>("SELECT payload FROM workflows").all()) {
      const parsed = WorkflowRun.safeParse(JSON.parse(row.payload))
      if (parsed.success && !automationLedger.known("workflow", parsed.data.workflowId)) automationLedger.workflow(parsed.data, undefined, false)
    }
    for (const row of db.query<{ payload: string }, []>("SELECT payload FROM loops").all()) {
      const parsed = Loop.safeParse(JSON.parse(row.payload))
      if (parsed.success && !automationLedger.known("loop", parsed.data.loopId)) automationLedger.loop(parsed.data, undefined, false)
    }
  })()
  const drafts = createDrafts({ db, now })
  /** The agents a new chat starts as by default (global and per project): a session on one of them has no setting of its own. */
  const defaultAgents = () => {
    const payload = db.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id = 1").get()?.payload
    if (!payload) return []
    try {
      const settings = JSON.parse(payload) as { defaultAgent?: unknown; projectConfig?: Record<string, { defaultAgent?: unknown } | undefined> }
      return [...new Set([settings.defaultAgent, ...Object.values(settings.projectConfig ?? {}).map((project) => project?.defaultAgent)].filter((name): name is string => typeof name === "string" && name.length > 0))]
    } catch {
      return []
    }
  }
  const emptySessions = createEmptySessions({ db, agents: defaultAgents })
  const sessionTree = createSessionTree({ db, now })
  const handoff = createSessionHandoff({ db, now })
  const goals = createGoals({ db, now })
  const usagePauses = createUsagePauses(db)
  const acpSettings = createAcpSettings(options.dir)
  /** `current` with `patch` merged (`null` removes a key) and validated; `saveAcp` writes the ACP part, which lives in its own file. */
  const mergedSettings = (current: Settings, patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...current }
    delete next.acpAgents
    const saveAcp = "acpAgents" in patch ? acpSettings.prepare(patch.acpAgents) : undefined
    for (const [key, value] of Object.entries(patch)) {
      if (key === "acpAgents") continue
      if (value === null) delete next[key]
      else next[key] = value
    }
    return { valid: Settings.parse(next), saveAcp }
  }
  const secrets = createSecrets({ db, dir: options.dir, now })

  let gseq = q.maxGseq.get()?.gseq ?? 0

  /** Items started but not completed, per session. Bounded: a session's entry is dropped when its turn ends or it is deleted. */
  const openItems = new Map<string, Map<string, { kind: string; at: number; tool?: string }>>()

  /** Prompt recall (↑) per project, bounded to PROMPT_HISTORY_LIMIT entries per directory (P11). */
  const promptHistory = createPromptHistory({ db })
  /** A queued entry as the user typed it: a shell line keeps its `!` of `!!command`, an expanded command its `/name args`. */
  function recordQueued(event: Extract<SessionEvent, { type: "queue.added" }>) {
    const typed = event.displayText ?? event.text
    const kind: PromptKind = event.shell ? "shell" : event.displayText !== undefined && /^\/[a-z0-9]/i.test(typed) ? "command" : "sent"
    promptHistory.record(event.sessionId, event.shell && event.local ? `!${typed}` : typed, event.at, kind)
  }

  const appendSession = db.transaction((draft: SessionEventDraft, importedAt?: number) => {
    const row = q.lastSeq.get(draft.sessionId)
    if (!row) throw new RangeError(`[STORE]: unknown session ${draft.sessionId}`)
    const event = SessionEvent.parse({ ...draft, seq: row.last_seq + 1, at: importedAt ?? now() })
    const payload = JSON.stringify(event)
    if (payload.length > MAX_EVENT_BYTES) throw new RangeError(`[STORE]: event ${event.type} is ${payload.length} bytes; use the blob store`)
    const open = event.type === "item.completed" || event.type === "item.delta" ? openItems.get(event.sessionId)?.get(event.itemId) : undefined
    const packed = codec.packEvent(event, payload, open?.kind === "tool_call")
    const ref = JSON.parse(packed).zref as string | undefined
    if (ref) eventObjects.refer(ref, event.sessionId)
    q.insertEvent.run(event.sessionId, event.seq, event.type, event.at, packed)
    q.setSeq.run(event.seq, event.at, event.sessionId)
    if (event.type === "item.started" && TRACKED_ITEM_KINDS.has(event.kind)) {
      let items = openItems.get(event.sessionId)
      if (!items) openItems.set(event.sessionId, (items = new Map()))
      const tool = event.meta?.tool
      items.set(event.itemId, { kind: event.kind, at: event.at, ...(typeof tool === "string" ? { tool } : {}) })
    }
    if (event.type === "item.completed") {
      const items = openItems.get(event.sessionId)
      const started = items?.get(event.itemId)
      if (started) {
        items!.delete(event.itemId)
        const ms = Math.max(0, event.at - started.at)
        const day = dayOf(event.at)
        if (started.kind === "tool_call") {
          q.bumpToolTime.run(day, ms)
          q.bumpTool.run(day, toolBucket(started.tool), ms, event.status === "error" ? 1 : 0)
        } else {
          q.bumpAi.run(day, ms)
          q.bumpResponsePeak.run(day, ms)
        }
      }
    }
    if (event.type === "queue.added") {
      q.queueInsert.run(event.sessionId, event.queueId, event.text, JSON.stringify(event.attachments), event.compact ? "compact" : event.notice ? "notice" : event.shell ? "shell" : "message", event.authorityText ?? null)
      // A queued /compact or system notice is not a prompt: it neither counts as usage nor titles the session.
      if (!event.compact && !event.notice) {
        q.bumpPrompt.run(dayOf(event.at), wordCount(event.text))
        q.autoTitle.run(titleFrom(event.text), event.sessionId)
        recordQueued(event)
      }
    }
    if (event.type === "queue.edited") db.query("UPDATE queue_items SET text = ? WHERE session_id = ? AND queue_id = ?").run(event.text, event.sessionId, event.queueId)
    if (event.type === "queue.changed") {
      const keep = new Set(event.queue.map((entry) => entry.queueId))
      const rows = db.query<{ queue_id: string }, [string]>("SELECT queue_id FROM queue_items WHERE session_id = ?").all(event.sessionId)
      for (const row of rows) if (!keep.has(row.queue_id as never)) db.query("DELETE FROM queue_items WHERE session_id = ? AND queue_id = ?").run(event.sessionId, row.queue_id)
      event.queue.forEach((entry, position) => q.queueKeep.run(position, event.sessionId, entry.queueId))
    }
    if (event.type === "session.workspace.changed") db.query("UPDATE sessions SET directory = ? WHERE id = ?").run(event.directory, event.sessionId)
    if (event.type === "session.permission") db.query("UPDATE sessions SET permission_mode = ? WHERE id = ?").run(event.mode, event.sessionId)
    if (event.type === "turn.started") q.setActiveTurn.run(event.turnId, event.sessionId)
    else if (TERMINAL_TURN_EVENTS.has(event.type)) {
      q.setActiveTurn.run(null, event.sessionId)
      openItems.delete(event.sessionId)
    }
    if (event.type === "usage.recorded") {
      const day = dayOf(event.at)
      q.upsertUsage.run(day, event.provider, event.model, event.input, event.output, event.reasoning, event.cacheRead, event.cacheWrite, event.costMicros ?? 0, event.costMicros === undefined ? 1 : 0)
      if (q.sessionDay.run(day, event.sessionId).changes === 1) q.bumpDaySessions.run(day)
    }
    insights.record(event)
    usageScopes.record(event)
    usageCalls.record(event)
    turns.record(event)
    messages.record(event)
    for (const ref of blobRefsOf(event)) {
      q.insertBlob.run(ref.sha256, ref.bytes, ref.mime, event.at)
      q.insertBlobRef.run(ref.sha256, event.sessionId)
    }
    return event
  })

  const appendGlobal = db.transaction((draft: GlobalEventDraft) => {
    const event = GlobalEvent.parse({ ...draft, gseq: gseq + 1, at: now() })
    q.insertGlobal.run(event.gseq, event.type, event.at, JSON.stringify(event))
    gseq = event.gseq
    if (event.type === "quota.snapshot") q.upsertQuota.run(event.provider, event.fetchedAt, JSON.stringify(event))
    return event
  })

  const createSession = db.transaction((input: { id: SessionId; directory: string; title: string; parentId?: SessionId }) => {
    q.insertSession.run(input.id, input.directory, input.title, input.parentId ?? null, now())
    return appendSession({
      type: "session.created",
      sessionId: input.id,
      directory: input.directory,
      title: input.title,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    })
  })

  const num1 = (sql: string) => Number(Object.values(db.query<Record<string, number>, []>(sql).get() ?? { n: 0 })[0] ?? 0)

  /** Files in the blob store that no `blobs` row owns (abandoned uploads, partial writes), old enough to be safe. */
  function strayFiles(graceMs = STRAY_GRACE_MS) {
    // An image attached to an unsent draft has no `blobs` row yet; it is kept like an owned one.
    const known = new Set(db.query<{ sha256: string }, []>(`SELECT sha256 FROM blobs UNION SELECT * FROM (${draftBlobsSql})`).all().map((row) => row.sha256))
    const cutoff = Date.now() - graceMs
    return blobs.scan().filter((file) => !known.has(file.name) && file.mtimeMs <= cutoff)
  }

  function removeOrphanBlobs(graceMs?: number) {
    const orphans = db.query<{ sha256: string; bytes: number }, []>(`SELECT sha256, bytes FROM blobs WHERE sha256 NOT IN (SELECT sha256 FROM blob_refs) AND sha256 NOT IN (${draftBlobsSql})`).all()
    let freedBytes = 0
    for (const blob of orphans) {
      db.query("DELETE FROM blobs WHERE sha256 = ?").run(blob.sha256)
      blobs.remove(blob.sha256)
      freedBytes += blob.bytes
    }
    // Strays are decided after the rows above are gone, so a just-orphaned blob is not counted twice.
    const strays = strayFiles(graceMs)
    for (const file of strays) {
      blobs.remove(file.name)
      freedBytes += file.bytes
    }
    return { removed: orphans.length + strays.length, freedBytes }
  }

  function fileSize(file: string) {
    return existsSync(file) ? statSync(file).size : 0
  }

  /** Only regular objective files in our goals folder; keep every live session's current and historical goals. */
  function goalFiles(removing: ReadonlySet<string> = new Set()) {
    const root = path.join(options.dir, "goals")
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return []
    const files = readdirSync(root).flatMap((name) => {
      if (!name.endsWith(".md") || !GoalId.safeParse(name.slice(0, -3)).success) return []
      const file = path.join(root, name)
      const stat = lstatSync(file)
      return stat.isFile() ? [{ file, bytes: stat.size }] : []
    })
    if (!files.length) return []
    const liveFiles = new Set<string>()
    const keep = (sessionId: string, goalId: string, file: string | null) => {
      if (removing.has(sessionId)) return
      liveFiles.add(path.join(root, `${goalId}.md`))
      if (file) liveFiles.add(path.resolve(file))
    }
    for (const row of db.query<{ session_id: string; id: string; objective_file: string | null }, []>("SELECT g.session_id, g.id, g.objective_file FROM goals g JOIN sessions s ON s.id = g.session_id").all()) keep(row.session_id, row.id, row.objective_file)
    // History is capped in the goals table; its session events still own older objective files.
    for (const row of db.query<{ session_id: string; id: string; file: string | null }, []>("SELECT e.session_id, json_extract(e.payload, '$.goal.goalId') AS id, json_extract(e.payload, '$.goal.objectiveFile') AS file FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.type = 'goal.changed'").all()) keep(row.session_id, row.id, row.file)
    return files.map((file) => ({ ...file, orphan: !liveFiles.has(file.file) }))
  }

  type Conversion = { target: boolean; scanned: boolean; blobs: string[]; files: string[] }
  const savedConversion = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'privacy_conversion'").get()
  let conversion: Conversion | undefined = savedConversion ? JSON.parse(savedConversion.value) : undefined
  function saveConversion(next?: Conversion) {
    // FULL commits the intent before any file changes, including when SQLite uses WAL.
    const synchronous = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous
    db.run("PRAGMA synchronous = FULL")
    try {
      if (next) db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('privacy_conversion', ?)", [JSON.stringify(next)])
      else db.run("DELETE FROM meta WHERE key = 'privacy_conversion'")
      conversion = next
    } finally { db.run(`PRAGMA synchronous = ${synchronous}`) }
  }
  function beginConversion(target: boolean) {
    if (!conversion || conversion.target !== target) saveConversion({ target, scanned: false, blobs: [], files: [] })
  }
  function convertFiles(opening = false) {
    const thorough = !!conversion || !opening
    if (conversion) privacyDatabase.set(conversion.target)
    const selected = conversion?.scanned ? conversion : undefined
    blobs.convert(opening && !conversion, selected?.blobs)
    privateFiles.convert(selected?.files, opening && !thorough)
    // A cheap header scan may discover an old interrupted conversion. Cover earlier files too.
    if (!thorough && (conversion || blobs.pending.size || privateFiles.pending.size)) {
      beginConversion(privacyDatabase.enabled())
      blobs.convert()
      privateFiles.convert()
    }
    if (blobs.pending.size || privateFiles.pending.size) {
      saveConversion({ target: privacyDatabase.enabled(), scanned: true,
        blobs: [...blobs.pending].map((file) => path.basename(file)),
        files: [...privateFiles.pending].map((file) => path.relative(path.resolve(options.dir), file)) })
    } else if (conversion) saveConversion()
  }
  privateDb.start()
  convertFiles(true)
  return {
    sessionSink: { append: (draft: SessionEventDraft) => appendSession(draft) },
    projectSync: createProjectSyncRecords(db, appendSession, engineHistory, eventObjects.load),
    automationLedger,
    messages,
    /** Revision, model history and history marks commit together; no half-edited conversation. */
    reviseMessage(draft: Extract<SessionEventDraft, { type: "message.revised" }>, history?: { messages: unknown[]; removed: number[] }) {
      return db.transaction(() => {
        if (history) {
          engineHistory.cut(draft.sessionId, "native", 0)
          history.messages.forEach((message, i) => engineHistory.insert(draft.sessionId, "native", i, codec.packText(JSON.stringify(message))))
          for (const turn of turns.list(draft.sessionId)) {
            const mark = turn.history?.native
            if (typeof mark === "number") turns.setHistory(draft.sessionId, turn.turnId, { ...turn.history, native: mark - history.removed.filter((i) => i < mark).length })
          }
        }
        db.query("DELETE FROM undo_stack WHERE session_id = ?").run(draft.sessionId)
        db.query("DELETE FROM undone_messages WHERE session_id = ?").run(draft.sessionId)
        return appendSession(draft) as import("@mendcode/protocol").MessageRevision
      })()
    },
    permissionRecords: createPermissionRecords(db, now, eventObjects.load),
    globalSink: { append: (draft: GlobalEventDraft) => appendGlobal(draft) },
    createSession,
    /** A validated transcript enters atomically, with fresh IDs and its original event times. */
    importTranscript(input: { id: SessionId; directory: string; title: string; createdAt: number; events: Array<SessionEventDraft & { at: number }>; messages: unknown[]; origin: { sourceSessionId: string; truncated: boolean; sanitized: boolean } }) {
      try {
        db.transaction(() => {
          q.insertSession.run(input.id, input.directory, input.title, null, input.createdAt)
          appendSession({ type: "session.created", sessionId: input.id, directory: input.directory, title: input.title, imported: input.origin }, input.createdAt)
          for (const { at, ...event } of input.events) appendSession(event as SessionEventDraft, at)
          const insert = db.query("INSERT INTO engine_messages(session_id, engine, idx, payload) VALUES (?, 'native', ?, ?)")
          input.messages.forEach((message, i) => insert.run(input.id, i, codec.packText(JSON.stringify(message))))
        })()
      } finally { openItems.delete(input.id) }
    },
    hasSession(sessionId: SessionId) {
      return q.lastSeq.get(sessionId) !== null
    },
    /** Sessions whose last turn never reached a terminal event (daemon crash/kill). */
    /** Session summaries for the picker, newest activity first (indexed; no event scan). */
    memorySharing,
    memories: {
      get(memoryId: MemoryId) {
        const row = db.query<MemoryRow, [string]>(`${MEMORY_SELECT} WHERE id = ?`).get(memoryId)
        return row ? toMemory(row) : undefined
      },
      /**
       * User scope plus the project scope of `directory` (all projects when omitted), newest first. With `profile`, only
       * that profile's user memories (profiles keep their memory apart); without it, every profile's. Session-scope
       * memories appear only with `session` (one session's, or `all`).
       */
      list(options: { directory?: string; status?: MemoryStatus; profile?: string; session?: SessionId | "all" } = {}): MemoryEntry[] {
        return db
          .query<MemoryRow, [string | null, string | null, string | null, string | null]>(`${MEMORY_SELECT} WHERE ${MEMORY_VISIBLE} AND (?2 IS NULL OR status = ?2) ORDER BY updated_at DESC, id DESC`)
          .all(options.directory ?? null, options.status ?? null, profileKey(options.profile), options.session ?? null)
          .map(toMemory)
      },
      add(entry: Omit<MemoryEntry, "createdAt" | "updatedAt">) {
        const at = now()
        db.transaction(() => {
          db.query("INSERT INTO memories(id, scope, directory, text, category, status, source, created_at, updated_at, kind, target_id, reason, profile, session_id, pinned, model_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
            entry.memoryId,
            entry.scope,
            entry.directory ?? null,
            entry.text,
            entry.category,
            entry.status,
            entry.source,
            at,
            at,
            entry.kind ?? "new",
            entry.targetId ?? null,
            entry.reason ?? "",
            profileKey(entry.profile) ?? "",
            entry.sessionId ?? null,
            entry.pinned ? 1 : 0,
            entry.details ? JSON.stringify(entry.details) : null,
          )
          db.query("INSERT INTO memories_fts(memory_id, text, category) VALUES (?, ?, ?)").run(entry.memoryId, entry.text, entry.category)
          if (entry.status === "pending" && entry.targetId && (entry.kind === "update" || entry.kind === "archive")) {
            const target = db.query<MemoryRow, [string]>(`${MEMORY_SELECT} WHERE id = ?`).get(entry.targetId)
            db.query("INSERT INTO memory_revision_bases VALUES (?, ?)").run(entry.memoryId, target ? sharedMemoryRevision(toMemory(target)) : "missing")
          }
        })()
      },
      update(memoryId: MemoryId, patch: { text?: string; category?: string; status?: MemoryStatus; pinned?: boolean; details?: MemoryEntry["details"] }) {
        const current = db.query<MemoryRow, [string]>(`${MEMORY_SELECT} WHERE id = ?`).get(memoryId)
        if (!current) return false
        const next = { text: patch.text ?? current.text, category: patch.category ?? current.category, status: patch.status ?? current.status, pinned: patch.pinned === undefined ? current.pinned : patch.pinned ? 1 : 0 }
        // Only a saved memory stays pinned: archiving it or returning it to review unpins it.
        if (next.status !== "saved") next.pinned = 0
        db.transaction(() => {
          db.query("UPDATE memories SET text = ?, category = ?, status = ?, pinned = ?, model_data = ?, updated_at = ? WHERE id = ?").run(next.text, next.category, next.status, next.pinned, patch.details ? JSON.stringify(patch.details) : current.model_data, now(), memoryId)
          db.query("UPDATE memories_fts SET text = ?, category = ? WHERE memory_id = ?").run(next.text, next.category, memoryId)
        })()
        return true
      },
      /**
       * Moves a memory to another place (scope, directory, session, profile) in one statement. Its id, text, status, pin
       * and links stay, so the graph around it is untouched. Returns false when the memory does not exist.
       */
      move(memoryId: MemoryId, place: { scope: MemoryEntry["scope"]; directory?: string | undefined; sessionId?: SessionId | undefined; profile?: string | undefined }) {
        const scoped = {
          directory: place.scope === "user" ? null : (place.directory ?? null),
          sessionId: place.scope === "session" ? (place.sessionId ?? null) : null,
          profile: place.scope === "user" ? (profileKey(place.profile) ?? "") : "",
        }
        return db.query("UPDATE memories SET scope = ?, directory = ?, session_id = ?, profile = ?, updated_at = ? WHERE id = ?").run(place.scope, scoped.directory, scoped.sessionId, scoped.profile, now(), memoryId).changes > 0
      },
      /**
       * Saved memories pinned in one place: a profile (user scope), a directory (project) or a session, not counting
       * `exceptId`. Pins are capped per place, so what is always injected stays bounded.
       */
      pinnedIn(place: { scope: MemoryEntry["scope"]; directory?: string | undefined; profile?: string | undefined; sessionId?: SessionId | undefined }, exceptId?: MemoryId): number {
        const where = place.scope === "user" ? "scope = 'user' AND profile = ?2" : place.scope === "project" ? "scope = 'project' AND directory = ?2" : "scope = 'session' AND session_id = ?2"
        const key = place.scope === "user" ? (profileKey(place.profile) ?? "") : place.scope === "project" ? (place.directory ?? null) : (place.sessionId ?? null)
        return db.query<{ n: number }, [string, string | null]>(`SELECT COUNT(*) AS n FROM memories WHERE ${where} AND status = 'saved' AND pinned = 1 AND id <> ?1`).get(exceptId ?? "", key)?.n ?? 0
      },
      delete(memoryId: MemoryId) {
        return db.transaction(() => {
          db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId)
          db.query("DELETE FROM memory_links WHERE from_id = ?1 OR to_id = ?1").run(memoryId)
          return db.query("DELETE FROM memories WHERE id = ?").run(memoryId).changes > 0
        })()
      },
      /** Links touching any of `memoryIds` (both ends must be among them). */
      links(memoryIds: readonly MemoryId[]): MemoryLink[] {
        if (!memoryIds.length) return []
        const wanted = new Set<string>(memoryIds)
        return db
          .query<{ from_id: string; to_id: string; kind: string; created_at: number }, []>("SELECT from_id, to_id, kind, created_at FROM memory_links ORDER BY created_at, from_id")
          .all()
          .filter((row) => wanted.has(row.from_id) && wanted.has(row.to_id))
          .map((row) => ({ from: row.from_id as MemoryId, to: row.to_id as MemoryId, kind: row.kind as MemoryLinkKind, createdAt: row.created_at }))
      },
      /**
       * Links two memories, replacing any link between them (either direction). Symmetric kinds are stored lowest id
       * first. Refused (undefined) for a self link, an unknown memory, or a memory already at MAX_MEMORY_LINKS.
       */
      link(input: { from: MemoryId; to: MemoryId; kind: MemoryLinkKind }): MemoryLink | undefined {
        if (input.from === input.to) return undefined
        const symmetric = input.kind === "related" || input.kind === "conflicts"
        const [from, to] = symmetric && input.to < input.from ? [input.to, input.from] : [input.from, input.to]
        return db.transaction(() => {
          const known = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM memories WHERE id IN (?, ?)").get(from, to)?.n ?? 0
          if (known < 2) return undefined
          db.query("DELETE FROM memory_links WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)").run(from, to)
          const degree = (id: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM memory_links WHERE from_id = ?1 OR to_id = ?1").get(id)?.n ?? 0
          if (degree(from) >= MAX_MEMORY_LINKS || degree(to) >= MAX_MEMORY_LINKS) return undefined
          const createdAt = now()
          db.query("INSERT INTO memory_links(from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)").run(from, to, input.kind, createdAt)
          return { from, to, kind: input.kind, createdAt }
        })()
      },
      unlink(a: MemoryId, b: MemoryId): boolean {
        return db.query("DELETE FROM memory_links WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)").run(a, b).changes > 0
      },
      /**
       * Accepts or rejects a pending Dream revision (kind update/archive) in one transaction. The proposal row is
       * always removed; accepting applies it to the target if that memory is still saved, otherwise nothing changes.
       */
      resolveRevision(memoryId: MemoryId, accept: boolean): { result: "not_a_revision" } | { result: "rejected" | "applied" | "stale"; targetId: MemoryId; kind: "update" | "archive" } {
        return db.transaction(() => {
          const proposal = db.query<MemoryRow, [string]>(`${MEMORY_SELECT} WHERE id = ?`).get(memoryId)
          if (!proposal || proposal.status !== "pending" || !proposal.target_id || (proposal.kind !== "update" && proposal.kind !== "archive")) return { result: "not_a_revision" as const }
          const targetId = proposal.target_id as MemoryId
          const kind = proposal.kind as "update" | "archive"
          const sharedRevision = memorySharing.revision(memoryId)
          const baseRevision = db.query<{ revision: string }, [string]>("SELECT revision FROM memory_revision_bases WHERE proposal_id = ?").get(memoryId)?.revision
          db.query("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId)
          db.query("DELETE FROM memories WHERE id = ?").run(memoryId)
          if (!accept) return { result: "rejected" as const, targetId, kind }
          const target = db.query<MemoryRow, [string]>(`${MEMORY_SELECT} WHERE id = ?`).get(targetId)
          if (!target || target.status !== "saved" || (sharedRevision && sharedMemoryRevision(toMemory(target)) !== sharedRevision) || (baseRevision && sharedMemoryRevision(toMemory(target)) !== baseRevision)) return { result: "stale" as const, targetId, kind }
          if (kind === "update") {
            db.query("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?").run(proposal.text, now(), targetId)
            db.query("UPDATE memories_fts SET text = ? WHERE memory_id = ?").run(proposal.text, targetId)
          } else db.query("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), targetId)
          return { result: "applied" as const, targetId, kind }
        })()
      },
      /** Ranked full-text search (every word must match) over saved memories visible from `directory`. */
      reindex() {
        return db.transaction(() => {
          db.query("DELETE FROM memories_fts").run()
          db.query("INSERT INTO memories_fts(memory_id, text, category) SELECT id, text, category FROM memories").run()
          return Number(db.query<{ count: number }, []>("SELECT count(*) AS count FROM memories").get()?.count ?? 0)
        })()
      },
      search(options: { query: string; directory?: string; limit?: number; profile?: string; session?: SessionId | "all" }): MemoryEntry[] {
        const match = ftsQuery(options.query)
        return match ? matchMemories(match, options).map((hit) => hit.memory) : []
      },
      /**
       * Saved memories visible from `directory` (and `session`) that match any distinctive word of `text`, best first,
       * with FTS5's bm25 `rank` (lower = better). What relevance retrieval starts from.
       */
      related(options: { text: string; directory?: string; limit?: number; profile?: string; session?: SessionId | "all" }): Array<{ memory: MemoryEntry; rank: number }> {
        const match = ftsAnyQuery(options.text)
        return match ? matchMemories(match, options) : []
      },
    },
    /**
     * Dream ledger: one row per run, no files (v1 accumulated ~150k run files, FC-29). Only the latest
     * DREAM_RUNS_KEPT rows per directory are kept.
     */
    dreamRuns: {
      start(directory: string, trigger?: DreamTrigger): DreamRun {
        const at = now()
        const id = Number(db.query("INSERT INTO dream_runs(directory, status, started_at, started_by) VALUES (?, 'running', ?, ?)").run(directory, at, trigger ?? null).lastInsertRowid)
        db.query("DELETE FROM dream_runs WHERE directory = ?1 AND id <= (SELECT id FROM dream_runs WHERE directory = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)").run(directory, DREAM_RUNS_KEPT)
        return { runId: id, directory, status: "running", ...(trigger ? { trigger } : {}), startedAt: at, proposed: 0 }
      },
      /** Closes a run; its safety report (already bounded by the protocol schema) is stored with it. */
      finish(runId: number, result: { status: "done" | "skipped" | "failed"; proposed?: number; notes?: string; error?: string; report?: DreamReport }): DreamRun | undefined {
        db.query("UPDATE dream_runs SET status = ?, ended_at = ?, proposed = ?, notes = ?, error = ?, report = ? WHERE id = ?").run(
          result.status,
          now(),
          result.proposed ?? 0,
          result.notes?.slice(0, 2_000) ?? null,
          result.error?.slice(0, 500) ?? null,
          result.report ? JSON.stringify(result.report) : null,
          runId,
        )
        return this.get(runId)
      },
      /** One run with its report. */
      get(runId: number): DreamRun | undefined {
        const row = db.query<DreamRunRow, [number]>("SELECT * FROM dream_runs WHERE id = ?").get(runId)
        return row ? toDreamRun(row, true) : undefined
      },
      /** The last 20 runs, newest first; only the newest DREAM_REPORTS_SHOWN carry their report (ask for one with `get`). */
      list(directory?: string): DreamRun[] {
        return db
          .query<DreamRunRow, [string | null]>("SELECT * FROM dream_runs WHERE ?1 IS NULL OR directory = ?1 ORDER BY id DESC LIMIT 20")
          .all(directory ?? null)
          .map((row, index) => toDreamRun(row, index < DREAM_REPORTS_SHOWN))
      },
    },
    /** Free-form small facts of the daemon (for example the last Dream window it handled). Values are short strings. */
    meta: {
      get(key: string): string | undefined {
        return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value
      },
      set(key: string, value: string) {
        db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value.slice(0, 500))
      },
    },
    limitCheckpoints: createLimitCheckpoints(db, codec),
    /**
     * Per-session digests Dream reads instead of transcripts. `get` returns one only while the session has not changed
     * since it was built (same `sourceSeq`) and its format is `version`; otherwise Dream builds it again and `put`s it.
     */
    digests: {
      get(sessionId: SessionId, input: { sourceSeq: number; version: number }): string | undefined {
        return db.query<{ payload: string }, [string, number, number]>("SELECT payload FROM session_digests WHERE session_id = ? AND source_seq = ? AND version = ?").get(sessionId, input.sourceSeq, input.version)?.payload
      },
      put(sessionId: SessionId, input: { sourceSeq: number; version: number; payload: string }) {
        if (input.payload.length > MAX_DIGEST_PAYLOAD) throw new RangeError(`[STORE]: digest of ${sessionId} is ${input.payload.length} characters; the limit is ${MAX_DIGEST_PAYLOAD}`)
        db.query("INSERT INTO session_digests(session_id, source_seq, version, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET source_seq = excluded.source_seq, version = excluded.version, payload = excluded.payload, updated_at = excluded.updated_at").run(
          sessionId,
          input.sourceSeq,
          input.version,
          input.payload,
          now(),
        )
      },
    },
    /**
     * Evolution's ledger. Evidence is one row per correction or preference seen in a session (its `fingerprint` tells the
     * same idea apart across sessions; `text` is kept only from suggest mode up). Kept 30 days, at most
     * EVOLUTION_EVIDENCE_KEPT rows per directory. Suggestions are skill/instruction proposals awaiting the user.
     */
    evolution: {
      policyRevision(): string {
        return db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'evolution-policy-revision'").get()?.value ?? "legacy"
      },
      record(entries: Array<{ directory: string; sessionId: string; source: "correction" | "preference"; fingerprint: string; text?: string }>) {
        const at = now()
        db.transaction(() => {
          const insert = db.query("INSERT INTO evolution_evidence(id, directory, session_id, source, fingerprint, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = COALESCE(excluded.text, evolution_evidence.text)")
          for (const entry of entries) insert.run(`${entry.sessionId}:${entry.source}:${entry.fingerprint}`, entry.directory, entry.sessionId, entry.source, entry.fingerprint, entry.text ?? null, at)
          const directories = new Set(entries.map((entry) => entry.directory))
          db.query("DELETE FROM evolution_evidence WHERE created_at < ?").run(at - EVOLUTION_EVIDENCE_DAYS * DAY_MS)
          for (const directory of directories)
            db.query("DELETE FROM evolution_evidence WHERE directory = ?1 AND id NOT IN (SELECT id FROM evolution_evidence WHERE directory = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)").run(directory, EVOLUTION_EVIDENCE_KEPT)
        })()
      },
      /** Ideas seen in at least two different sessions of `directory`, most recurrent first. `text` is the newest wording kept (absent in observe mode). */
      recurring(directory: string, limit = 20): Array<{ fingerprint: string; source: "correction" | "preference"; sessions: number; text?: string; evidenceId: string }> {
        return db
          .query<{ fingerprint: string; source: string; sessions: number; text: string | null; id: string }, [string, number]>(
            `SELECT fingerprint, source, COUNT(DISTINCT session_id) AS sessions, (SELECT e2.text FROM evolution_evidence e2 WHERE e2.directory = e.directory AND e2.fingerprint = e.fingerprint AND e2.text IS NOT NULL ORDER BY e2.created_at DESC LIMIT 1) AS text, MAX(id) AS id
             FROM evolution_evidence e WHERE directory = ?1 AND fingerprint <> '' GROUP BY fingerprint HAVING sessions >= 2 ORDER BY sessions DESC, MAX(created_at) DESC LIMIT ?2`,
          )
          .all(directory, limit)
          .map((row) => ({ fingerprint: row.fingerprint, source: row.source === "preference" ? "preference" : "correction", sessions: row.sessions, evidenceId: row.id, ...(row.text ? { text: row.text } : {}) }))
      },
      /** What Evolution has seen in `directory`: distinct ideas per source and how many recur across sessions. */
      observed(directory: string): { corrections: number; preferences: number; recurring: number } {
        const count = (source: string) => db.query<{ n: number }, [string, string]>("SELECT COUNT(DISTINCT fingerprint) AS n FROM evolution_evidence WHERE directory = ? AND source = ?").get(directory, source)?.n ?? 0
        const recurring = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM (SELECT fingerprint FROM evolution_evidence WHERE directory = ? AND fingerprint <> '' GROUP BY fingerprint HAVING COUNT(DISTINCT session_id) >= 2)").get(directory)?.n ?? 0
        return { corrections: count("correction"), preferences: count("preference"), recurring }
      },
      /** Adds a pending suggestion unless a pending or accepted one of the same kind and name exists; false when it was not added or pending ones are full. */
      suggest(input: { directory: string; kind: "skill" | "instruction" | "workflow"; name: string; description: string; content: string; evidence: number; runId?: number; policyRevision?: string }): EvolutionSuggestion | undefined {
        return db.transaction(() => {
          const same = db.query("SELECT 1 FROM evolution_suggestions WHERE directory = ? AND kind = ? AND name = ? AND status NOT IN ('rejected', 'rolled_back')").get(input.directory, input.kind, input.name)
          const pending = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM evolution_suggestions WHERE directory = ? AND status = 'pending'").get(input.directory)?.n ?? 0
          const total = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM evolution_suggestions WHERE directory = ?").get(input.directory)?.n ?? 0
          if (same || pending >= EVOLUTION_PENDING_MAX || total >= 200) return undefined
          const id = Number(
            db
              .query("INSERT INTO evolution_suggestions(directory, kind, name, description, content, evidence, status, created_at, run_id, policy_revision) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
              .run(input.directory, input.kind, input.name, input.description, input.content, input.evidence, now(), input.runId ?? null, input.policyRevision ?? this.policyRevision()).lastInsertRowid,
          )
          return this.suggestion(id)
        })()
      },
      suggestion(suggestionId: number): EvolutionSuggestion | undefined {
        const row = db.query<EvolutionSuggestionRow, [number]>("SELECT * FROM evolution_suggestions WHERE id = ?").get(suggestionId)
        return row ? toSuggestion(row) : undefined
      },
      /** Newest first, at most 50. */
      suggestions(directory: string, status?: EvolutionSuggestion["status"]): EvolutionSuggestion[] {
        return db
          .query<EvolutionSuggestionRow, [string, string | null]>("SELECT * FROM evolution_suggestions WHERE directory = ?1 AND (?2 IS NULL OR status = ?2) ORDER BY id DESC LIMIT 50")
          .all(directory, status ?? null)
          .map(toSuggestion)
      },
      resolve(suggestionId: number, status: "accepted" | "rejected"): EvolutionSuggestion | undefined {
        db.query("UPDATE evolution_suggestions SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), suggestionId)
        return this.suggestion(suggestionId)
      },
      promotion(suggestionId: number, status: "accepted" | "blocked" | "rolled_back", receipt: EvolutionReceipt): EvolutionSuggestion | undefined {
        const valid = EvolutionReceipt.parse(receipt)
        db.query("UPDATE evolution_suggestions SET status = ?, receipt = ?, resolved_at = ? WHERE id = ?").run(status, JSON.stringify(valid), now(), suggestionId)
        return this.suggestion(suggestionId)
      },
    },
    /** Loop records (bounded: 20 runs of history each). Invalid rows are skipped, never fatal. */
    loops: {
      all(): Loop[] {
        return db
          .query<{ payload: string }, []>("SELECT payload FROM loops ORDER BY updated_at DESC")
          .all()
          .flatMap((row) => {
            const parsed = Loop.safeParse(JSON.parse(row.payload))
            return parsed.success ? [parsed.data] : []
          })
      },
      save(loop: Loop) {
        db.transaction(() => {
          const previous = db.query<{ payload: string }, [string]>("SELECT payload FROM loops WHERE id = ?").get(loop.loopId)
          automationLedger.loop(loop, previous ? JSON.parse(previous.payload) as Loop : undefined)
          db.query("INSERT INTO loops(id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").run(
            loop.loopId,
            JSON.stringify(loop),
            loop.updatedAt,
          )
        })()
      },
      remove(loopId: string) {
        db.transaction(() => {
          db.query("DELETE FROM loops WHERE id = ?").run(loopId)
          automationLedger.remove("loop", loopId)
        })()
      },
    },
    /**
     * Workflow runs: one bounded JSON row each (at most MAX_WORKFLOW_RUN_BYTES) and at most MAX_FINISHED_WORKFLOWS finished
     * ones. `state` is a copy for the liveness index; readers use the payload. Invalid rows are skipped, never fatal.
     */
    workflowDefinitions: createWorkflowDefinitionRecords(db),
    /** Script workflows' event-sourced journal (calls, specs, results, memo and timer values), per run. */
    workflowJournal,
    workflows: {
      all(): WorkflowRun[] {
        return db
          .query<{ payload: string }, []>("SELECT payload FROM workflows ORDER BY updated_at DESC, id DESC")
          .all()
          .flatMap((row) => {
            const parsed = WorkflowRun.safeParse(JSON.parse(row.payload))
            return parsed.success ? [parsed.data] : []
          })
      },
      /** Throws a RangeError for a run over the size bound. A finished run evicts the oldest finished ones beyond the cap, never itself. */
      save(run: WorkflowRun) {
        const payload = JSON.stringify(run)
        const bytes = Buffer.byteLength(payload)
        if (bytes > MAX_WORKFLOW_RUN_BYTES) throw new RangeError(`[STORE]: workflow ${run.workflowId} is ${bytes} bytes; the limit is ${MAX_WORKFLOW_RUN_BYTES}`)
        db.transaction(() => {
          const previous = db.query<{ payload: string }, [string]>("SELECT payload FROM workflows WHERE id = ?").get(run.workflowId)
          automationLedger.workflow(run, previous ? JSON.parse(previous.payload) as WorkflowRun : undefined)
          db.query("INSERT INTO workflows(id, directory, state, payload, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET directory = excluded.directory, state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at").run(
            run.workflowId,
            run.directory,
            run.state,
            payload,
            run.updatedAt,
          )
          if (!(FINISHED_WORKFLOW_STATES as readonly string[]).includes(run.state)) return
          db.query(
            `DELETE FROM workflows WHERE id IN (SELECT id FROM workflows WHERE state IN (${FINISHED_WORKFLOW_SQL}) AND id <> ? ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?)`,
          ).run(run.workflowId, MAX_FINISHED_WORKFLOWS - 1)
          automationLedger.cleanWorkflows()
          workflowJournal.removeOrphans()
        })()
      },
      remove(workflowId: string) {
        db.transaction(() => {
          db.query("DELETE FROM workflows WHERE id = ?").run(workflowId)
          workflowJournal.removeRun(workflowId)
          automationLedger.remove("workflow", workflowId)
        })()
      },
      /** Whether any run is not finished: one indexed lookup, so a daemon with no live workflow never loads the service (P6). */
      hasLive(): boolean {
        return db.query(`SELECT 1 FROM workflows WHERE state NOT IN (${FINISHED_WORKFLOW_SQL}) LIMIT 1`).get() !== null
      },
    },
    agentCommands,
    sessionBackground,
    detached: parity.detached,
    tasks: parity.tasks,
    continuity,
    extraction: parity.extraction,
    recall,
    /** How a session spent its time and tokens: turns, days, hours, models, tools, sub-agents, approvals. */
    sessionStats,
    /** A bounded search over the messages of sessions. */
    sessionSearch,
    settings: {
      /** Stored settings; entries that no longer validate are dropped rather than failing startup. */
      get(): Settings {
        const row = db.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id = 1").get()
        const raw = row ? JSON.parse(row.payload) as Record<string, unknown> : {}
        const clean: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(raw)) {
          const kept = savedSetting(key, value)
          if (Settings.safeParse({ [key]: kept }).success) clean[key] = kept
        }
        const acpAgents = acpSettings.get()
        delete clean.acpAgents
        if (Object.keys(acpAgents).length) clean.acpAgents = acpAgents
        return clean as Settings
      },
      /** Saved entries `get` leaves out because they no longer validate (or are unknown): one line each, with the first reason and never the value. */
      invalid(): string[] {
        const row = db.query<{ payload: string }, []>("SELECT payload FROM settings WHERE id = 1").get()
        let raw: Record<string, unknown> = {}
        try { raw = row ? JSON.parse(row.payload) as Record<string, unknown> : {} } catch { return ["saved settings are not valid JSON"] }
        const lines: string[] = []
        for (const [key, value] of Object.entries(raw)) {
          if (key === "features" && value && typeof value === "object" && !Array.isArray(value)) {
            for (const id of ["opencode", "cursor"]) if (Object.hasOwn(value, id)) lines.push(`unknown feature ${id}: ignored`)
          }
          const checked = Settings.safeParse({ [key]: savedSetting(key, value) })
          if (checked.success) continue
          const issue = checked.error.issues[0]
          const unknown = issue?.code === "unrecognized_keys"
          lines.push(unknown ? `unknown setting ${key.slice(0, 60)}: ignored` : `setting ${key.slice(0, 60)}: ${issue?.path.slice(1).join(".") ? `${issue.path.slice(1).join(".")} ` : ""}${(issue?.message ?? "invalid").slice(0, 120)}; ignored`)
        }
        return lines
      },
      /** What `set` would save for `patch`, validated the same way, without writing anything. Throws a ZodError when the result is invalid. */
      check(patch: Record<string, unknown>): Settings {
        return mergedSettings(this.get(), patch).valid
      },
      /** Merges a patch; `null` removes a key. Throws a ZodError when the result is invalid. */
      set(patch: Record<string, unknown>): Settings {
        const current = this.get()
        const { valid, saveAcp } = mergedSettings(current, patch)
        saveAcp?.()
        db.transaction(() => {
          db.query("INSERT INTO settings(id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload").run(JSON.stringify(valid))
          if ((current.evolution ?? "off") !== (valid.evolution ?? "off") || (current.evolutionWorkflows ?? false) !== (valid.evolutionWorkflows ?? false)) {
            db.query("INSERT INTO meta(key, value) VALUES ('evolution-policy-revision', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(randomUUID())
          }
        })()
        return this.get()
      },
    },
    /** Recent distinct prompts for a directory, newest first. */
    promptHistory(directory: string, limit = 100): string[] {
      return promptHistory.list(directory, limit).map((entry) => entry.text)
    },
    /** The same list with each entry's id and kind (sent, command, shell, draft). */
    promptEntries: promptHistory.list,
    /** Adds an entry typed on a client (a slash command, a discarded draft); the kind that was kept, or undefined when nothing was stored. */
    recordPrompt(sessionId: SessionId, text: string, kind: PromptKind): PromptKind | undefined {
      return promptHistory.record(sessionId, text, now(), kind)
    },
    removePrompt: promptHistory.remove,
    clearPromptDrafts: promptHistory.clearDrafts,
    permissionModeOf(sessionId: SessionId): PermissionMode {
      const mode = db.query<{ permission_mode: string }, [string]>("SELECT permission_mode FROM sessions WHERE id = ?").get(sessionId)?.permission_mode
      return mode === "edits" || mode === "full" || mode === "smart" || mode === "plan" ? mode : "ask"
    },
    /**
     * A fork: `to` starts from the engine conversation of `from` (every engine's stored history, shared by reference
     * until either side rewrites it) and gets the blob references of `from`, so the fork keeps its images after the
     * original is deleted. Returns the messages it starts with.
     */
    copyConversation(from: SessionId, to: SessionId) {
      return db.transaction(() => {
        let copied = 0
        for (const engine of engineHistory.engines(from)) copied += engineHistory.share(from, to, engine, engineHistory.count(from, engine))
        db.query("INSERT OR IGNORE INTO blob_refs(sha256, session_id) SELECT sha256, ? FROM blob_refs WHERE session_id = ?").run(to, from)
        // The copied history holds the same ‹secret:N› markers, so they must resolve in the fork too.
        secrets.copy(from, to)
        return copied
      })()
    },
    /**
     * A fork at a message: like `copyConversation`, but the new session gets the transcript and the model history only up
     * to the end of `throughTurnId`. Transcript events of turns before it are shared (renumbered from the new session's
     * `session.created`), except turns that are undone; queue, usage, permission and foreground events stay behind. The
     * engine history is cut per engine at `cuts` (the caller checked every engine that holds messages has one).
     * Returns how many model messages and transcript events came along.
     */
    forkConversation(from: SessionId, to: SessionId, options: { throughTurnId: string; cuts: Record<string, number>; beforeSeq?: number }) {
      return db.transaction(() => {
        let messages = 0
        for (const engine of engineHistory.engines(from)) {
          const cut = options.cuts[engine]
          if (cut === undefined) throw new RangeError(`[STORE]: no cut for the ${engine} history`)
          messages += engineHistory.share(from, to, engine, cut)
        }
        db.query("INSERT OR IGNORE INTO blob_refs(sha256, session_id) SELECT sha256, ? FROM blob_refs WHERE session_id = ?").run(to, from)
        secrets.copy(from, to)
        const all = turns.list(from)
        const through = all.findIndex((turn) => turn.turnId === options.throughTurnId)
        if (through < 0) throw new RangeError(`[STORE]: unknown turn ${options.throughTurnId}`)
        const lastSeq = q.lastSeq.get(from)?.last_seq ?? 0
        let offset = q.lastSeq.get(to)?.last_seq ?? 0
        let events = 0
        const selectCopied = db.query<{ seq: number; payload: string; source_id: string; source_seq: number }, [string, number, number]>(
          `SELECT seq, payload, source_id, source_seq FROM events_read e WHERE session_id = ?1 AND seq >= ?2 AND seq < ?3 AND type IN (${COPIED_EVENT_TYPES})
           AND NOT (type = 'item.delta' AND EXISTS (SELECT 1 FROM events_read c WHERE c.session_id = ?1 AND c.type = 'item.completed' AND c.seq < ?3
             AND json_extract(c.payload, '$.itemId') = json_extract(e.payload, '$.itemId') AND json_extract(c.payload, '$.text') IS NOT NULL AND json_extract(c.payload, '$.blob') IS NULL))
           ORDER BY seq`,
        )
        const shareEvent = db.query("INSERT INTO transcript_prefix VALUES (?, ?, ?, ?)")
        const shareTurn = db.query("INSERT INTO turn_prefix SELECT ?, turn_id, ?, source_id FROM turns_read WHERE session_id = ? AND turn_id = ?")
        for (let i = 0; i <= through; i++) {
          const turn = all[i]!
          if (turn.reverted) continue
          const end = i === through && options.beforeSeq !== undefined ? options.beforeSeq : all[i + 1]?.seq ?? lastSeq + 1
          const rows = selectCopied.all(from, turn.seq, end)
          shareTurn.run(to, offset + 1, from, turn.turnId)
          for (const row of rows) {
            const event = JSON.parse(row.payload) as { zref?: string }
            if (event.zref) eventObjects.refer(event.zref, to)
            shareEvent.run(to, ++offset, row.source_id, row.source_seq)
          }
          events += rows.length
        }
        q.setSeq.run(offset, now(), to)
        // Revisions can be appended long after their turn. Carry the latest snapshot of each copied item.
        const revisions = db.query<{ payload: string }, [string, string]>("SELECT r.payload FROM message_revisions r WHERE r.session_id = ?1 AND EXISTS (SELECT 1 FROM events_read e WHERE e.session_id = ?2 AND e.type = 'item.started' AND json_extract(e.payload, '$.itemId') = r.item_id)").all(from, to)
        for (const row of revisions) {
          const revision = JSON.parse(row.payload) as import("@mendcode/protocol").MessageRevision
          const { seq, at, ...draft } = revision
          appendSession({ ...draft, sessionId: to })
          events++
        }
        if (options.beforeSeq !== undefined) {
          const open = db.query<{ itemId: ItemId }, [string]>("SELECT json_extract(payload, '$.itemId') AS itemId FROM events_read AS start WHERE session_id = ? AND type = 'item.started' AND NOT EXISTS (SELECT 1 FROM events_read AS finish WHERE finish.session_id = start.session_id AND finish.type = 'item.completed' AND json_extract(finish.payload, '$.itemId') = json_extract(start.payload, '$.itemId'))").all(to)
          for (const { itemId } of open) appendSession({ type: "item.completed", sessionId: to, itemId, status: "interrupted" })
          appendSession({ type: "turn.completed", sessionId: to, turnId: options.throughTurnId as TurnId })
          events += open.length + 1
        }
        return { messages, events }
      })()
    },
    /**
     * Undo at the store level, atomically: takes the model messages from `cuts[engine]` on out of every engine's history
     * (kept for redo), and appends a `turn.reverted` for each turn. Returns the appended events (the caller publishes
     * them) and how many messages left.
     */
    rewindTurns(input: { sessionId: SessionId; turnIds: string[]; cuts: Record<string, number>; byClientId?: ClientId }) {
      return db.transaction(() => {
        const messages = turns.undo.push(input.sessionId, input.turnIds, input.cuts)
        const events = input.turnIds.map((turnId) => appendSession({ type: "turn.reverted", sessionId: input.sessionId, turnId: turnId as TurnId, ...(input.byClientId ? { byClientId: input.byClientId } : {}) }))
        return { events, messages }
      })()
    },
    /** Records a part-level revert (files only, no turn leaves the transcript) so redo can bring its files back. */
    rewindPartial(input: { sessionId: SessionId; partial: PartialRevert }) {
      return db.transaction(() => turns.undo.push(input.sessionId, [], {}, input.partial))()
    },
    /** Redo at the store level: the top undo entry's messages go back and each of its turns gets a `turn.restored`. Undefined when nothing was undone (or a turn started since). */
    restoreTurns(input: { sessionId: SessionId; byClientId?: ClientId }) {
      return db.transaction(() => {
        const top = turns.undo.top(input.sessionId)
        if (!top) return undefined
        const messages = turns.undo.pop(input.sessionId, top.n)
        const events = top.turnIds.map((turnId) => appendSession({ type: "turn.restored", sessionId: input.sessionId, turnId: turnId as TurnId, ...(input.byClientId ? { byClientId: input.byClientId } : {}) }))
        return { events, messages, turnIds: top.turnIds }
      })()
    },
    /** Per-turn projection (timeline, undo targets, fork points), snapshots of the files a turn changed and the undo stack. */
    turns: {
      list: turns.list,
      covering: turns.covering,
      get: turns.get,
      byItem: turns.byItem,
      setHistory: turns.setHistory,
      messageCounts: turns.messageCounts,
      undoTop: turns.undo.top,
      undoDepth: turns.undo.depth,
      files: turns.files,
      calls: turns.calls,
      snapshots: turns.snapshots,
    },
    /** Title, directory, last activity and parent of one session; undefined when it does not exist. */
    sessionInfo(sessionId: SessionId) {
      return db
        .query<{ title: string; directory: string; updatedAt: number; parentId: string | null; archivedAt: number | null }, [string]>("SELECT title, directory, updated_at AS updatedAt, parent_id AS parentId, archived_at AS archivedAt FROM sessions WHERE id = ?")
        .get(sessionId) ?? undefined
    },
    sessionDirectory(sessionId: SessionId) {
      return db.query<{ directory: string }, [string]>("SELECT directory FROM sessions WHERE id = ?").get(sessionId)?.directory
    },
    sessionChildren(sessionId: SessionId): SessionId[] {
      return db.query<{ id: SessionId }, [string]>("SELECT id FROM sessions WHERE parent_id = ? ORDER BY updated_at DESC").all(sessionId).map((row) => row.id)
    },
    itemStart(sessionId: SessionId, itemId: string): Extract<SessionEvent, { type: "item.started" }> | undefined {
      const row = db.query<{ payload: string }, [string, string]>("SELECT payload FROM events_read WHERE session_id = ? AND type = 'item.started' AND json_extract(payload, '$.itemId') = ? ORDER BY seq LIMIT 1").get(sessionId, itemId)
      return row ? JSON.parse(row.payload) : undefined
    },
    /** The assistant message items that started in event numbers `fromSeq` up to (not including) `toSeq`, oldest first. */
    agentMessageIds(sessionId: SessionId, fromSeq: number, toSeq?: number): string[] {
      return db
        .query<{ itemId: string }, [string, number, number]>("SELECT json_extract(payload, '$.itemId') AS itemId FROM events_read WHERE session_id = ? AND type = 'item.started' AND json_extract(payload, '$.kind') = 'agent_message' AND seq >= ? AND seq < ? ORDER BY seq")
        .all(sessionId, fromSeq, toSeq ?? Number.MAX_SAFE_INTEGER)
        .map((row) => row.itemId)
    },
    lastTurnStatus(sessionId: SessionId) {
      return db.query<{ status: string }, [string]>("SELECT status FROM turns_read WHERE session_id = ? AND reverted = 0 ORDER BY seq DESC LIMIT 1").get(sessionId)?.status
    },
    pendingRequestsOf(sessionId: SessionId): Array<Extract<SessionEvent, { type: "server.request" }>> {
      return db.query<{ payload: string }, [string]>(`SELECT e.payload FROM events e WHERE e.session_id = ?1 AND e.type = 'server.request'
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.session_id = e.session_id AND r.seq > e.seq AND ((r.type IN ('turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted') AND COALESCE(json_extract(e.payload, '$.async'), 0) = 0) OR (r.type = 'server.request.resolved' AND json_extract(r.payload, '$.requestId') = json_extract(e.payload, '$.requestId')))) ORDER BY e.seq DESC LIMIT 100`).all(sessionId).map((row) => JSON.parse(row.payload))
    },
    sessionSummary(sessionId: SessionId) {
      const row = db.query<SessionRow, [string]>("SELECT id, title, directory, created_at, updated_at, last_seq, parent_id, archived_at FROM sessions WHERE id = ?").get(sessionId)
      return row ? { sessionId: row.id, title: row.title, directory: row.directory, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at, lastSeq: row.last_seq, queued: q.queuedCount.get(row.id)?.n ?? 0, ...(row.parent_id ? { parentId: row.parent_id as SessionId } : {}), ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}) } : undefined
    },
    listSessions(options: { limit?: number | undefined; offset?: number | undefined; directory?: string | undefined; roots?: boolean | undefined; since?: number | undefined; search?: string | undefined; agent?: string | undefined; model?: string | undefined; archived?: boolean | undefined; hideEmpty?: boolean | undefined } = {}) {
      const limit = Math.min(options.limit ?? 100, 500)
      const where: string[] = []
      const values: Array<string | number> = []
      if (options.hideEmpty) {
        const empty = emptySessions.condition("sessions")
        where.push(`NOT (${empty.sql})`)
        values.push(...empty.params)
      }
      if (!options.archived) where.push("archived_at IS NULL")
      if (options.roots !== false) where.push("parent_id IS NULL")
      if (options.directory) { where.push("directory = ?"); values.push(options.directory) }
      if (options.since !== undefined) { where.push("MAX(updated_at, created_at) >= ?"); values.push(options.since) }
      if (options.search !== undefined) { where.push("instr(lower(title), lower(?)) > 0"); values.push(options.search) }
      if (options.agent !== undefined) { where.push("COALESCE(agent, CASE WHEN permission_mode = 'plan' THEN 'plan' ELSE 'build' END) = ?"); values.push(options.agent) }
      if (options.model !== undefined) { where.push("substr(model, 1, length(?)) = ?"); values.push(options.model, options.model) }
      const rows = db.query<SessionRow, Array<string | number>>(`SELECT id, title, directory, created_at, updated_at, last_seq, parent_id, archived_at FROM sessions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, options.offset ?? 0)
      return rows.map((row) => ({
        sessionId: row.id,
        title: row.title,
        directory: row.directory,
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        lastSeq: row.last_seq,
        queued: q.queuedCount.get(row.id)?.n ?? 0,
        ...(row.parent_id ? { parentId: row.parent_id as SessionId } : {}),
        ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
      }))
    },
    sessionsWithActiveTurn() {
      return db
        .query<{ id: SessionId; active_turn: string }, []>("SELECT id, active_turn FROM sessions WHERE active_turn IS NOT NULL")
        .all()
        .map((row) => ({ sessionId: row.id, turnId: row.active_turn }))
    },
    /** Which external conversation (e.g. a Codex thread) backs a session, so restarts resume it. */
    engineBindings: {
      list(sessionId: SessionId): string[] {
        return db.query<{ engine: string }, [string]>("SELECT engine FROM engine_bindings WHERE session_id = ?").all(sessionId).map((row) => row.engine)
      },
      get(sessionId: SessionId, engine: string) {
        return (
          db
            .query<{ external_id: string }, [string, string]>("SELECT external_id FROM engine_bindings WHERE session_id = ? AND engine = ?")
            .get(sessionId, engine)?.external_id ?? undefined
        )
      },
      set(sessionId: SessionId, engine: string, externalId: string) {
        db.query("INSERT INTO engine_bindings(session_id, engine, external_id) VALUES (?, ?, ?) ON CONFLICT(session_id, engine) DO UPDATE SET external_id = excluded.external_id").run(sessionId, engine, externalId)
      },
    },
    /**
     * An engine's own conversation (native engine model history), append-only: saving writes only
     * messages past what is stored, so a long session costs one row per new message, not a rewrite.
     */
    engineMessages: {
      count(sessionId: SessionId, engine: string) { return engineHistory.count(sessionId, engine) },
      /** Bounded tail projection for offline recovery snapshots. */
      tail(sessionId: SessionId, engine: string, limit = 12): unknown[] {
        const from = Math.max(0, engineHistory.count(sessionId, engine) - Math.max(1, Math.min(24, limit)))
        return engineHistory.rows(sessionId, engine, from).map((row) => JSON.parse(codec.unpackText(row.payload)) as unknown)
      },
      load(sessionId: SessionId, engine: string): unknown[] {
        return engineHistory.rows(sessionId, engine).map((row) => JSON.parse(codec.unpackText(row.payload)) as unknown)
      },
      save(sessionId: SessionId, engine: string, messages: unknown[]) {
        db.transaction(() => {
          for (let i = engineHistory.count(sessionId, engine); i < messages.length; i++) engineHistory.insert(sessionId, engine, i, codec.packText(JSON.stringify(messages[i])))
        })()
      },
      /** The first stored message alone (after a compaction, the summary), without loading the whole history. */
      first(sessionId: SessionId, engine: string): unknown | undefined {
        const row = engineHistory.first(sessionId, engine)
        return row ? JSON.parse(codec.unpackText(row.payload)) as unknown : undefined
      },
      /** Atomic swap used by compaction: readers see the old history or the new one, never a mix. */
      replace(sessionId: SessionId, engine: string, messages: unknown[]) {
        db.transaction(() => {
          engineHistory.cut(sessionId, engine, 0)
          messages.forEach((message, i) => engineHistory.insert(sessionId, engine, i, codec.packText(JSON.stringify(message))))
          // The numbering changed: the counts older turns marked for this engine point nowhere now.
          turns.dropMarks(sessionId, engine)
        })()
      },
    },
    /** The persisted queue in order, for restoring an actor after a restart. */
    queueOf(sessionId: SessionId) {
      return db
        .query<{ queue_id: string; text: string; attachments: string; kind: string; authority_text: string | null }, [string]>(
          "SELECT queue_id, text, attachments, kind, authority_text FROM queue_items WHERE session_id = ? ORDER BY position, queue_id",
        )
        .all(sessionId)
        .map((row) => ({
          queueId: row.queue_id as QueueId,
          text: row.text,
          ...(row.authority_text !== null ? { authorityText: row.authority_text } : {}),
          attachments: JSON.parse(row.attachments) as BlobRef[],
          ...(row.kind === "compact" ? { compact: true as const } : {}),
          ...(row.kind === "notice" ? { notice: true as const } : {}),
          ...(row.kind === "shell" ? { shell: true as const } : {}),
          ...(() => {
            const payload = db.query<{ payload: string }, [string, string]>("SELECT payload FROM events WHERE session_id = ? AND type = 'queue.added' AND json_extract(payload, '$.queueId') = ? ORDER BY seq DESC LIMIT 1").get(sessionId, row.queue_id)?.payload
            const event = payload ? JSON.parse(payload) as Extract<SessionEvent, { type: "queue.added" }> : undefined
            return { ...(event?.selection ? { selection: event.selection } : {}), ...(event?.turnOptions ? { turnOptions: event.turnOptions } : {}),...(event?.displayText !== undefined ? { displayText: event.displayText } : {}), ...(event?.messageId ? { messageId: event.messageId } : {}), ...(row.kind === "compact" && event?.instructions ? { instructions: event.instructions } : {}), ...(row.kind === "shell" && event?.local ? { local: true as const } : {}) }
          })(),
        }))
    },
    lastSeq(sessionId: SessionId) {
      return q.lastSeq.get(sessionId)?.last_seq
    },
    /** Replay for reconnect: exactly the events after `afterSeq`, in order (I4). */
    readAfter(sessionId: SessionId, afterSeq: number, limit = 1000): SessionEvent[] {
      return q.readAfter.all(sessionId, afterSeq, limit).map((row) => parseEvent(row.payload, eventObjects.load))
    },
    /** Paging for clients that load the newest events first: the newest `limit` events, or the `limit` just older than `beforeSeq`, in ascending order. */
    readBefore(sessionId: SessionId, beforeSeq: number | undefined, limit: number): SessionEvent[] {
      const rows = beforeSeq === undefined ? q.readNewest.all(sessionId, limit) : q.readBefore.all(sessionId, beforeSeq, limit)
      return rows.reverse().map((row) => parseEvent(row.payload, eventObjects.load))
    },
    /** Context inspection reads only usage payloads: large tool outputs never enter this report. */
    recentUsage(sessionId: SessionId, limit: number): Extract<SessionEvent, { type: "usage.recorded" }>[] {
      return q.recentUsage.all(sessionId, Math.min(101, Math.max(1, limit))).reverse().map((row) => JSON.parse(row.payload))
    },
    putBlob(bytes: Uint8Array, mime: string) {
      return blobs.write(bytes, mime)
    },
    /** Registers a stored blob with a session (tool images kept in engine history) so blob cleaning keeps it while the session exists. */
    refBlob(ref: BlobRef, sessionId: SessionId) {
      q.insertBlob.run(ref.sha256, ref.bytes, ref.mime, Date.now())
      q.insertBlobRef.run(ref.sha256, sessionId)
    },
    blobPath: blobs.pathOf,
    readBlob: blobs.read,
    readStoredFile(file: string) {
      const hash = path.basename(file)
      if (/^[a-f0-9]{64}$/.test(hash) && path.resolve(file) === path.resolve(blobs.pathOf(hash))) return blobs.read(hash)
      return privateFiles.read(file)
    },
    writeStoredFile: privateFiles.write,
    environment,
    privacy: {
      enabled: () => privacyDatabase.enabled() && blobs.pending.size + privateFiles.pending.size === 0,
      status() {
        const pending = blobs.pending.size + privateFiles.pending.size
        const target = privacyDatabase.enabled()
        return { enabled: target && pending === 0, target, pending, unreadable: [...blobs.unreadable.keys(), ...privateFiles.unreadable.keys()] }
      },
      set(enabled: boolean) { beginConversion(enabled); privacyDatabase.set(enabled); convertFiles() },
    },
    /** A blob the session references (its events carry it): its size and type; undefined for any other hash. */
    sessionBlob(sessionId: SessionId, sha256: string): { bytes: number; mime: string } | undefined {
      return db.query<{ bytes: number; mime: string }, [string, string]>("SELECT b.bytes, b.mime FROM blobs b JOIN blob_refs r ON r.sha256 = b.sha256 WHERE b.sha256 = ? AND r.session_id = ? LIMIT 1").get(sha256, sessionId) ?? undefined
    },
    /** Complete, indexed read for a date range: no per-session caps, no history scan (FC-24). */
    usageDaily(range: { from: string; to: string }): UsageDay[] {
      return db
        .query<UsageDay, [string, string]>(`
          SELECT u.day AS day, SUM(input) AS input, SUM(output) AS output, SUM(reasoning) AS reasoning,
            SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(cost_micros) AS costMicros,
            SUM(cost_unknown_calls) AS costUnknownCalls, SUM(calls) AS calls,
            COALESCE(MAX(d.sessions), 0) AS sessions
          FROM usage_daily u
          LEFT JOIN usage_days d ON d.day = u.day
          WHERE u.day BETWEEN ? AND ?
          GROUP BY u.day ORDER BY u.day`)
        .all(range.from, range.to)
    },
    usageSessions(range: { from: string; to: string }) {
      return db
        .query<{ n: number }, [string, string]>("SELECT COUNT(DISTINCT session_id) AS n FROM usage_session_days WHERE day BETWEEN ? AND ?")
        .get(range.from, range.to)?.n ?? 0
    },
    /** Sparse per-day prompts, words, AI time and tool time (indexed range read). */
    usageActivity(range: { from: string; to: string }): UsageActivityDay[] {
      return db
        .query<Omit<UsageActivityDay, "longestAiMs"> & { longestAiMs: number | null }, [string, string]>("SELECT a.day, prompts, words, ai_ms AS aiMs, tool_ms AS toolMs, p.longest_ms AS longestAiMs FROM usage_activity a LEFT JOIN usage_response_peaks p ON p.day = a.day WHERE a.day BETWEEN ? AND ? ORDER BY a.day")
        .all(range.from, range.to)
        .map(({ longestAiMs, ...row }) => longestAiMs === null ? row : { ...row, longestAiMs })
    },
    /** Top tools by completed calls in the range. */
    usageTools(range: { from: string; to: string }, limit = 10): UsageTool[] {
      return db
        .query<UsageTool, [string, string, number]>(`
          SELECT tool, SUM(calls) AS calls, SUM(ms) AS ms, SUM(errors) AS errors
          FROM usage_tools WHERE day BETWEEN ? AND ? GROUP BY tool ORDER BY calls DESC, ms DESC, tool LIMIT ?`)
        .all(range.from, range.to, limit)
    },
    usageByModel(range: { from: string; to: string }) {
      return db
        .query<{ provider: string; model: string; input: number; output: number; calls: number; costMicros: number; costUnknownCalls: number }, [string, string]>(`
          SELECT provider, model, SUM(input) AS input, SUM(output) AS output, SUM(calls) AS calls, SUM(cost_micros) AS costMicros, SUM(cost_unknown_calls) AS costUnknownCalls
          FROM usage_daily WHERE day BETWEEN ? AND ? GROUP BY provider, model ORDER BY input + output DESC`)
        .all(range.from, range.to)
    },
    /** Lifetime, peak day, streaks and longest session (all time), with efforts, skills and top sessions for the range. */
    usageInsights: insights.read,
    usageScopes,
    /** Every model call and finished compaction in order, for the waste report. */
    usageCalls,
    usageWidgets: createUsageWidgets(db),
    /** Unsent prompts per session (survive a closed terminal). */
    drafts,
    /** Chats nobody typed in (see `empty-sessions.ts`): listed for reuse and removal, hidden from people's lists with `hideEmpty`. */
    emptySessions: {
      list: emptySessions.list,
      has: emptySessions.has,
      /** Marks a session an API client created on purpose: it is never reused, hidden or removed as an empty chat. */
      markExplicit(sessionId: SessionId) {
        db.query("INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(`${EXPLICIT_SESSION_KEY}${sessionId}`)
      },
    },
    /** Fork lineage, message labels and cached recaps (session-tree.ts); deleting a session deletes its labels and recap. */
    sessionTree,
    /** Engines that ran a session, a fork's branch point and merged contexts waiting for a turn (session-handoff.ts); they go with the session. */
    handoff,
    /** Session goals and their history (goals.ts); deleting a session deletes its goals. */
    goals,
    /** Turns paused by the provider's usage limit, so Resume at reset survives a restart (usage-pauses.ts). */
    usagePauses,
    /** Secrets pasted into sessions, encrypted at rest (secrets.ts). Deleting a session deletes its secrets. */
    secrets,
    latestQuota() {
      return db
        .query<{ payload: string }, []>("SELECT payload FROM quota_latest ORDER BY provider")
        .all()
        .map((row) => JSON.parse(row.payload) as Extract<GlobalEvent, { type: "quota.snapshot" }>)
    },
    /** Sets the picker title; false when the session does not exist. */
    renameSession(sessionId: SessionId, title: string) {
      return db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId).changes > 0
    },
    setSessionPinned(sessionId: SessionId, pinned: boolean) {
      return db.query("UPDATE sessions SET pinned_at = CASE WHEN ? THEN COALESCE(pinned_at, ?) ELSE NULL END WHERE id = ?").run(pinned ? 1 : 0, now(), sessionId).changes > 0
    },
    /** Bounded lifecycle/fan-out state. The generic daemon meta store only allows 500-character facts. */
    sessionData: {
      get(sessionId: SessionId, kind: "lifecycle" | "fanout"): string | undefined {
        const row = db.query<{ lifecycle: string | null; fanout: string | null }, [string]>("SELECT lifecycle, fanout FROM sessions WHERE id = ?").get(sessionId)
        return row?.[kind] ?? undefined
      },
      set(sessionId: SessionId, kind: "lifecycle" | "fanout", value: string) {
        if (Buffer.byteLength(value) > 32_000) throw new RangeError("Session metadata exceeds 32 KB")
        return db.query(kind === "lifecycle" ? "UPDATE sessions SET lifecycle = ? WHERE id = ?" : "UPDATE sessions SET fanout = ? WHERE id = ?").run(value, sessionId).changes > 0
      },
    },
    sessionPinnedAt(sessionId: SessionId) {
      return db.query<{ pinned_at: number | null }, [string]>("SELECT pinned_at FROM sessions WHERE id = ?").get(sessionId)?.pinned_at ?? undefined
    },
    /** Archive only changes visibility. Events, model history, drafts and bindings stay intact. */
    setSessionArchived(sessionId: SessionId, archived: boolean) {
      return db.query("UPDATE sessions SET archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END WHERE id = ?").run(archived ? 1 : 0, now(), sessionId).changes > 0
    },
    /** A session's own model (`/model`); undefined when it follows the settings. Values that no longer parse are ignored. */
    sessionModel(sessionId: SessionId): ModelChoice | undefined {
      const row = db.query<{ model: string | null; effort: string | null; model_options: string | null }, [string]>("SELECT model, effort, model_options FROM sessions WHERE id = ?").get(sessionId)
      if (!row?.model) return undefined
      try {
        const parsed = ModelChoice.safeParse({ ...(row.model_options ? JSON.parse(row.model_options) : {}), model: row.model, ...(row.effort ? { effort: row.effort } : {}) })
        return parsed.success ? parsed.data : undefined
      } catch { return undefined }
    },
    /** Sets or (with undefined) clears a session's own model. False when the session does not exist. */
    setSessionModel(sessionId: SessionId, choice: ModelChoice | undefined) {
      const options = choice ? { ...(choice.variant ? { variant: choice.variant } : {}), ...(choice.parameters ? { parameters: choice.parameters } : {}), ...(choice.fast !== undefined ? { fast: choice.fast } : {}) } : undefined
      return db.query("UPDATE sessions SET model = ?, effort = ?, model_options = ? WHERE id = ?").run(choice?.model ?? null, choice?.effort ?? null, options && Object.keys(options).length ? JSON.stringify(options) : null, sessionId).changes > 0
    },
    /** The custom primary agent a session runs as (`session.agent.set`); undefined = the default (`build`). */
    sessionAgent(sessionId: SessionId): string | undefined {
      return db.query<{ agent: string | null }, [string]>("SELECT agent FROM sessions WHERE id = ?").get(sessionId)?.agent || undefined
    },
    /** Sets or (with undefined) clears a session's agent. False when the session does not exist. */
    setSessionAgent(sessionId: SessionId, agent: string | undefined) {
      return db.query("UPDATE sessions SET agent = ? WHERE id = ?").run(agent ?? null, sessionId).changes > 0
    },
    /** Deletes a session's events and blob references. Usage history is kept (it is an aggregate). */
    deleteSession(sessionId: SessionId) {
      openItems.delete(sessionId)
      return db.transaction(() => {
        dropSessionMemories(sessionId)
        db.query("DELETE FROM evolution_evidence WHERE session_id = ?").run(sessionId)
        engineHistory.release(sessionId)
        transcript.release(sessionId)
        const shared = eventObjects.referencedBy(sessionId)
        const removed = db.query("DELETE FROM sessions WHERE id = ?").run(sessionId).changes > 0
        db.query("DELETE FROM meta WHERE key = ?").run(`${EXPLICIT_SESSION_KEY}${sessionId}`)
        eventObjects.drop(shared)
        return removed
      })()
    },
    /** Removes blobs no session references any more and returns the bytes freed. */
    collectBlobs() {
      const result = removeOrphanBlobs()
      turns.storage.sweep()
      eventObjects.sweep()
      db.run("PRAGMA incremental_vacuum")
      return result
    },
    /**
     * Where the disk goes. Aggregates only: one pass over events for per-session bytes (octet_length
     * reads the record header, not the payload), no per-row work in JS beyond the session count.
     */
    storageReport(): StorageReport {
      const one = <T>(sql: string) => db.query<T, []>(sql).get()
      const num = (sql: string) => Number(one<{ n: number | null }>(sql)?.n ?? 0)
      const dbBytes = fileSize(dbPath)
      const perSession = db
        .query<{ id: string; bytes: number }, []>("SELECT session_id AS id, SUM(octet_length(payload)) AS bytes FROM events GROUP BY session_id")
        .all()
      const eventBytes = perSession.reduce((sum, row) => sum + row.bytes, 0)
      const blobBytesBySession = new Map(
        db
          .query<{ id: string; bytes: number }, []>("SELECT r.session_id AS id, SUM(b.bytes) AS bytes FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256 GROUP BY r.session_id")
          .all()
          .map((row) => [row.id, row.bytes] as const),
      )
      const ranked = perSession
        .map((row) => ({ id: row.id, bytes: row.bytes + (blobBytesBySession.get(row.id) ?? 0) }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, TOP_SESSIONS)
      const info = db.query<{ title: string; directory: string; updated_at: number }, [string]>("SELECT title, directory, updated_at FROM sessions WHERE id = ?")
      const orphan = one<{ n: number; bytes: number | null }>(`SELECT COUNT(*) AS n, SUM(bytes) AS bytes FROM blobs WHERE sha256 NOT IN (SELECT sha256 FROM blob_refs) AND sha256 NOT IN (${draftBlobsSql})`)
      const strays = strayFiles()
      const objectives = goalFiles()
      const orphanObjectives = objectives.filter((file) => file.orphan)
      const engineBytes = num("SELECT SUM(octet_length(payload)) AS n FROM engine_messages")
      const forkExtras = () => {
        const sharedHistory = engineHistory.shared()
        const objects = eventObjects.stats()
        return {
          forkRefs: sharedHistory.forks,
          sharedMessages: sharedHistory.messages,
          sharedBytes: sharedHistory.bytes,
          eventObjects: objects.objects,
          eventObjectBytes: objects.objectBytes,
          eventObjectRefs: objects.refs,
        }
      }
      const mode = num1("PRAGMA auto_vacuum")
      const autoVacuum = mode === 2 ? "incremental" : mode === 1 ? "full" : "none"
      return {
        dbBytes,
        walBytes: fileSize(`${dbPath}-wal`),
        blobBytes: blobs.totalBytes(),
        blobs: num("SELECT COUNT(*) AS n FROM blobs"),
        orphanBlobs: (orphan?.n ?? 0) + strays.length,
        orphanBytes: Number(orphan?.bytes ?? 0) + strays.reduce((sum, file) => sum + file.bytes, 0),
        goalFiles: objectives.length,
        goalBytes: objectives.reduce((sum, file) => sum + file.bytes, 0),
        orphanGoalFiles: orphanObjectives.length,
        orphanGoalBytes: orphanObjectives.reduce((sum, file) => sum + file.bytes, 0),
        sessions: num("SELECT COUNT(*) AS n FROM sessions"),
        events: num("SELECT SUM(last_seq) AS n FROM sessions"),
        eventBytes,
        engineBytes,
        otherBytes: Math.max(0, dbBytes - eventBytes - engineBytes),
        freeBytes: num1("PRAGMA freelist_count") * num1("PRAGMA page_size"),
        autoVacuum,
        ...upkeep.extras(),
        ...forkExtras(),
        topSessions: ranked.flatMap((row) => {
          const found = info.get(row.id)
          return found ? [{ sessionId: row.id, title: found.title, directory: found.directory, updatedAt: found.updated_at, bytes: row.bytes }] : []
        }),
      }
    },
    /**
     * Retention: removes sessions idle for `olderThanDays` (0 = none) except those with an active turn,
     * a queued message, a draft saved since the cutoff, a live loop's root session, the sessions of an unfinished workflow or an id in `protect`; then orphan blobs; then
     * shrinks the files (incremental vacuum, WAL truncate, and a full VACUUM only when `vacuum`).
     * `dryRun` measures what would go and changes nothing.
     */
    cleanStorage(options: { olderThanDays: number; dryRun?: boolean; vacuum?: boolean; protect?: ReadonlySet<string>; strayGraceMs?: number }): StorageCleanResult & { sessionIds: string[] } {
      const dryRun = options.dryRun === true
      const cutoff = now() - options.olderThanDays * DAY_MS
      const live = new Set([...(options.protect ?? [])])
      for (const loop of this.loops.all()) if (!FINISHED_LOOP_STATES.has(loop.state)) live.add(loop.sessionId)
      for (const run of this.workflows.all()) if (!(FINISHED_WORKFLOW_STATES as readonly string[]).includes(run.state)) for (const sessionId of workflowSessionIds(run)) live.add(sessionId)
      const old = options.olderThanDays > 0
        ? db
            .query<{ id: string; last_seq: number; active: number; queued: number; drafted: number }, [number, number]>(
              // A draft saved since the cutoff is recent work in an old session (its events are older): the session stays.
              "SELECT id, last_seq, active_turn IS NOT NULL AS active, EXISTS(SELECT 1 FROM queue_items q WHERE q.session_id = s.id) AS queued, EXISTS(SELECT 1 FROM drafts d WHERE d.session_id = s.id AND d.updated_at >= ?) AS drafted FROM sessions s WHERE updated_at < ?",
            )
            .all(cutoff, cutoff)
        : []
      const eligible = old.filter((row) => !row.active && !row.queued && !row.drafted && !live.has(row.id))
      const ids = eligible.map((row) => row.id)
      const sizeOnDisk = () => fileSize(dbPath) + fileSize(`${dbPath}-wal`) + blobs.totalBytes() + goalFiles().reduce((sum, file) => sum + file.bytes, 0)
      const before = sizeOnDisk()
      const orphanObjectives = goalFiles(new Set(ids)).filter((file) => file.orphan)

      // The doomed set lives in a temp table so blob ownership can be decided in SQL.
      db.run("CREATE TEMP TABLE IF NOT EXISTS clean_ids(id TEXT PRIMARY KEY)")
      db.run("DELETE FROM clean_ids")
      const mark = db.query("INSERT OR IGNORE INTO clean_ids(id) VALUES (?)")
      for (const id of ids) mark.run(id)
      const sum = (sql: string) => Number(db.query<{ n: number | null }, []>(sql).get()?.n ?? 0)
      const eventsRemoved = eligible.reduce((total, row) => total + row.last_seq, 0)
      const freed = db
        .query<{ n: number; bytes: number | null }, []>(
          "SELECT COUNT(*) AS n, SUM(b.bytes) AS bytes FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.sha256 = b.sha256 AND r.session_id NOT IN (SELECT id FROM clean_ids))",
        )
        .get()
      const base = { dryRun, olderThanDays: options.olderThanDays, sessionsRemoved: ids.length, eventsRemoved, protectedSessions: old.length - eligible.length, goalFilesRemoved: orphanObjectives.length }
      if (dryRun) {
        const strays = strayFiles(options.strayGraceMs)
        const estimate = sum("SELECT SUM(octet_length(payload)) AS n FROM events WHERE session_id IN (SELECT id FROM clean_ids)") + sum("SELECT SUM(octet_length(payload)) AS n FROM engine_messages WHERE session_id IN (SELECT id FROM clean_ids)") + Number(freed?.bytes ?? 0) + strays.reduce((total, file) => total + file.bytes, 0) + orphanObjectives.reduce((total, file) => total + file.bytes, 0)
        db.run("DELETE FROM clean_ids")
        return { ...base, blobsRemoved: (freed?.n ?? 0) + strays.length, bytesReclaimed: estimate, vacuumed: false, sessionIds: ids }
      }
      db.run("DELETE FROM clean_ids")

      const remove = db.transaction((batch: string[]) => {
        const stmt = db.query("DELETE FROM sessions WHERE id = ?")
        for (const id of batch) {
          dropSessionMemories(id)
          db.query("DELETE FROM evolution_evidence WHERE session_id = ?").run(id)
          engineHistory.release(id)
          transcript.release(id)
          stmt.run(id)
          openItems.delete(id)
        }
      })
      for (let i = 0; i < ids.length; i += CLEAN_BATCH) remove(ids.slice(i, i + CLEAN_BATCH))
      // Global events are read back only as the newest gseq and the settings history: older quota snapshots, job states and the like
      // go with the same cutoff. The newest row stays, so the next gseq keeps counting up.
      if (options.olderThanDays > 0) db.query("DELETE FROM global_events WHERE at < ? AND type != 'settings.changed' AND gseq < (SELECT MAX(gseq) FROM global_events)").run(cutoff)
      for (const file of orphanObjectives) rmSync(file.file, { force: true })
      const orphans = removeOrphanBlobs(options.strayGraceMs)
      turns.storage.sweep()
      eventObjects.sweep()
      if (num1("PRAGMA auto_vacuum") === 2) db.run("PRAGMA incremental_vacuum")
      db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      if (options.vacuum) {
        db.run("VACUUM")
        db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      }
      return { ...base, blobsRemoved: orphans.removed, bytesReclaimed: Math.max(0, before - sizeOnDisk()), vacuumed: options.vacuum === true, sessionIds: ids }
    },
    /**
     * Moves data written before compression existed into the compact forms (model history, large tool results, file
     * snapshots) and, with `deltaIdleDays`, drops the streaming deltas of finished messages in sessions idle that long.
     * Never touches a session with an active turn or one in `protect`. Bytes are measured from the files, like cleaning.
     */
    compactStorage(options: { dryRun?: boolean; deltaIdleDays?: number; protect?: ReadonlySet<string>; rowLimit?: number; vacuum?: boolean }): CompactResult & { bytesReclaimed: number; vacuumed: boolean } {
      const sizeOnDisk = () => fileSize(dbPath) + fileSize(`${dbPath}-wal`)
      const before = sizeOnDisk()
      const result = upkeep.compact(options)
      if (options.dryRun) return { ...result, bytesReclaimed: 0, vacuumed: false }
      if (num1("PRAGMA auto_vacuum") === 2) db.run("PRAGMA incremental_vacuum")
      db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      if (options.vacuum) {
        db.run("VACUUM")
        db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      }
      return { ...result, bytesReclaimed: Math.max(0, before - sizeOnDisk()), vacuumed: options.vacuum === true }
    },
    close() {
      try { db.run("PRAGMA wal_checkpoint(TRUNCATE)") } finally { try { db.close() } finally { lock.release() } }
    },
  }
  } catch (error) {
    try { privateDb?.db.close() } finally { lock.release() }
    throw error
  }
}
export type Store = ReturnType<typeof openStore>
