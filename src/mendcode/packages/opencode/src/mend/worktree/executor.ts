import type { WorktreePreview, WorktreeRecord } from "./types"

export type WorktreeExecutorPlan = {
  executor: "native" | "tsm"
  preview: WorktreePreview
  allowed: boolean
  reasons: string[]
}

export type WorktreeExecutorAdapter = {
  readonly name: "native" | "tsm"
  readonly planOpen: (record: WorktreeRecord) => Promise<WorktreeExecutorPlan> | WorktreeExecutorPlan
  readonly planCreate: (record: WorktreeRecord) => Promise<WorktreeExecutorPlan> | WorktreeExecutorPlan
}
