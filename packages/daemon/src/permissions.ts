import type { PermissionsStatusReport, Settings } from "@mendcode/protocol"

export function permissionsStatus(settings: Settings): PermissionsStatusReport {
  const mode = settings.defaultPermission ?? "ask"
  return {
    mode: mode === "ask" ? "approval" : mode === "full" ? "full_access" : mode,
    defaultPermission: mode,
    reviewerRole: settings.permissionReviewerRole ?? "permissionReviewer",
    permission: settings.permission ?? {},
    tools: settings.tools ?? {},
    primaryTools: settings.experimental?.primary_tools ?? [],
    continueLoopOnDeny: settings.experimental?.continue_loop_on_deny === true,
  }
}
