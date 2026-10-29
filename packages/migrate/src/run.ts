import { mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionEvent, type SessionId } from "@mendcode/protocol"
import { MAX_EVENT_BYTES, openStore, type Store } from "@mendcode/store"
import { resolveTargets } from "./args"
import { createContextBuilder } from "./engine-context"
import { MigrateError } from "./errors"
import { derivedId } from "./ids"
import { credentialFilesPresent, measureLeftovers } from "./leftovers"
import { mapSession, type BlobPort, type SessionEventDraft } from "./map-session"
import { importMemories } from "./memories"
import { addError, emptyReport, emptySessionStats, formatDuration, mergeSession, type MigrationReport } from "./report"
import { ENGINE_KEY, MARKER_ENGINE, PROGRESS_EVERY, REPORT_DIR } from "./settings"
import { openV1, type V1Session } from "./v1-reader"

export type MigrateOptions = {
  from: string
  dir: string
  dryRun?: boolean
  /** Only sessions updated at or after this instant (ms since epoch). */
  since?: number
  /** Import the v1 memory files (default true). */
  memories?: boolean
  /** Where `~/.mendcode` and `~/.local/share/mendcode` are, for the refusal of a target inside them. */
  home?: string
  onProgress?: (line: string) => void
  now?: () => number
}

/** The store clock: the store stamps every event and row with `now()`, so the import sets it to the v1 instant first. */
type Clock = { at: number }

/** Content hash only: a dry run stores nothing but still counts attachments and dedupes them. */
const hashingBlobs: BlobPort = {
  put(bytes, mime) {
    return { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, mime }
  },
}

function openTarget(dir: string, clock: Clock) {
  try {
    return openStore({ dir, now: () => clock.at })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("owned by running process")) throw new MigrateError("target-locked", `stop MendCode first (a daemon is using ${dir})`)
    throw new MigrateError("target-open", `cannot open the MendCode store in ${dir}: ${message}`)
  }
}

type Parent = { kind: "none" } | { kind: "linked"; id: SessionId } | { kind: "later" } | { kind: "orphan" }

