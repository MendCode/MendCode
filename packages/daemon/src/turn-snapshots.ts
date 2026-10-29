import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { EngineHooks } from "@mendcode/engine-native"
import { TURN_SNAPSHOT_MAX_BYTES, type SessionId } from "@mendcode/protocol"
import type { FileState, Store } from "@mendcode/store"
import { equalFileStates, summarizeSnapshots } from "./snapshot-diff"
import { WORKTREE_FILE_MAX_BYTES, WORKTREE_SNAPSHOT_MAX_BYTES, worktreeFiles } from "./worktree-snapshot"

/** Tools whose arguments say which files they change; a shell command or another tool's writes are not tracked. */
const SNAPSHOT_TOOLS = new Set(["write", "edit", "apply_patch", "notebook_edit"])
/** Files one tool call may add to a turn's snapshot (a patch touching more is cut; the rest is reported untracked at undo). */
const MAX_PATHS_PER_CALL = 50
/** A file is binary when its first bytes hold a NUL. */
const BINARY_SNIFF_BYTES = 8_192

export function canonicalDirectory(directory: string) {
  try { return realpathSync(directory) }
  catch { return directory }
}

const absolute = (cwd: string, file: string) => {
  const resolved = path.resolve(cwd, file)
  const relative = path.relative(path.resolve(cwd), resolved)
  return relative.startsWith("..") || path.isAbsolute(relative) ? resolved : path.resolve(canonicalDirectory(cwd), relative)
}

/** The absolute files a write/edit/apply_patch call will change (apply_patch: added, updated, deleted and moved-to files). */
export function pathsOfToolCall({ tool, args, cwd }: { tool: string; args: Record<string, unknown>; cwd: string }): string[] {
  if ((tool === "write" || tool === "edit" || tool === "notebook_edit") && typeof args.path === "string") return [absolute(cwd, args.path)]
  if (tool !== "apply_patch" || typeof args.patch !== "string") return []
  const found = [...args.patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => absolute(cwd, match[1]!.trim()))
  return [...new Set(found)].slice(0, MAX_PATHS_PER_CALL)
}

/**
 * What the file at `file` holds now, within `budget` bytes: its text, `absent`, or a reason nothing was kept (binary,
 * bigger than the budget, not a regular file or unreadable). Content is raw bytes, so line endings and encoding survive.
 */
export function readFileState(file: string, budget: number, allowBinary = false): FileState {
  let stat: ReturnType<typeof statSync>
  try {
    let parent = path.dirname(file)
    for (;;) {
      try {
        if (realpathSync(parent) !== path.resolve(parent)) return { state: "skipped", reason: "unreadable" }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(parent) === parent) throw error
        parent = path.dirname(parent)
      }
    }
    stat = lstatSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "absent" } : { state: "skipped", reason: "unreadable" }
  }
  if (!stat.isFile()) return { state: "skipped", reason: "unreadable" }
  if (stat.size > budget) return { state: "skipped", reason: "too_large" }
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch {
    return { state: "skipped", reason: "unreadable" }
  }
  if (bytes.length > budget) return { state: "skipped", reason: "too_large" }
  if (!allowBinary && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { state: "skipped", reason: "binary" }
  return { state: "content", content: bytes, mode: stat.mode & 0o777 }
}

/** Puts a file in a state: its bytes (parents created, the mode kept on a new file) or gone. Throws on an I/O error. */
export function writeFileState(file: string, state: { state: "content"; content: Uint8Array; mode?: number } | { state: "absent" }) {
  if (state.state === "absent") return rmSync(file, { force: true })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, state.content)
  if (state.mode !== undefined) chmodSync(file, state.mode)
}

export type TurnSnapshots = ReturnType<typeof createTurnSnapshots>

/**
 * Bounded per-turn file snapshots (docs/sessions.md): before a turn's first write/edit/apply_patch touches a file its
 * content is kept (or `absent` when the turn creates it), up to TURN_SNAPSHOT_MAX_BYTES of content per turn; binary and
 * over-budget files are noted as skipped, never stored. When the turn ends `seal` records each file's state then, which
 * lets undo tell the turn's own change from a later edit and lets redo re-apply it.
 */
