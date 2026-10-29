import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { EXPORT_MAX_CHARS, MAX_FRAME_BYTES, redactSecrets, type ChangesReport, type ClientId, type ErrorCode, type ItemKind, type RewindReport, type SessionEvent, type SessionExportResult, type SessionId, type SessionTranscriptItem, type SessionTranscriptTurn, type SessionTranscript, type TimelineEntry } from "@mendcode/protocol"
import { historyMark, type FileSnapshot, type FileState, type Store, type TurnRecord } from "@mendcode/store"
import { canonicalDirectory, readFileState, writeFileState, type TurnSnapshots } from "./turn-snapshots"
import { sanitizeTranscript, redactTranscriptValue } from "./session-transfer"
import { renderHtml } from "./session-html"
import { boundSnapshotReport, summarizeSnapshots } from "./snapshot-diff"

export type Outcome<T> = { ok: true; result: T } | { ok: false; code: ErrorCode; message: string }
const fail = (code: ErrorCode, message: string): { ok: false; code: ErrorCode; message: string } => ({ ok: false, code, message: `[DAEMON]: ${message}` })

/** Bytes of a file the undo reads back to keep it for a rollback; a bigger current file is not kept (it cannot be rolled back). */
const ROLLBACK_READ_BYTES = 8 * 1024 * 1024
const MAX_REPORTED_FILES = 500
const MAX_CONFLICTS_SHOWN = 5
/** Text kept per item in an export. Messages are long by nature; tool output is cut hard (docs/sessions.md). */
const MESSAGE_CHARS = 40_000
const TOOL_CHARS = 6_000
const TOOL_LINES = 120
const OTHER_CHARS = 4_000
const EXPORT_PAGE = 1_000
/** What the export's ack keeps free for the frame around the text. */
const FRAME_HEADROOM = 2_048

type Writable = { state: "content"; content: Uint8Array; mode?: number } | { state: "absent" }

type HistoryDeps = {
  store: Store
  snapshots: TurnSnapshots
  /** Sends an event the store already appended to the clients watching the session. */
  publish(event: SessionEvent): void
  /** A turn is running (or finishing) in the session: nothing may rewrite its history now. */
  isBusy(sessionId: SessionId): boolean
  now(): number
}

/** Message indices where each user-typed prompt starts (a tool's image note is a user message too, but no prompt). */
function promptStarts(messages: unknown[]) {
  const starts: number[] = []
  messages.forEach((message, index) => {
    const record = message as { role?: unknown; content?: unknown }
    if (record.role === "user" && typeof record.content === "string" && !record.content.startsWith("[image from ")) starts.push(index)
  })
  return starts
}

const writable = (state: FileState): Writable | undefined => (state.state === "skipped" ? undefined : state)

/** True/false when the file's state at `file` equals `expected`; undefined when `expected` holds no content to compare with. */
function sameState(file: string, expected: FileState): boolean | undefined {
  if (expected.state === "skipped") return undefined
  if (expected.state === "absent") return readFileState(file, 0).state === "absent"
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return false
  }
  if (size !== expected.content.length) return false
  const current = readFileState(file, size, true)
  return current.state === "content" && (expected.mode === undefined || current.mode === expected.mode) && Buffer.from(current.content).equals(Buffer.from(expected.content))
}

type Step = { path: string; target: Writable; before: Writable | undefined }

/**
 * Undo, redo, fork points, the timeline and export of a session (docs/sessions.md). The store keeps the data
 * (per-turn projection, file snapshots, the undo stack); this is where it is checked, applied to the files and published.
 */
