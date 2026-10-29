export const TSM_ACTIONS = [
  { id: "status", title: "Status", note: "Binary and worktree capability" },
  { id: "workspace", title: "Current workspace", note: "Branch, checkout and state location" },
  { id: "details", title: "Show details", note: "Adapter, policy and managed files" },
  { id: "plan", title: "Setup plan", note: "Save install/setup commands as a dry-run" },
  { id: "setup", title: "Refresh setup plan", note: "Refresh the saved dry-run" },
  { id: "activate", title: "Activate", note: "Requires a worktree-capable binary" },
  { id: "deactivate", title: "Deactivate", note: "Disable delegation; keep sessions" },
  { id: "remove", title: "Remove scaffold", note: "Recycle MendCode state and plan" },
  { id: "doctor", title: "Doctor", note: "Check Git, adapter and sync policy" },
  { id: "open", title: "Open workspace preview", note: "Preview TSM command for this checkout" },
] as const
