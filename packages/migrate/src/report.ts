import type { ItemKind } from "@mendcode/protocol"
import { CREDENTIALS_REASON, MAX_REPORT_ERRORS, REPORT_SCHEMA } from "./settings"

export type TurnOutcomes = { completed: number; failed: number; cancelled: number; interrupted: number }
export type NotMigrated = { name: string; bytes: number; /** The walk hit its entry cap: `bytes` is a lower bound. */ approximate: boolean; reason: string }
export type ReportError = { id: string; message: string }

export type MigrationReport = {
  schema: typeof REPORT_SCHEMA
  dryRun: boolean
  from: string
  dir: string
  since?: string
  startedAt: string
  finishedAt: string
  durationMs: number
  sessions: {
    /** v1 sessions in scope (after `--since`). */
    seen: number
    imported: number
    /** Skipped: imported by an earlier run. */
    already: number
    /** Skipped: no messages. */
    empty: number
    failed: number
    /** Imported sessions that v1 had archived (kept). */
    archived: number
    /** Imported without a parent: the v1 parent was not imported. */
    orphaned: number
  }
  messages: number
  items: Record<ItemKind, number>
  turns: TurnOutcomes
  partsSkipped: Record<string, number>
  attachments: { count: number; decodedBytes: number; uniqueBytes: number; savedBytes: number; notAttached: number }
  /** Texts too long for an event, stored as blobs with a preview. */
  longTexts: number
  memories: { imported: number; already: number; duplicate: number; skippedHighSensitivity: number; invalid: number; truncated: number }
  engineContext: { sessions: number; messages: number }
  notMigrated: NotMigrated[]
  /** Credential files found in v1: listed by name only, never opened ("not migrated (credentials)"). */
  credentialsNotRead: string[]
  errors: ReportError[]
  /** Errors beyond the ones kept. */
  errorsDropped: number
  reportFile?: string
}

export const ITEM_KINDS: ItemKind[] = ["user_message", "agent_message", "reasoning", "tool_call", "approval", "artifact", "compaction"]

export function emptyItems(): Record<ItemKind, number> {
  return { user_message: 0, agent_message: 0, reasoning: 0, tool_call: 0, approval: 0, artifact: 0, compaction: 0 }
}

