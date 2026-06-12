export type WorktreeOwnership = "owned" | "adopted" | "external" | "stale" | "drifted"

export type WorktreeExecutor = "native" | "tsm"

export type WorktreeCleanupPolicy = "archive-first" | "remove-when-clean" | "manual-only"

export type WorktreeMflowMode = "off" | "lock-only" | "live-sync" | "unknown"

export type WorktreeDirtyState = {
  checkedAt: string
  clean: boolean
  summary: string
}

export type WorktreeSessionRef = {
  tool: "mend" | "tsm"
  id: string
  lastSeenAt: string
}

export type WorktreePackageProjection = {
  id: string
  version?: string
}

export type WorktreeCreationPlan = {
  commands: string[]
  writes: string[]
  note?: string
}

export type WorktreePassport = {
  creator: "mendcode" | "user-adopted"
  repoRoot: string
  path: string
  branch: string | null
  baseRef: string | null
  executor: WorktreeExecutor
  sessions: WorktreeSessionRef[]
  packages: WorktreePackageProjection[]
  mflowMode: WorktreeMflowMode
  creationPlan: WorktreeCreationPlan
  cleanupPolicy: WorktreeCleanupPolicy
}

export type WorktreeRecord = WorktreePassport & {
  id: string
  ownership: WorktreeOwnership
  dirty: WorktreeDirtyState
  lastReconciledAt: string | null
  drift: string[]
  createdAt: string
  updatedAt: string
}

export type WorktreeManagerState = {
  version: 1
  branchPrefix: string
  defaultExecutor: WorktreeExecutor
  worktrees: Record<string, WorktreeRecord>
  operations: Record<string, WorktreeOperationRecord>
  updatedAt: string
}

export type WorktreeOperationKind = "create" | "open" | "adopt" | "remove" | "reset" | "prune"

export type WorktreeOperationStatus = "pending" | "complete" | "failed" | "needs_recovery"

export type WorktreeOperationRecord = {
  id: string
  kind: WorktreeOperationKind
  target: string
  status: WorktreeOperationStatus
  preview: WorktreePreview
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  error: string | null
  recovery: string[]
}

export type WorktreePreviewCommand = {
  tool: "git" | "tsm" | "mend"
  argv: string[]
  cwd?: string
  destructive: boolean
}

export type WorktreeStateWrite = {
  path: string
  action: "create" | "update" | "delete"
}

export type WorktreePreview = {
  action: WorktreeOperationKind
  target: {
    id?: string
    path: string
    branch: string | null
    baseRef?: string | null
  }
  ownership: WorktreeOwnership
  executor: WorktreeExecutor
  dirty: WorktreeDirtyState
  sessions: WorktreeSessionRef[]
  commands: WorktreePreviewCommand[]
  stateWrites: WorktreeStateWrite[]
  recoveryRecordPath: string
  blocked: boolean
  blockReasons: string[]
  forceConfirmation: string | null
}

export type GitWorktreeEntry = {
  path: string
  branch: string | null
}

export type WorktreeReconciliation = {
  records: WorktreeRecord[]
  external: GitWorktreeEntry[]
  stale: WorktreeRecord[]
  drifted: WorktreeRecord[]
}
