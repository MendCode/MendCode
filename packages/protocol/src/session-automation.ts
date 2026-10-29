import type { SessionId } from "./ids"
import type { HistoryReport, ModelChoice, SessionSummary } from "./queries"
import type { SessionEvent } from "./events"
import type { Loop } from "./loops"
import type { TaskRecord } from "./tasks"
import type { PermissionMode } from "./states"

export type SessionDetail = SessionSummary & {
  parentId?: SessionId
  agent?: string
  model?: ModelChoice
  permission: PermissionMode
  status: string
}

export type SessionInspection = {
  session: SessionDetail
  state: string
  messages: HistoryReport
  children: SessionDetail[]
  subagents: TaskRecord[]
  loops: Loop[]
  pending: { questions: SessionEvent[]; permissions: SessionEvent[]; planReviews: SessionEvent[] }
  events: SessionEvent[]
  diff: Array<{ path: string; before: string; after?: string; patch?: string; truncated?: boolean }>
  truncated: boolean
}