export function createTurnSnapshots(input: { store: Store; maxBytes?: number }) {
  const { store } = input
  const maxBytes = input.maxBytes ?? TURN_SNAPSHOT_MAX_BYTES
  return {
    begin(sessionId: SessionId, turnId: string, cwd: string) {
      cwd = canonicalDirectory(cwd)
      const settings = store.settings.get()
      if (settings.snapshot === false) return store.turns.snapshots.put(sessionId, turnId, { root: cwd, scope: "off", complete: false, sealed: false })
      const inventory = settings.snapshotScope === "worktree" ? worktreeFiles(cwd) : undefined
      if (!inventory) return store.turns.snapshots.put(sessionId, turnId, { root: cwd, scope: "tools", complete: false, sealed: false })
      let left = WORKTREE_SNAPSHOT_MAX_BYTES
      let complete = inventory.complete
      for (const file of inventory.files) {
        const state = readFileState(file, Math.min(left, WORKTREE_FILE_MAX_BYTES), true)
        if (state.state === "content") left -= state.content.length
        if (state.state === "skipped") complete = false
        store.turns.files.captureBefore(sessionId, turnId, file, state)
      }
      store.turns.snapshots.put(sessionId, turnId, { root: inventory.root, scope: "worktree", paths: inventory.files, complete, sealed: false })
    },
    /** Call right before a tool call runs (after approval). Files already held for the turn keep their first state. */
    capture({ sessionId, turnId, cwd, tool, args, itemId }: { sessionId: SessionId; turnId: string; cwd: string; tool: string; args: Record<string, unknown>; itemId?: string | undefined }) {
      const scope = store.turns.snapshots.get(sessionId, turnId)?.scope
      if (store.settings.get().snapshot === false || scope === "off") return
      if (!SNAPSHOT_TOOLS.has(tool)) return
      for (const file of pathsOfToolCall({ tool, args, cwd })) {
        // The state before this call, kept apart from the turn's first state so one part can be reverted alone (session.undo atPartId).
        if (itemId) store.turns.calls.capture(sessionId, turnId, itemId, file, readFileState(file, Math.max(0, maxBytes - store.turns.calls.usedBytes(sessionId, turnId))))
        if (scope === "worktree" || store.turns.files.has(sessionId, turnId, file)) continue
        const left = Math.max(0, maxBytes - store.turns.files.usedBytes(sessionId, turnId))
        store.turns.files.captureBefore(sessionId, turnId, file, readFileState(file, left))
      }
    },
    /** Records the state of every snapshotted file of the turn that has none yet (the turn ended, or an undo is about to change them). */
    seal(sessionId: SessionId, turnId: string) {
      const record = store.turns.snapshots.get(sessionId, turnId)
      if (record?.sealed) return
      let complete = record?.complete ?? false
      if (record?.scope === "worktree") {
        const inventory = worktreeFiles(record.root)
        if (!inventory) complete = false
        else {
          complete &&= inventory.complete
          const before = new Set(record.paths)
          // A truncated starting inventory cannot tell a new file from an old path beyond its cap.
          if (record.paths && record.paths.length < 10_000) for (const file of inventory.files) if (!before.has(file)) store.turns.files.captureBefore(sessionId, turnId, file, { state: "absent" })
        }
      }
      let left = record?.scope === "worktree" ? WORKTREE_SNAPSHOT_MAX_BYTES : maxBytes
      for (const snapshot of store.turns.files.list(sessionId, turnId)) {
        if (snapshot.after) continue
        const state = readFileState(snapshot.path, Math.min(left, record?.scope === "worktree" ? WORKTREE_FILE_MAX_BYTES : maxBytes), record?.scope === "worktree")
        if (state.state === "content") left -= state.content.length
        if (record?.scope === "worktree" && equalFileStates(snapshot.before, state)) {
          store.turns.files.drop(sessionId, turnId, snapshot.path)
          continue
        }
        store.turns.files.seal(sessionId, turnId, snapshot.path, state)
      }
      const root = record?.root ?? canonicalDirectory(store.sessionDirectory(sessionId) ?? "")
      const summary = summarizeSnapshots(root, store.turns.files.list(sessionId, turnId), complete)
      store.turns.snapshots.put(sessionId, turnId, { root, scope: record?.scope ?? "tools", complete: summary.complete === true, sealed: true, summary })
    },
  }
}

/**
 * The engine hooks with snapshot capture added: a `tool.before` handler that runs after the extensions' own (so a blocked
 * call is not captured and a rewritten path is the one kept). Adds one awaited call per tool call; never fails a tool.
 */
export function withTurnSnapshots(inner: EngineHooks, snapshots: TurnSnapshots): EngineHooks {
  return {
    ...inner,
    has: (hook, cwd) => hook === "tool.before" || inner.has(hook, cwd),
    async toolBefore(event) {
      const verdict = inner.has("tool.before", event.cwd) && inner.toolBefore ? await inner.toolBefore(event) : undefined
      if (verdict?.block === undefined && SNAPSHOT_TOOLS.has(event.tool)) {
        try {
          snapshots.capture({ sessionId: event.sessionId, turnId: event.turnId, cwd: event.cwd, tool: event.tool, args: verdict?.args ?? event.args, itemId: event.itemId })
        } catch {
          // A snapshot that cannot be kept only means the undo will not restore that file; the tool still runs.
        }
      }
      return verdict
    },
  }
}