export function createSessionHistory(deps: HistoryDeps) {
  const { store } = deps

  /**
   * Turns recorded before history marks existed (older sessions) have none: when the session has no mark at all, never
   * compacted and exactly one engine keeps messages, the k-th user prompt in that history belongs to the k-th turn with
   * a user message. A count that does not match means it cannot be known, so nothing is guessed.
   */
  function ensureMarks(sessionId: SessionId): TurnRecord[] {
    const turns = store.turns.list(sessionId)
    if (turns.length === 0 || turns.some((turn) => turn.history !== undefined || turn.compacted)) return turns
    const engines = Object.entries(store.turns.messageCounts(sessionId)).filter(([, count]) => count > 0)
    if (engines.length !== 1) return turns
    const engine = engines[0]![0]
    const starts = promptStarts(store.engineMessages.load(sessionId, engine))
    const prompted = turns.filter((turn) => turn.itemId !== undefined)
    if (starts.length !== prompted.length) return turns
    let next = 0
    const total = store.turns.messageCounts(sessionId)[engine]!
    for (const turn of turns) {
      if (turn.itemId !== undefined) store.turns.setHistory(sessionId, turn.turnId, { [engine]: starts[next++]! })
      else store.turns.setHistory(sessionId, turn.turnId, { [engine]: starts[next] ?? total })
    }
    return store.turns.list(sessionId)
  }

  /**
   * Assistant messages from before `historyIndex` was recorded have no stored boundary. When the turn's n-th assistant
   * message item and the n-th assistant message with text in its history range can be paired without doubt (as many of
   * one as of the other), the cut is that message's index; any other shape gives undefined and the fork is refused.
   */
  function legacyAssistantCut({ sessionId, itemId, start, end, from, to }: { sessionId: SessionId; itemId: string; start: number; end: number; from: number; to: number | undefined }): number | undefined {
    const items = store.agentMessageIds(sessionId, from, to)
    const ordinal = items.indexOf(itemId)
    if (ordinal < 0) return undefined
    const spoken: number[] = []
    store.engineMessages.load(sessionId, "native").slice(start, end).forEach((message, offset) => {
      const record = message as { role?: unknown; content?: unknown }
      if (record.role === "assistant" && typeof record.content === "string" && record.content.trim()) spoken.push(start + offset)
    })
    return spoken.length === items.length ? spoken[ordinal] : undefined
  }

  const shown = (directory: string, file: string) => {
    const relative = path.relative(canonicalDirectory(directory), file)
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file
  }

  /**
   * The file steps of rewinding `turnIds` (application order: newest first for an undo, oldest first for a redo).
   * A path several turns touched ends in the state of the last turn applied and is expected to be, now, in the state
   * the first one left it. Files changed since (hand edits, shell commands) are conflicts.
   */
  function planFiles({ sessionId, turnIds, direction }: { sessionId: SessionId; turnIds: string[]; direction: "undo" | "redo" }) {
    if (store.settings.get().snapshot === false) return { steps: [] as Step[], conflicts: [] as string[], skipped: [] as RewindReport["files"]["skipped"] }
    const expected = new Map<string, FileState | undefined>()
    const target = new Map<string, FileState | undefined>()
    for (const turnId of turnIds) {
      // A turn that ended without its files being sealed (the daemon stopped first) is sealed now, before anything changes them.
      deps.snapshots.seal(sessionId, turnId)
      for (const snapshot of store.turns.files.list(sessionId, turnId)) {
        const before: FileState | undefined = snapshot.before
        const after: FileState | undefined = snapshot.after
        const [entering, leaving] = direction === "undo" ? [after, before] : [before, after]
        if (!expected.has(snapshot.path)) expected.set(snapshot.path, entering)
        target.set(snapshot.path, leaving)
      }
    }
    return planSteps({ target, expected })
  }

  /** The steps that put each path of `target` in its goal state; a path whose current state is not `expected` is a conflict. */
  function planSteps({ target, expected }: { target: Map<string, FileState | undefined>; expected: Map<string, FileState | undefined> }) {
    const steps: Step[] = []
    const conflicts: string[] = []
    const skipped: RewindReport["files"]["skipped"] = []
    for (const [file, goal] of target) {
      const wanted = goal ? writable(goal) : undefined
      if (!wanted) {
        skipped.push({ path: file, reason: goal?.state === "skipped" ? goal.reason : "not_tracked" })
        continue
      }
      if (sameState(file, wanted) === true) continue
      const entering = expected.get(file)
      if (entering && sameState(file, entering) === false) conflicts.push(file)
      const current = readFileState(file, ROLLBACK_READ_BYTES, true)
      if (current.state === "skipped") {
        skipped.push({ path: file, reason: current.reason })
        continue
      }
      steps.push({ path: file, target: wanted, before: writable(current) })
    }
    return { steps, conflicts, skipped }
  }

  /** Applies the steps; on an I/O error the ones already applied are put back and the error is returned. */
  function applySteps(steps: Step[]): string | undefined {
    const applied: Step[] = []
    for (const step of steps) {
      try {
        writeFileState(step.path, step.target)
        applied.push(step)
      } catch (error) {
        for (const done of applied.reverse()) {
          try {
            if (done.before) writeFileState(done.path, done.before)
          } catch {
            // Best effort: the original error is what the user needs to see.
          }
        }
        return `${step.path}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return undefined
  }

  function rollback(steps: Step[]) {
    for (const step of [...steps].reverse()) {
      try {
        if (step.before) writeFileState(step.path, step.before)
      } catch {
        // Best effort.
      }
    }
  }

  function report({ directory, turns, steps, skipped, messages, sessionId, itemId }: { directory: string; turns: TurnRecord[]; steps: Step[]; skipped: RewindReport["files"]["skipped"]; messages: number; sessionId: SessionId; itemId?: string }): RewindReport {
    const shellUntracked = turns.some((turn) => turn.shell || turn.shellTool)
    const worktreeTracked = store.settings.get().snapshot !== false && turns.every((turn) => store.turns.snapshots.get(sessionId, turn.turnId)?.scope === "worktree")
    const tracked = store.engineBindings.get(sessionId, "claude") === undefined && store.engineBindings.get(sessionId, "codex") === undefined
    const notes: string[] = []
    if (shellUntracked) notes.push(worktreeTracked ? "Only captured worktree files are restored. Shell effects outside the worktree, Git history/index and external services are not rewound." : "Changes made by shell commands are not tracked: files a command changed were not reverted.")
    if (store.settings.get().snapshot === false) notes.push("File snapshots are disabled; only the conversation was rewound.")
    else if (turns.some((turn) => {
      const record = store.turns.snapshots.get(sessionId, turn.turnId)
      return record?.summary?.files.length && !store.turns.files.list(sessionId, turn.turnId).length
    })) notes.push("Some file snapshots have expired; those turns only rewind the conversation.")
    if (!tracked) notes.push("The model's history lives in an external engine: it still remembers the turn.")
    if (skipped.length > 0) notes.push(`${skipped.length} file${skipped.length === 1 ? "" : "s"} could not be restored: no snapshot of them was kept (binary, over the size budget or unreadable).`)
    const start = itemId ? store.itemStart(sessionId, itemId) : undefined
    const item = start ? store.readAfter(sessionId, start.seq, 1)[0] : undefined
    const prompt = item?.type === "item.completed" && item.itemId === itemId && item.text !== undefined && item.text.length <= 40_000 && !item.blob
      ? { text: item.text, attachments: (item.attachments ?? []).slice(0, 32) } : undefined
    const files = new Map<string, FileSnapshot>()
    for (const turn of turns) for (const snapshot of store.turns.files.list(sessionId, turn.turnId)) {
      const first = files.get(snapshot.path)
      files.set(snapshot.path, { ...snapshot, before: first?.before ?? snapshot.before })
    }
    const changes = (turns.length === 1 ? store.turns.snapshots.get(sessionId, turns[0]!.turnId)?.summary : undefined)
      ?? summarizeSnapshots(canonicalDirectory(directory), [...files.values()], worktreeTracked)
    const result: RewindReport = {
      turnIds: turns.map((turn) => turn.turnId) as RewindReport["turnIds"],
      ...(itemId ? { itemId: itemId as NonNullable<RewindReport["itemId"]> } : {}),
      files: {
        restored: steps.filter((step) => step.target.state === "content").map((step) => shown(directory, step.path)).slice(0, MAX_REPORTED_FILES),
        removed: steps.filter((step) => step.target.state === "absent").map((step) => shown(directory, step.path)).slice(0, MAX_REPORTED_FILES),
        skipped: skipped.slice(0, MAX_REPORTED_FILES).map((entry) => ({ ...entry, path: shown(directory, entry.path) })),
      },
      history: { messages, tracked },
      shellUntracked,
      notes,
      worktreeTracked,
      ...(prompt ? { prompt } : {}),
      canRedo: store.turns.undoTop(sessionId) !== undefined,
      changes: changes.files.filter((file) => file.path.length <= 4096).map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    }
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_FRAME_BYTES - FRAME_HEADROOM) {
      const lists = [result.files.restored, result.files.removed, result.files.skipped, result.changes ?? []]
      const longest = lists.sort((a, b) => b.length - a.length)[0]!
      if (!longest.length) { delete result.prompt; break }
      longest.pop()
      if (!result.notes.includes("File list truncated to fit the reply.")) result.notes.push("File list truncated to fit the reply.")
    }
    return result
  }

  function conflictMessage(verb: string, directory: string, conflicts: string[]) {
    const list = conflicts.slice(0, MAX_CONFLICTS_SHOWN).map((file) => shown(directory, file))
    const more = conflicts.length > MAX_CONFLICTS_SHOWN ? ` and ${conflicts.length - MAX_CONFLICTS_SHOWN} more` : ""
    return `${verb} would overwrite changes made after the turn to ${list.join(", ")}${more}; send force to do it anyway`
  }

  /** The tracked edit calls of a turn from event number `fromSeq` on: each touched path with its state before the first such call. */
  function partialTargets({ sessionId, turnId, fromSeq }: { sessionId: SessionId; turnId: string; fromSeq: number }) {
    const seqs = new Map<string, number>()
    const ordered: Array<{ seq: number; path: string; before: FileState }> = []
    for (const call of store.turns.calls.list(sessionId, turnId)) {
      let seq = seqs.get(call.itemId)
      if (seq === undefined) {
        seq = store.itemStart(sessionId, call.itemId)?.seq ?? -1
        seqs.set(call.itemId, seq)
      }
      if (seq >= fromSeq) ordered.push({ seq, path: call.path, before: call.before })
    }
    ordered.sort((a, b) => a.seq - b.seq)
    const target = new Map<string, FileState>()
    for (const entry of ordered) if (!target.has(entry.path)) target.set(entry.path, entry.before)
    return target
  }

  /** File steps of reverting (undo) or re-applying (redo) the calls of one turn from `fromSeq` on. */
  function planPartial({ sessionId, turnId, fromSeq, direction }: { sessionId: SessionId; turnId: string; fromSeq: number; direction: "undo" | "redo" }) {
    if (store.settings.get().snapshot === false) return { steps: [] as Step[], conflicts: [] as string[], skipped: [] as RewindReport["files"]["skipped"], paths: [] as string[] }
    deps.snapshots.seal(sessionId, turnId)
    const reverted = partialTargets({ sessionId, turnId, fromSeq })
    const finished = new Map(store.turns.files.list(sessionId, turnId).map((file) => [file.path, file.after]))
    const target = new Map<string, FileState | undefined>()
    const expected = new Map<string, FileState | undefined>()
    for (const [file, before] of reverted) {
      target.set(file, direction === "undo" ? before : finished.get(file))
      expected.set(file, direction === "undo" ? finished.get(file) : before)
    }
    return { ...planSteps({ target, expected }), paths: [...reverted.keys()] }
  }

  function partialReport({ directory, sessionId, turn, partId, steps, skipped }: { directory: string; sessionId: SessionId; turn: TurnRecord; partId: string; steps: Step[]; skipped: RewindReport["files"]["skipped"] }): RewindReport {
    const notes: string[] = []
    notes.push("Only files changed by edit calls from that part on were restored; the conversation and the model's memory of those calls are unchanged.")
    if (turn.shell || turn.shellTool) notes.push("Changes made by shell commands are not tracked: files a command changed were not reverted.")
    if (store.settings.get().snapshot === false) notes.push("File snapshots are disabled; nothing was restored.")
    else if (steps.length === 0 && skipped.length === 0) notes.push("No tracked file changes from that part on.")
    if (skipped.length > 0) notes.push(`${skipped.length} file${skipped.length === 1 ? "" : "s"} could not be restored: no snapshot of them was kept (binary, over the size budget or unreadable).`)
    return {
      turnIds: [turn.turnId] as RewindReport["turnIds"],
      ...(turn.itemId ? { itemId: turn.itemId as NonNullable<RewindReport["itemId"]> } : {}),
      files: {
        restored: steps.filter((step) => step.target.state === "content").map((step) => shown(directory, step.path)).slice(0, MAX_REPORTED_FILES),
        removed: steps.filter((step) => step.target.state === "absent").map((step) => shown(directory, step.path)).slice(0, MAX_REPORTED_FILES),
        skipped: skipped.slice(0, MAX_REPORTED_FILES).map((entry) => ({ ...entry, path: shown(directory, entry.path) })),
      },
      history: { messages: 0, tracked: true },
      shellUntracked: turn.shell || turn.shellTool,
      notes: notes.slice(0, 8),
      canRedo: store.turns.undoTop(sessionId) !== undefined,
      partial: true,
      partId: partId as NonNullable<RewindReport["partId"]>,
    }
  }

  /** Whether an assistant text or a tool call of the turn started before event number `seq`. */
  function priorWork({ sessionId, turn, seq }: { sessionId: SessionId; turn: TurnRecord; seq: number }) {
    for (let cursor = turn.seq - 1; cursor < seq;) {
      const page = store.readAfter(sessionId, cursor, 500)
      if (page.length === 0) return false
      for (const event of page) {
        if (event.seq >= seq) return false
        if (event.type === "item.started" && event.turnId === turn.turnId && (event.kind === "agent_message" || event.kind === "tool_call")) return true
      }
      cursor = page.at(-1)!.seq
    }
    return false
  }

  /** Merges the reports of several redos into the one a `redo { all }` answers. */
  function mergeReports(reports: RewindReport[]): RewindReport {
    const last = reports.at(-1)!
    const unique = <T>(values: T[], key: (value: T) => string, max: number) => [...new Map(values.map((value) => [key(value), value])).values()].slice(0, max)
    const merged: RewindReport = {
      ...last,
      turnIds: unique(reports.flatMap((entry) => entry.turnIds), String, 64) as RewindReport["turnIds"],
      files: {
        restored: unique(reports.flatMap((entry) => entry.files.restored), String, 500),
        removed: unique(reports.flatMap((entry) => entry.files.removed), String, 500),
        skipped: unique(reports.flatMap((entry) => entry.files.skipped), (entry) => entry.path, 500),
      },
      history: { messages: reports.reduce((sum, entry) => sum + entry.history.messages, 0), tracked: reports.every((entry) => entry.history.tracked) },
      shellUntracked: reports.some((entry) => entry.shellUntracked),
      notes: unique(reports.flatMap((entry) => entry.notes), String, 8),
      canRedo: false,
      ...(reports.some((entry) => entry.changes) ? { changes: unique(reports.flatMap((entry) => entry.changes ?? []), (entry) => entry.path, 300) } : {}),
    }
    if (!reports.every((entry) => entry.partial === true)) {
      delete merged.partial
      delete merged.partId
    }
    return merged
  }

  const api = {
    /** Persisted message diffs; a session combines retained file states into its net diff. */
    changes({ sessionId, atItemId }: { sessionId: SessionId; atItemId?: string | undefined }): Outcome<ChangesReport> {
      const info = store.sessionInfo(sessionId)
      if (!info) return fail("unknown_session", "unknown session")
      if (atItemId) {
        const turn = store.turns.byItem(sessionId, atItemId)
        if (!turn) return fail("target_mismatch", "that item is not a user message of this session")
        if (turn.status === "running") return fail("busy", "that message's turn is still running")
        const summary = store.turns.snapshots.get(sessionId, turn.turnId)?.summary
        return { ok: true, result: { ...(summary ?? { root: info.directory, files: [], omittedFiles: 0, complete: false }), scope: "message" } }
      }
      const combined = new Map<string, FileSnapshot>()
      const archived = new Map<string, ChangesReport["files"][number]>()
      const touched = new Map<string, number>()
      const root = canonicalDirectory(info.directory)
      // Older persisted patches and newer ones of one path: their additions/deletions add up and their patches follow each other (not a net patch).
      const fold = (file: ChangesReport["files"][number]) => {
        const older = archived.get(file.path)
        if (!older) archived.set(file.path, file)
        else if (older.status === "added" && file.status === "deleted") archived.delete(file.path)
        else archived.set(file.path, { ...file, status: older.status === "added" ? "added" : file.status, additions: older.additions + file.additions, deletions: older.deletions + file.deletions, diff: `${older.diff}${older.diff && !older.diff.endsWith("\n") ? "\n" : ""}${file.diff}`, binary: older.binary || file.binary, truncated: true })
      }
      let complete = true
      let omittedFiles = 0
      for (const turn of store.turns.list(sessionId).filter((turn) => !turn.reverted)) {
        const record = store.turns.snapshots.get(sessionId, turn.turnId)
        complete &&= record?.complete === true && record.sealed
        omittedFiles += record?.summary?.omittedFiles ?? 0
        const files = store.turns.files.list(sessionId, turn.turnId)
        if (!files.length && record?.summary?.files.length) {
          complete = false
          for (const file of record.summary.files) {
            fold(file)
            touched.set(file.path, turn.at)
          }
        }
        for (const file of files) {
          touched.set(path.relative(root, file.path) || file.path, turn.at)
          const previous = combined.get(file.path)
          combined.set(file.path, { ...file, before: previous?.before ?? file.before })
        }
      }
      const summary = summarizeSnapshots(canonicalDirectory(info.directory), [...combined.values()], complete)
      // A path changed by pruned turns and by retained ones: the retained net diff alone would hide the older edits.
      for (const file of summary.files) fold(file)
      const files = [...archived.values()].map((file) => ({ ...file, ...(touched.has(file.path) ? { touchedAt: touched.get(file.path)! } : {}) })).sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0) || a.path.localeCompare(b.path)).slice(0, 300)
      // Persisted patches already have a frame budget; the aggregate gets one too.
      let left = 120_000
      for (const file of files) {
        const bytes = Buffer.byteLength(JSON.stringify(file.diff))
        if (bytes > left) { file.diff = ""; file.truncated = true }
        else left -= bytes
      }
      return { ok: true, result: boundSnapshotReport({ ...summary, files, omittedFiles: Math.max(summary.omittedFiles, omittedFiles) + Math.max(0, archived.size - files.length), scope: "session" }) }
    },
    /** The user messages of the session to jump to, oldest first (system notices and compaction turns are not messages). */
    timeline(sessionId: SessionId): Outcome<{ entries: TimelineEntry[] }> {
      if (!store.hasSession(sessionId)) return fail("unknown_session", "unknown session")
      const labels = new Map(store.sessionTree.labels(sessionId).map((entry) => [entry.itemId, entry.label]))
      const entries = store.turns
        .list(sessionId)
        .filter((turn) => turn.itemId !== undefined && !turn.notice && !store.messages.revision(sessionId, turn.itemId as import("@mendcode/protocol").ItemId)?.deleted)
        .map((turn) => ({ turnId: turn.turnId, itemId: turn.itemId!, at: turn.at, preview: turn.preview, reverted: turn.reverted, ...(labels.has(turn.itemId!) ? { label: labels.get(turn.itemId!) } : {}) }))
      return { ok: true, result: { entries: entries as TimelineEntry[] } }
    },

    /**
     * The newest of `turns` (live turns of the session, oldest first, each starting at its `seq`) with their messages,
     * shell commands and file edits, input and output cut and secrets as markers, for a handoff or a merge-back. Turns are
     * read from the newest back until `maxChars` of text are held; with `keepFirst` the oldest one is read too. `skipped`
     * counts the turns not read. `untilSeq` is the first event left out (the turn that is about to start).
     */
    portableTurns({ sessionId, turns, untilSeq, maxChars, keepFirst }: { sessionId: SessionId; turns: ReadonlyArray<{ seq: number }>; untilSeq?: number | undefined; maxChars: number; keepFirst: boolean }): { turns: SessionTranscriptTurn[]; skipped: number } {
      const read = (index: number) => collect(store, sessionId, { toolDetails: true, fromSeq: turns[index]!.seq - 1, ...((turns[index + 1]?.seq ?? untilSeq) !== undefined ? { untilSeq: turns[index + 1]?.seq ?? untilSeq } : {}) }).turns
      const newest: SessionTranscriptTurn[] = []
      let size = 0
      let reached = turns.length
      for (let index = turns.length - 1; index >= 0 && size < maxChars; index--) {
        const got = read(index)
        newest.unshift(...got)
        size += got.reduce((sum, turn) => sum + turn.items.reduce((inner, item) => inner + item.text.length + (item.input?.length ?? 0), 0), 0)
        reached = index
      }
      const first = keepFirst && reached > 0 ? read(0) : []
      return { turns: [...first, ...newest], skipped: reached - (first.length ? 1 : 0) }
    },

    /**
     * Where a fork at `itemId` cuts: the turn that message started and, per engine that keeps messages, how many of
     * them come along (everything before the next turn began).
     */
    forkPoint({ sessionId, itemId }: { sessionId: SessionId; itemId: string }): Outcome<{ turnId: string; cuts: Record<string, number> }> {
      const turn = store.turns.byItem(sessionId, itemId)
      if (!turn) return fail("target_mismatch", "that item is not a user message of this session")
      if (turn.reverted) return fail("target_mismatch", "that message was undone")
      if (turn.status === "running") return fail("busy", "that message's turn is still running")
      const turns = ensureMarks(sessionId)
      const index = turns.findIndex((candidate) => candidate.turnId === turn.turnId)
      const next = turns[index + 1]
      const cuts: Record<string, number> = {}
      for (const [engine, count] of Object.entries(store.turns.messageCounts(sessionId))) {
        if (count === 0) continue
        const cut = next ? historyMark(next, engine) : count
        if (cut === undefined || cut > count) return fail("target_mismatch", "the model history of that point no longer exists (the context was compacted since); fork from a later message")
        cuts[engine] = cut
      }
      return { ok: true, result: { turnId: turn.turnId, cuts } }
    },

    /** CLI message cuts are exclusive; a user cut drops its turn, an assistant cut keeps the prompt and earlier steps. */
    forkBefore({ sessionId, itemId }: { sessionId: SessionId; itemId: string }): Outcome<{ turnId?: string; cuts: Record<string, number>; beforeSeq?: number }> {
      const item = store.itemStart(sessionId, itemId)
      if (!item || !["user_message", "agent_message"].includes(item.kind)) return fail("target_mismatch", "that item is not a message of this session")
      const turns = ensureMarks(sessionId)
      const turn = turns.find((candidate) => candidate.turnId === item.turnId)
      if (!turn || turn.reverted) return fail("target_mismatch", "that message was undone or its history is unavailable")
      if (turn.status === "running") return fail("busy", "that message's turn is still running")
      const index = turns.indexOf(turn)
      const next = turns[index + 1]
      const cuts: Record<string, number> = {}
      for (const [engine, count] of Object.entries(store.turns.messageCounts(sessionId))) {
        if (count === 0) continue
        const start = historyMark(turn, engine)
        const end = next ? historyMark(next, engine) : count
        if (start === undefined || end === undefined || end > count) return fail("target_mismatch", "the model history of that message no longer exists (compacted)")
        if (item.kind === "user_message") { cuts[engine] = start; continue }
        if (start === end) { cuts[engine] = start; continue }
        const cut = engine === "native" ? item.meta?.historyIndex ?? legacyAssistantCut({ sessionId, itemId, start, end, from: turn.seq, to: next?.seq }) : undefined
        if (typeof cut !== "number" || !Number.isSafeInteger(cut) || cut <= start || cut > end) return fail("target_mismatch", "that assistant message has no retained model history boundary")
        cuts[engine] = cut
      }
      if (item.kind === "agent_message") return { ok: true, result: { turnId: turn.turnId, cuts, beforeSeq: item.seq } }
      const previous = turns.slice(0, index).findLast((candidate) => !candidate.reverted)
      return { ok: true, result: { ...(previous ? { turnId: previous.turnId } : {}), cuts } }
    },

    /**
     * Reverts from one part of a turn on: the files its edit calls (and the later ones of that turn) changed go back and the
     * transcript stays. A part with no earlier text or tool call in its turn is the whole message (`undo`). Messages after the
     * turn are undone first, as a v1 revert does. `redo` brings the files back.
     */
    undoPart({ sessionId, partId, force, clientId }: { sessionId: SessionId; partId: string; force?: boolean | undefined; clientId?: ClientId | undefined }): Outcome<RewindReport> {
      const info = store.sessionInfo(sessionId)
      if (!info) return fail("unknown_session", "unknown session")
      if (deps.isBusy(sessionId)) return fail("busy", "a turn is running; undo after it ends")
      const start = store.itemStart(sessionId, partId)
      const turn = start ? store.turns.get(sessionId, start.turnId) : undefined
      if (!start || !turn || turn.reverted) return fail("target_mismatch", "that part is not in a live message of this session")
      if (turn.status === "running") return fail("busy", "a turn is running; undo after it ends")
      if (turn.itemId === partId || !priorWork({ sessionId, turn, seq: start.seq })) {
        return turn.itemId ? api.undo({ sessionId, force, clientId, atItemId: turn.itemId }) : fail("target_mismatch", "that part belongs to a system notice, not a message")
      }
      if (turn.compacted) return fail("target_mismatch", "the context was compacted in that turn, so it can no longer be undone")
      const top = store.turns.undoTop(sessionId)
      if (top?.partial) {
        const restored = api.redoOnce({ sessionId, force, clientId })
        if (!restored.ok) return restored
      }
      const later = ensureMarks(sessionId).filter((candidate) => !candidate.reverted && candidate.seq > turn.seq).find((candidate) => candidate.itemId !== undefined && !candidate.notice)
      let undone = false
      if (later) {
        const outcome = api.undo({ sessionId, force, clientId, atItemId: later.itemId! })
        if (!outcome.ok) return outcome
        undone = true
      }
      const plan = planPartial({ sessionId, turnId: turn.turnId, fromSeq: start.seq, direction: "undo" })
      const abandon = (failure: Outcome<RewindReport>) => {
        if (undone) api.redoOnce({ sessionId, force: true, clientId })
        return failure
      }
      if (plan.conflicts.length > 0 && !force) return abandon(fail("target_mismatch", conflictMessage("undo", info.directory, plan.conflicts)))
      const problem = applySteps(plan.steps)
      if (problem) return abandon(fail("internal", `could not restore ${problem}; the files restored so far were put back`))
      try {
        store.rewindPartial({ sessionId, partial: { turnId: turn.turnId, itemId: partId, paths: plan.paths.slice(0, MAX_REPORTED_FILES) } })
      } catch (error) {
        rollback(plan.steps)
        return abandon(fail("internal", `undo failed: ${error instanceof Error ? error.message : String(error)}`))
      }
      return { ok: true, result: partialReport({ directory: info.directory, sessionId, turn, partId, steps: plan.steps, skipped: plan.skipped }) }
    },

    undo({ sessionId, force, clientId, atItemId, atPartId }: { sessionId: SessionId; force?: boolean | undefined; clientId?: ClientId | undefined; atItemId?: string | undefined; atPartId?: string | undefined }): Outcome<RewindReport> {
      if (atPartId) return api.undoPart({ sessionId, partId: atPartId, force, clientId })
      const info = store.sessionInfo(sessionId)
      if (!info) return fail("unknown_session", "unknown session")
      if (deps.isBusy(sessionId)) return fail("busy", "a turn is running; undo after it ends")
      // Files a part-level revert put back would read as conflicts; bring them back first.
      if (store.turns.undoTop(sessionId)?.partial) {
        const restored = api.redoOnce({ sessionId, force, clientId })
        if (!restored.ok) return restored
      }
      const turns = ensureMarks(sessionId)
      const live = turns.filter((turn) => !turn.reverted)
      const anchorAt = atItemId ? live.findIndex((turn) => turn.itemId === atItemId && !turn.notice) : live.findLastIndex((turn) => turn.itemId !== undefined && !turn.notice)
      if (anchorAt < 0) return fail("target_mismatch", atItemId ? "that item is not a live user message of this session" : "there is nothing to undo")
      // The user's last message and whatever followed it (the agent's notices) go together: history is cut as one tail.
      const group = live.slice(anchorAt)
      const anchor = group[0]!
      if (group.some((turn) => turn.status === "running")) return fail("busy", "a turn is running; undo after it ends")
      if (group.some((turn) => turn.compacted)) return fail("target_mismatch", "the context was compacted after that message, so it can no longer be undone")
      const cuts: Record<string, number> = {}
      for (const [engine, count] of Object.entries(store.turns.messageCounts(sessionId))) {
        if (count === 0) continue
        const cut = historyMark(anchor, engine)
        if (cut === undefined || cut > count) return fail("target_mismatch", "the model history can no longer be rewound to before that message")
        cuts[engine] = cut
      }
      const plan = planFiles({ sessionId, turnIds: group.map((turn) => turn.turnId).reverse(), direction: "undo" })
      if (plan.conflicts.length > 0 && !force) return fail("target_mismatch", conflictMessage("undo", info.directory, plan.conflicts))
      const problem = applySteps(plan.steps)
      if (problem) return fail("internal", `could not restore ${problem}; the files restored so far were put back`)
      try {
        const done = store.rewindTurns({ sessionId, turnIds: group.map((turn) => turn.turnId), cuts, ...(clientId ? { byClientId: clientId } : {}) })
        for (const event of done.events) deps.publish(event)
        return { ok: true, result: report({ directory: info.directory, turns: group, steps: plan.steps, skipped: plan.skipped, messages: done.messages, sessionId, ...(anchor.itemId ? { itemId: anchor.itemId } : {}) }) }
      } catch (error) {
        rollback(plan.steps)
        return fail("internal", `undo failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** Redo of the newest undo only, or of every waiting one (`all`: newest first, stopping at the first refusal). */
    redo({ sessionId, force, clientId, all }: { sessionId: SessionId; force?: boolean | undefined; clientId?: ClientId | undefined; all?: boolean | undefined }): Outcome<RewindReport> {
      if (!all) return api.redoOnce({ sessionId, force, clientId })
      const reports: RewindReport[] = []
      while (store.turns.undoTop(sessionId)) {
        const outcome = api.redoOnce({ sessionId, force, clientId })
        if (!outcome.ok) return reports.length ? { ...outcome, message: `${outcome.message} (${reports.length} earlier undo group${reports.length === 1 ? " was" : "s were"} restored)` } : outcome
        reports.push(outcome.result)
      }
      return reports.length ? { ok: true, result: mergeReports(reports) } : fail("target_mismatch", "there is nothing to redo (redo works only until something new happens)")
    },

    redoOnce({ sessionId, force, clientId }: { sessionId: SessionId; force?: boolean | undefined; clientId?: ClientId | undefined }): Outcome<RewindReport> {
      const info = store.sessionInfo(sessionId)
      if (!info) return fail("unknown_session", "unknown session")
      if (deps.isBusy(sessionId)) return fail("busy", "a turn is running; redo after it ends")
      const top = store.turns.undoTop(sessionId)
      if (!top) return fail("target_mismatch", "there is nothing to redo (redo works only until something new happens)")
      if (top.partial) {
        const turn = store.turns.get(sessionId, top.partial.turnId)
        const start = store.itemStart(sessionId, top.partial.itemId)
        if (!turn || !start) return fail("target_mismatch", "the reverted part no longer exists")
        const plan = planPartial({ sessionId, turnId: turn.turnId, fromSeq: start.seq, direction: "redo" })
        if (plan.conflicts.length > 0 && !force) return fail("target_mismatch", conflictMessage("redo", info.directory, plan.conflicts))
        const problem = applySteps(plan.steps)
        if (problem) return fail("internal", `could not restore ${problem}; the files restored so far were put back`)
        try {
          if (!store.restoreTurns({ sessionId, ...(clientId ? { byClientId: clientId } : {}) })) {
            rollback(plan.steps)
            return fail("target_mismatch", "there is nothing to redo")
          }
        } catch (error) {
          rollback(plan.steps)
          return fail("internal", `redo failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return { ok: true, result: partialReport({ directory: info.directory, sessionId, turn, partId: top.partial.itemId, steps: plan.steps, skipped: plan.skipped }) }
      }
      const group = top.turnIds.map((turnId) => store.turns.get(sessionId, turnId)).filter((turn): turn is TurnRecord => turn !== undefined)
      const plan = planFiles({ sessionId, turnIds: top.turnIds, direction: "redo" })
      if (plan.conflicts.length > 0 && !force) return fail("target_mismatch", conflictMessage("redo", info.directory, plan.conflicts))
      const problem = applySteps(plan.steps)
      if (problem) return fail("internal", `could not restore ${problem}; the files restored so far were put back`)
      try {
        const done = store.restoreTurns({ sessionId, ...(clientId ? { byClientId: clientId } : {}) })
        if (!done) {
          rollback(plan.steps)
          return fail("target_mismatch", "there is nothing to redo")
        }
        for (const event of done.events) deps.publish(event)
        return { ok: true, result: report({ directory: info.directory, turns: group, steps: plan.steps, skipped: plan.skipped, messages: done.messages, sessionId, ...(group[0]?.itemId ? { itemId: group[0].itemId } : {}) }) }
      } catch (error) {
        rollback(plan.steps)
        return fail("internal", `redo failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },

    /** The session as Markdown or JSON, bounded; see the constants above and docs/sessions.md for what is left out. */
    export({ sessionId, format, ...requested }: { sessionId: SessionId; format: "markdown" | "json" | "html" } & ExportOptions): Outcome<SessionExportResult> {
      const info = store.sessionInfo(sessionId)
      if (!info) return fail("unknown_session", "unknown session")
      // The HTML page hides tool input/output behind a toggle, so it carries them unless the caller says otherwise.
      const options: ExportOptions = { ...(format === "json" ? { fullParts: true } : format === "html" ? { toolDetails: true } : {}), ...Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== undefined)) }
      const collected = collect(store, sessionId, options)
      const frameBudget = MAX_FRAME_BYTES - FRAME_HEADROOM
      const escaped = (text: string) => Buffer.byteLength(JSON.stringify(text))
      let turns = collected.turns
      let truncated = collected.truncated
      const render = () => {
        const transcript: SessionTranscript = { format: "mendcode-session@1", sessionId, title: redactSecrets(info.title).text, directory: redactSecrets(info.directory).text, turns, truncated, exportedAt: deps.now() }
        const safe = options.sanitize ? sanitizeTranscript(transcript) : transcript
        if (format === "html") return renderHtml({ title: safe.title, directory: safe.directory, turns: safe.turns, truncated, exportedAt: safe.exportedAt, timestamps: options.timestamps })
        return format === "json" ? JSON.stringify(safe, null, 2) : renderMarkdown({ title: safe.title, directory: safe.directory, turns: safe.turns, truncated, options })
      }
      let text = render()
      // The ack is one frame: a JSON export drops trailing turns until it fits, Markdown is cut (both say so).
      while (escaped(text) > frameBudget && turns.length > 1) {
        turns = turns.slice(0, Math.max(1, Math.floor(turns.length * 0.8)))
        truncated = true
        text = render()
      }
      if (escaped(text) > frameBudget) {
        truncated = true
        const cut = Math.floor(frameBudget / 2.2)
        text = format !== "markdown" ? (turns = [], render()) : `${text.slice(0, cut)}\n\n> Export truncated.\n`
      }
      return { ok: true, result: { format, text, turns: turns.length, truncated } }
    },
  }
  return api
}

/** `fromSeq`/`untilSeq` read only the events in that range (`fromSeq` is the last event number to skip); `messagesOnly` keeps user and assistant messages and leaves the rest out. */
type ExportOptions = { fromSeq?: number | undefined; untilSeq?: number | undefined; messagesOnly?: boolean | undefined; reasoning?: boolean | undefined; toolDetails?: boolean | undefined; assistantMetadata?: boolean | undefined; timestamps?: boolean | undefined; sanitize?: boolean | undefined; fullParts?: boolean | undefined }
type ExportItem = SessionTranscriptItem
type ExportTurn = SessionTranscriptTurn

function clip(text: string, { chars, lines }: { chars: number; lines?: number }): { text: string; cut: boolean } {
  let out = text
  let cut = false
  if (lines !== undefined) {
    const all = out.replace(/\s+$/, "").split("\n")
    if (all.length > lines) {
      out = `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines`
      cut = true
    }
  }
  if (out.length > chars) {
    out = `${out.slice(0, chars)}\n… cut`
    cut = true
  }
  return { text: out, cut }
}

const limitOf = (kind: ItemKind, full = false) => full ? 65_520 : (kind === "user_message" || kind === "agent_message" ? MESSAGE_CHARS : kind === "tool_call" ? TOOL_CHARS : OTHER_CHARS)

/** One pass over the session's events in pages: the turns that are not undone, with each item's text bounded. */
function collect(store: Store, sessionId: SessionId, options: ExportOptions): { turns: ExportTurn[]; truncated: boolean } {
  const undone = new Set(store.turns.list(sessionId).filter((turn) => turn.reverted).map((turn) => turn.turnId))
  const turns: ExportTurn[] = []
  const turnOf = new Map<string, ExportTurn>()
  const items = new Map<string, { item: ExportItem; turn: ExportTurn; chars: number }>()
  let total = 0
  let itemCount = 0
  let truncated = false
  pages: for (let cursor = options.fromSeq ?? 0; ; ) {
    const page = store.readAfter(sessionId, cursor, EXPORT_PAGE)
    for (const event of store.messages.project(page)) {
      if (options.untilSeq !== undefined && event.seq >= options.untilSeq) break pages
      if (total > EXPORT_MAX_CHARS) {
        truncated = true
        break pages
      }
      switch (event.type) {
        case "session.created":
          if (event.imported?.truncated) truncated = true
          break
        case "turn.started": {
          if (undone.has(event.turnId)) break
          if (turns.length >= 1000) return { turns, truncated: true }
          const turn: ExportTurn = { turnId: event.turnId, at: event.at, outcome: "running", items: [], ...(options.assistantMetadata && event.importedMetadata ? { metadata: redactTranscriptValue(event.importedMetadata) } : {}) }
          turns.push(turn)
          turnOf.set(event.turnId, turn)
          break
        }
        case "item.started": {
          const turn = turnOf.get(event.turnId)
          if (!turn || event.kind === "reasoning" && !options.reasoning) break
          if (options.messagesOnly && event.kind !== "user_message" && event.kind !== "agent_message") break
          if (turn.items.length >= 200 || itemCount >= 2000) { truncated = true; break }
          itemCount++
          const tool = typeof event.meta?.tool === "string" ? redactSecrets(event.meta.tool).text : undefined
          const source = event.meta?.shell === true ? ("shell" as const) : event.meta?.notice === true ? ("notice" as const) : undefined
          const input = options.toolDetails === true && typeof event.meta?.input === "string" ? redactSecrets(event.meta.input).text.slice(0, OTHER_CHARS) : undefined
          const item: ExportItem = { itemId: event.itemId, kind: event.kind, text: "", ...(tool ? { tool } : {}), ...(source ? { source } : {}), ...(input ? { input } : {}), ...(options.timestamps ? { at: event.at } : {}) }
          if (event.meta) {
            item.meta = Object.fromEntries(Object.entries(redactTranscriptValue(event.meta)).slice(0, 64))
            if (options.toolDetails === false) delete item.meta.input
          }
          turn.items.push(item)
          total += 128
          items.set(event.itemId, { item, turn, chars: 0 })
          break
        }
        case "item.delta": {
          const entry = items.get(event.itemId)
          if (!entry || entry.item.kind === "tool_call" && options.toolDetails === false || entry.chars >= limitOf(entry.item.kind, options.fullParts)) break
          const added = event.text.slice(0, Math.max(0, limitOf(entry.item.kind, options.fullParts) - entry.item.text.length))
          entry.item.text += added
          total += added.length
          entry.chars += event.text.length
          break
        }
        case "item.completed": {
          const entry = items.get(event.itemId)
          if (!entry) break
          const { item } = entry
          const deltaChars = item.text.length
          if (item.kind === "tool_call" && options.toolDetails === true && event.toolInput) item.input = redactSecrets(event.toolInput).text
          if (event.text !== undefined) item.text = event.text
          if (item.kind === "tool_call" && options.toolDetails === false) item.text = ""
          let missingBlob = !!event.blob
          if (options.fullParts && event.blob && options.toolDetails !== false) {
            try {
              if (event.blob.bytes <= 65_536) {
                item.text = new TextDecoder("utf-8", { fatal: true }).decode(store.readBlob(event.blob.sha256))
                missingBlob = false
              }
            } catch { /* Older exports can reference unavailable blobs; the preview remains visibly truncated. */ }
          }
          const clipped = clip(item.text, { chars: limitOf(item.kind, options.fullParts), ...(item.kind === "tool_call" && !options.fullParts ? { lines: TOOL_LINES } : {}) })
          item.text = redactSecrets(clipped.text).text
          if (clipped.cut || missingBlob || entry.chars > limitOf(item.kind, options.fullParts) || item.meta?.importedTruncated) { item.truncated = true; truncated = true }
          if (event.meta) item.resultMeta = redactTranscriptValue(event.meta)
          if (event.render && options.toolDetails !== false) item.render = redactTranscriptValue(event.render)
          if (event.authorityText !== undefined) item.authorityText = redactSecrets(event.authorityText).text
          item.status = event.status
          if (event.attachmentDescriptions?.length) item.attachments = redactTranscriptValue(event.attachmentDescriptions)
          if (event.attachments?.length) item.attachments = event.attachments.map((ref) => ({ name: redactSecrets(ref.name ?? `${ref.sha256.slice(0, 12)}`).text, mime: ref.mime, bytes: ref.bytes }))
          total += JSON.stringify(item).length - deltaChars
          items.delete(event.itemId)
          break
        }
        case "turn.completed":
        case "turn.cancelled":
        case "turn.interrupted":
        case "turn.failed": {
          const turn = turnOf.get(event.turnId)
          if (!turn) break
          turn.outcome = event.type.slice("turn.".length) as ExportTurn["outcome"]
          if (turn.metadata) turn.metadata.durationMs = Math.max(0, event.at - turn.at)
          if (event.type === "turn.failed") turn.error = { code: event.error.code, message: redactSecrets(event.error.message).text }
          break
        }
        case "usage.recorded": {
          const turn = turnOf.get(event.turnId)
          if (turn && options.assistantMetadata) {
            const previous = turn.metadata
            turn.metadata = { provider: redactSecrets(event.provider).text, model: redactSecrets(event.model).text,
              tokens: (previous?.tokens ?? 0) + event.input + event.output + event.reasoning,
              input: (previous?.input ?? 0) + event.input, output: (previous?.output ?? 0) + event.output, reasoning: (previous?.reasoning ?? 0) + event.reasoning,
              cacheRead: (previous?.cacheRead ?? 0) + event.cacheRead, cacheWrite: (previous?.cacheWrite ?? 0) + event.cacheWrite,
              ...(event.costMicros !== undefined || previous?.costMicros !== undefined ? { costMicros: (previous?.costMicros ?? 0) + (event.costMicros ?? 0) } : {}),
              costComplete: (previous?.costComplete ?? true) && event.costMicros !== undefined,
            }
          }
          break
        }
        default:
          break
      }
    }
    if (page.length < EXPORT_PAGE) break
    cursor = page[page.length - 1]!.seq
  }
  // An item still open (an interrupted turn) keeps what its deltas gave.
  for (const { item, chars } of items.values()) {
    const clipped = clip(item.text, { chars: limitOf(item.kind, options.fullParts) })
    item.text = redactSecrets(clipped.text).text
    if (clipped.cut || chars > limitOf(item.kind, options.fullParts)) { item.truncated = true; truncated = true }
  }
  return { turns, truncated }
}

function fence(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const ticks = "`".repeat(longest + 1)
  return `${ticks}\n${text.replace(/\s+$/, "")}\n${ticks}`
}

function renderMarkdown({ title, directory, turns, truncated, options }: { title: string; directory: string; turns: ExportTurn[]; truncated: boolean; options: ExportOptions }) {
  const out: string[] = [`# ${redactSecrets(title.trim() || "MendCode session").text}`, `\`${directory}\``]
  for (const turn of turns) {
    let metadataShown = false
    for (const item of turn.items) {
      if (options.timestamps && item.at !== undefined) out.push(`> ${new Date(item.at).toISOString()}`)
      switch (item.kind) {
        case "user_message": {
          const heading = item.source === "shell" ? "## User (shell)" : item.source === "notice" ? "## System notice" : "## User"
          const attachments = item.attachments?.length ? `\n\nAttachments: ${item.attachments.map((attachment) => attachment.name).join(", ")}` : ""
          out.push(`${heading}\n\n${item.text.trim()}${attachments}`)
          break
        }
        case "agent_message":
          if (item.text.trim()) {
            const meta = !metadataShown && turn.metadata ? ` (${turn.metadata.model} · ${turn.metadata.provider} · ${turn.metadata.tokens} tokens${turn.metadata.durationMs !== undefined ? ` · ${(turn.metadata.durationMs / 1000).toFixed(1)}s` : ""})` : ""
            out.push(`## Assistant${meta}\n\n${item.text.trim()}`)
            metadataShown = true
          }
          break
        case "reasoning":
          if (item.text.trim()) out.push(`_Thinking:_\n\n${item.text.trim()}`)
          break
        case "tool_call": {
          const status = item.status && item.status !== "ok" ? ` (${item.status})` : ""
          out.push(`**Tool:** \`${item.tool ?? "tool"}\`${status}${item.input ? `\n\n**Input:**\n${fence(item.input)}` : ""}${item.text.trim() ? `\n\n${fence(item.text)}` : ""}`)
          break
        }
        case "compaction":
          out.push("> Context compacted.")
          break
        default:
          if (item.text.trim()) out.push(item.text.trim())
      }
    }
    if (turn.outcome === "failed") out.push(`> **Turn failed** (${turn.error?.code ?? "error"}): ${turn.error?.message ?? ""}`)
    else if (turn.outcome === "cancelled") out.push("> Turn cancelled.")
    else if (turn.outcome === "interrupted") out.push("> Turn interrupted.")
  }
  if (truncated) out.push("> Export truncated: content exceeds transcript/frame limits.")
  return `${out.join("\n\n")}\n`
}