/** Reads legacy MendCode history from `from` (read only) and imports it into the MendCode data directory `dir`. */
export async function runMigration(options: MigrateOptions): Promise<MigrationReport> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const { from, dir } = resolveTargets({ from: options.from, dir: options.dir, home: options.home ?? os.homedir() })
  const dryRun = options.dryRun === true
  const progress = options.onProgress ?? (() => {})
  const report = emptyReport({ from, dir, dryRun, startedAt, ...(options.since !== undefined ? { since: options.since } : {}) })
  const clock: Clock = { at: startedAt }
  const reader = openV1(from)
  let store: Store | undefined
  try {
    store = dryRun ? undefined : openTarget(dir, clock)
    const total = reader.sessionCount(options.since)
    progress(`migrate-v1: ${total} sessions to read from ${from}${dryRun ? " (dry run)" : ` into ${dir}`}`)
    report.notMigrated = measureLeftovers(from)
    report.credentialsNotRead = credentialFilesPresent(from)

    const seenBlobs = new Set<string>()
    /** v1 ids imported during this run: how a dry run, which has no store to ask, knows a parent is done. */
    const importedNow = new Set<string>()
    let processed = 0

    const isDone = (session: V1Session) => (store ? store.engineBindings.get(derivedId("session", session.id, session.createdAt), MARKER_ENGINE) !== undefined : importedNow.has(session.id))

    function parentOf(session: V1Session, allowLater: boolean): Parent {
      if (!session.parentId) return { kind: "none" }
      const parent = reader.session(session.parentId)
      if (!parent) return { kind: "orphan" }
      if (isDone(parent)) return { kind: "linked", id: derivedId("session", parent.id, parent.createdAt) }
      const parentComesLater = parent.createdAt > session.createdAt || (parent.createdAt === session.createdAt && parent.id > session.id)
      return allowLater && parentComesLater ? { kind: "later" } : { kind: "orphan" }
    }

    function importSession(session: V1Session, allowLater: boolean): "done" | "later" {
      const sessionId = derivedId("session", session.id, session.createdAt)
      if (!reader.hasMessages(session.id)) {
        report.sessions.empty++
        return "done"
      }
      if (isDone(session)) {
        report.sessions.already++
        return "done"
      }
      const parent = parentOf(session, allowLater)
      if (parent.kind === "later") return "later"
      // A half-written session from an interrupted run has no completion marker: start it over.
      if (store?.hasSession(sessionId)) store.deleteSession(sessionId)
      const stats = emptySessionStats()
      const context = createContextBuilder()
      let seq = 0
      try {
        const steps = mapSession({
          session,
          sessionId,
          ...(parent.kind === "linked" ? { parentId: parent.id } : {}),
          source: { messages: reader.messages(session.id), partsOf: (messageId) => reader.parts(messageId) },
          blobs: store ? { put: (bytes, mime) => store!.putBlob(bytes, mime) } : hashingBlobs,
          stats,
          context,
        })
        for (const step of steps) {
          seq++
          if (store) append(store, clock, sessionId, step.at, step.draft)
          else validate(seq, step.at, step.draft)
        }
        const history = context.build()
        if (store) {
          if (history.length > 0) store.engineMessages.replace(sessionId, ENGINE_KEY, history)
          store.engineBindings.set(sessionId, MARKER_ENGINE, session.id)
        }
        mergeSession(report, stats, seenBlobs)
        report.sessions.imported++
        if (session.archived) report.sessions.archived++
        if (parent.kind === "orphan") report.sessions.orphaned++
        if (history.length > 0) {
          report.engineContext.sessions++
          report.engineContext.messages += history.length
        }
        importedNow.add(session.id)
      } catch (error) {
        if (store) {
          try {
            store.deleteSession(sessionId)
          } catch {}
        }
        report.sessions.failed++
        addError(report, { id: session.id, message: error instanceof Error ? error.message : String(error) })
      }
      return "done"
    }

    function tick() {
      processed++
      if (processed % PROGRESS_EVERY === 0) {
        // Decoded attachments are large short-lived buffers; a periodic full collection keeps the peak near one session.
        Bun.gc(true)
        const { imported, already, empty, failed } = report.sessions
        progress(`migrate-v1: ${processed}/${total} sessions (${imported} imported, ${already} already, ${empty} empty, ${failed} failed) ${formatDuration(now() - startedAt)}`)
      }
    }

    const later: V1Session[] = []
    for (const session of reader.sessions(options.since)) {
      report.sessions.seen++
      if (importSession(session, true) === "later") later.push(session)
      else tick()
    }
    // Children whose parent sorts after them in creation time: the parent has had its turn now.
    for (const session of later) {
      importSession(session, false)
      tick()
    }

    if (options.memories !== false) await importMemories({ from, report, ...(store ? { target: { clock, store } } : {}) })

    report.finishedAt = new Date(now()).toISOString()
    report.durationMs = now() - startedAt
    if (!dryRun) {
      const reportDir = path.join(dir, REPORT_DIR)
      mkdirSync(reportDir, { recursive: true })
      report.reportFile = path.join(reportDir, `v1-${report.finishedAt.replace(/[:.]/g, "-")}.json`)
      writeFileSync(report.reportFile, `${JSON.stringify(report, null, 2)}\n`)
    }
    return report
  } finally {
    reader.close()
    store?.close()
  }
}

/** Appends one mapped event: the session's first event creates the session row too. */
function append(store: Store, clock: Clock, sessionId: SessionId, at: number, draft: SessionEventDraft) {
  clock.at = at
  if (draft.type === "session.created") store.createSession({ id: sessionId, directory: draft.directory, title: draft.title, ...(draft.parentId ? { parentId: draft.parentId } : {}) })
  else store.sessionSink.append(draft)
}

/** What the store would check on append, for a dry run that has no store. */
function validate(seq: number, at: number, draft: SessionEventDraft) {
  const event = SessionEvent.parse({ ...draft, seq, at })
  const size = JSON.stringify(event).length
  if (size > MAX_EVENT_BYTES) throw new RangeError(`event ${event.type} is ${size} bytes; over the store's ${MAX_EVENT_BYTES} limit`)
}