export function emptyReport({ from, dir, dryRun, since, startedAt }: { from: string; dir: string; dryRun: boolean; since?: number; startedAt: number }): MigrationReport {
  return {
    schema: REPORT_SCHEMA,
    dryRun,
    from,
    dir,
    ...(since !== undefined ? { since: new Date(since).toISOString().slice(0, 10) } : {}),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    sessions: { seen: 0, imported: 0, already: 0, empty: 0, failed: 0, archived: 0, orphaned: 0 },
    messages: 0,
    items: emptyItems(),
    turns: { completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
    partsSkipped: {},
    attachments: { count: 0, decodedBytes: 0, uniqueBytes: 0, savedBytes: 0, notAttached: 0 },
    longTexts: 0,
    memories: { imported: 0, already: 0, duplicate: 0, skippedHighSensitivity: 0, invalid: 0, truncated: 0 },
    engineContext: { sessions: 0, messages: 0 },
    notMigrated: [],
    credentialsNotRead: [],
    errors: [],
    errorsDropped: 0,
  }
}

export function addError(report: MigrationReport, error: ReportError) {
  if (report.errors.length < MAX_REPORT_ERRORS) report.errors.push(error)
  else report.errorsDropped++
}

/** What mapping one session counted; merged into the report only when the session commits. */
export type SessionStats = {
  messages: number
  items: Record<ItemKind, number>
  turns: TurnOutcomes
  partsSkipped: Record<string, number>
  /** One entry per attached file: its content hash and decoded size. */
  attachments: Array<{ sha256: string; bytes: number }>
  notAttached: number
  longTexts: number
}

export function emptySessionStats(): SessionStats {
  return { messages: 0, items: emptyItems(), turns: { completed: 0, failed: 0, cancelled: 0, interrupted: 0 }, partsSkipped: {}, attachments: [], notAttached: 0, longTexts: 0 }
}

export const skipPart = (stats: SessionStats, name: string) => void (stats.partsSkipped[name] = (stats.partsSkipped[name] ?? 0) + 1)

/** Folds one committed session into the report; `seenBlobs` spans the whole run so identical files count once. */
export function mergeSession(report: MigrationReport, stats: SessionStats, seenBlobs: Set<string>) {
  report.messages += stats.messages
  for (const kind of ITEM_KINDS) report.items[kind] += stats.items[kind]
  for (const outcome of Object.keys(report.turns) as Array<keyof TurnOutcomes>) report.turns[outcome] += stats.turns[outcome]
  for (const [name, count] of Object.entries(stats.partsSkipped)) report.partsSkipped[name] = (report.partsSkipped[name] ?? 0) + count
  for (const file of stats.attachments) {
    report.attachments.count++
    report.attachments.decodedBytes += file.bytes
    if (!seenBlobs.has(file.sha256)) {
      seenBlobs.add(file.sha256)
      report.attachments.uniqueBytes += file.bytes
    }
  }
  report.attachments.savedBytes = report.attachments.decodedBytes - report.attachments.uniqueBytes
  report.attachments.notAttached += stats.notAttached
  report.longTexts += stats.longTexts
}

const MB = 1024 * 1024
export const formatBytes = (bytes: number) => (bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(2)} GB` : bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`)
export const formatDuration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s` : `${(ms / 1000).toFixed(1)}s`
}

/** The human summary: about fifteen lines. */
export function summaryText(report: MigrationReport) {
  const { sessions, items, turns, attachments, memories, engineContext } = report
  const skipped = Object.entries(report.partsSkipped)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(", ")
  const lines = [
    `${report.dryRun ? "migrate-v1 dry run (nothing was written)" : "migrate-v1 done"} in ${formatDuration(report.durationMs)}: ${report.from} -> ${report.dir}`,
    `sessions: ${sessions.seen} seen, ${sessions.imported} ${report.dryRun ? "would be imported" : "imported"}, ${sessions.already} already imported, ${sessions.empty} empty, ${sessions.failed} failed (${sessions.archived} archived kept, ${sessions.orphaned} without parent)`,
    `messages: ${report.messages}; items: ${ITEM_KINDS.filter((kind) => items[kind] > 0).map((kind) => `${kind} ${items[kind]}`).join(", ") || "none"}`,
    `turns: ${turns.completed} completed, ${turns.failed} failed, ${turns.cancelled} cancelled, ${turns.interrupted} interrupted`,
    `parts not imported: ${skipped || "none"}`,
    `attachments: ${attachments.count} (${formatBytes(attachments.decodedBytes)} decoded, ${formatBytes(attachments.uniqueBytes)} stored after dedupe, ${formatBytes(attachments.savedBytes)} saved${attachments.notAttached ? `, ${attachments.notAttached} over the limit kept as text` : ""}); ${report.longTexts} long texts in blobs`,
    `memories: ${memories.imported} imported, ${memories.already} already, ${memories.duplicate} duplicate, ${memories.skippedHighSensitivity} skipped (high sensitivity), ${memories.invalid} invalid, ${memories.truncated} shortened`,
    `engine context: written for ${engineContext.sessions} sessions (${engineContext.messages} messages)`,
    `not migrated: ${report.notMigrated.map((entry) => `${entry.name} ${entry.approximate ? ">" : ""}${formatBytes(entry.bytes)}`).join(", ") || "none"}`,
    `credentials not read: ${report.credentialsNotRead.length ? `${report.credentialsNotRead.join(", ")} (${CREDENTIALS_REASON})` : "none"}`,
    `errors: ${report.errors.length + report.errorsDropped}`,
    ...report.errors.slice(0, 5).map((error) => `  ${error.id}: ${error.message}`),
    ...(report.errors.length > 5 ? [`  ... ${report.errors.length - 5 + report.errorsDropped} more in the report`] : []),
    ...(report.reportFile ? [`report: ${report.reportFile}`] : []),
  ]
  return `${lines.join("\n")}\n`
}
