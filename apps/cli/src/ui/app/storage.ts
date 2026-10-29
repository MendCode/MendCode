import { formatBytes, storageConfirmClean, storageNote } from "../lazy-pages"
import type { Settings, StorageCleanResult, StorageReport } from "@mendcode/protocol"
import type { StoragePageAction } from "../../view/storage-page"
import type { AppContext } from "./context"

export function createStorage(ctx: AppContext) {
  const { input, state, requestFrame } = ctx

  async function loadStorage() {
    const [reply, settings] = await Promise.all([input.send({ type: "storage.report" }), input.send({ type: "settings.get" })])
    if (reply.ok) {
      state.storageReport = reply.result as StorageReport
      state.storageError = ""
    } else state.storageError = reply.error.code === "invalid_command" ? "the daemon is older than this terminal; restart it" : reply.error.message
    state.storageRetention = settings.ok ? (settings.result?.settings as Settings | undefined)?.retentionDays : undefined
    state.storageWorktreeGc = settings.ok ? (settings.result?.settings as Settings | undefined)?.worktreeGcDays : undefined
    requestFrame()
  }

  /** Every cleaning previews with a dry run: the numbers shown are the daemon's own, then `y` runs it for real. */
  const worktreeRequest = () => ({ worktrees: true as const, ...(state.storageWorktreeGc ? { worktreeIdleDays: state.storageWorktreeGc } : {}) })
  async function previewPass(request: { compact?: true; worktrees?: true; worktreeIdleDays?: number }, confirm: (dry: StorageCleanResult) => ReturnType<typeof storageConfirmClean> | undefined, nothing: string) {
    const reply = await input.send({ type: "storage.clean", olderThanDays: 0, dryRun: true, ...request })
    if (!reply.ok) state.storageState = storageNote(state.storageState, reply.error.message)
    else state.storageState = confirm(reply.result as unknown as StorageCleanResult) ?? storageNote({}, nothing)
    requestFrame()
  }

  /** Clean is always previewed with a dry run first; the user confirms the numbers, then it runs for real. */
  async function storageAction(action: StoragePageAction) {
    if (action.type === "refresh") return loadStorage()
    if (action.type === "previewClean") {
      const days = state.storageRetention ?? 90
      const reply = await input.send({ type: "storage.clean", olderThanDays: days, dryRun: true })
      if (!reply.ok) state.storageState = storageNote(state.storageState, reply.error.message)
      else {
        const dry = reply.result as unknown as StorageCleanResult
        state.storageState = dry.sessionsRemoved + dry.blobsRemoved + (dry.goalFilesRemoved ?? 0) === 0 ? storageNote({}, `nothing older than ${days} days to remove`) : storageConfirmClean({ kind: "clean", days, sessions: dry.sessionsRemoved, bytes: dry.bytesReclaimed, ...(dry.goalFilesRemoved ? { goalFiles: dry.goalFilesRemoved } : {}) })
      }
      return requestFrame()
    }
    if (action.type === "previewCompact") return previewPass({ compact: true }, (dry) => ((dry.compactedRows ?? 0) + (dry.deltaEventsRemoved ?? 0) === 0 ? undefined : storageConfirmClean({ kind: "compact", rows: dry.compactedRows ?? 0, deltas: dry.deltaEventsRemoved ?? 0 })), "nothing to pack: older data is already compact")
    if (action.type === "previewWorktrees") return previewPass(worktreeRequest(),(dry) => ((dry.worktreesRemoved ?? 0) === 0 ? undefined : storageConfirmClean({ kind: "worktrees", removed: dry.worktreesRemoved ?? 0, bytes: dry.worktreeBytes ?? 0 })), "no merged, clean, unused worktrees to remove")
    if (action.type === "compact" || action.type === "worktrees") {
      state.storageState = storageNote({}, action.type === "compact" ? "packing…" : "removing worktrees…")
      requestFrame()
      const reply = await input.send({ type: "storage.clean", olderThanDays: 0, ...(action.type === "compact" ? { compact: true } : worktreeRequest()) })
      const done = reply.ok ? (reply.result as unknown as StorageCleanResult) : undefined
      state.storageState = storageNote({}, done ? (action.type === "compact" ? `packed ${formatBytes(done.bytesReclaimed)} freed · ${done.compactedRows ?? 0} rows${done.compactComplete === false ? " · more remain, press z again" : ""}` : `removed ${done.worktreesRemoved ?? 0} worktrees/trash · ${formatBytes(done.worktreeBytes ?? 0)}`) : reply.ok ? "" : reply.error.message)
      await loadStorage()
      return
    }
    if (action.type === "clean" || action.type === "vacuum") {
      state.storageState = storageNote({}, action.type === "vacuum" ? "vacuuming…" : "cleaning…")
      requestFrame()
      const reply = await input.send({ type: "storage.clean", olderThanDays: action.type === "clean" ? action.days : 0, ...(action.type === "vacuum" ? { vacuum: true } : {}) })
      const done = reply.ok ? (reply.result as unknown as StorageCleanResult) : undefined
      state.storageState = storageNote({}, done ? `removed ${done.sessionsRemoved} sessions${done.goalFilesRemoved ? ` · ${done.goalFilesRemoved} goal files` : ""} · freed ${formatBytes(done.bytesReclaimed)}${done.vacuumed ? " · vacuumed" : ""}` : reply.ok ? "" : reply.error.message)
      await loadStorage()
    }
  }

  return { loadStorage, storageAction }
}
