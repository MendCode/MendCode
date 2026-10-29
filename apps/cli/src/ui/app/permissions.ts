import { createPermissionsPageState } from "../lazy-pages"
import type { PermissionGrant } from "@mendcode/protocol"
import type { ModelsReport } from "@mendcode/protocol"
import type { AppContext } from "./context"

export function createPermissions(ctx: AppContext) {
  const { input, state, requestFrame, report } = ctx

  async function loadPermissions() {
    const [grants, models, settings, history] = await Promise.all([
      state.sessionId ? input.send({ type: "permissions.list", sessionId: state.sessionId }) : Promise.resolve(undefined),
      input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }),
      input.send({ type: "settings.get" }),
      state.sessionId ? input.send({ type: "permissions.history", sessionId: state.sessionId }) : Promise.resolve(undefined),
    ])
    if (settings.ok && settings.result?.settings) state.settingsNow = settings.result.settings as import("@mendcode/protocol").Settings
    if (!grants) [state.permissionGrants, state.permissionGrantsError] = [[], ""]
    else if (grants.ok) [state.permissionGrants, state.permissionGrantsError] = [(grants.result?.grants ?? []) as PermissionGrant[], ""]
    else state.permissionGrantsError = grants.error.message.replace(/^\[[A-Z]+\]: /, "")
    if (history?.ok) {
      state.permissionHistory = (history.result ?? { grants: [], reviews: [] }) as import("@mendcode/protocol").PermissionsHistoryReport
      state.permissionHistoryError = ""
      state.permissionsState = { ...state.permissionsState, historyCount: state.permissionHistory.reviews?.length ?? 0 }
    } else if (history) state.permissionHistoryError = history.error.message.replace(/^\[[A-Z]+\]: /, "")
    if (models.ok) [state.permissionsModels, state.permissionsModelsError] = [models.result as ModelsReport, ""]
    else state.permissionsModelsError = models.error.message.replace(/^\[[A-Z]+\]: /, "")
    state.permissionsState = { ...state.permissionsState, selected: Math.max(0, Math.min(state.permissionsState.selected, (state.permissionGrants?.length ?? 1) - 1)) }
    requestFrame()
  }

  async function openPermissions() {
    state.page = "permissions"
    state.permissionsState = createPermissionsPageState()
    state.permissionGrants = undefined
    state.permissionGrantsError = ""
    delete state.permissionHistory
    state.permissionHistoryError = ""
    state.permissionsModels = undefined
    state.permissionsModelsError = ""
    requestFrame()
    await loadPermissions()
  }

  async function revokeGrant(grantId: string) {
    if (!state.sessionId) return
    const reply = await input.send({ type: "permissions.revoke", sessionId: state.sessionId, grantId })
    report(reply)
    await loadPermissions()
  }

  /** `/approve`: lets the call the permission reviewer last denied run once on its next try (the daemon keeps it for ten minutes). */
  async function approveRetry() {
    if (!state.sessionId) {
      state.notice = "no session"
      return
    }
    const reply = await input.send({ type: "permissions.retry", sessionId: state.sessionId })
    if (!reply.ok) {
      state.notice = reply.error.message.replace(/^\[[A-Z]+\]: /, "")
      return
    }
    const result = reply.result as { tool?: string; summary?: string } | undefined
    state.notice = `retry approved for ${result?.summary || result?.tool || "the denied call"} · tell the agent to try again`
  }

  return { openPermissions, revokeGrant, approveRetry }
}
