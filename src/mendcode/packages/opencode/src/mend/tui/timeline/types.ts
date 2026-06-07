export type TimelineRenderProfile = "raw" | "minimal" | "mendcode"

export type TimelineToolClass =
  | "simple-read"
  | "web"
  | "artifact"
  | "command"
  | "planning"
  | "interaction"
  | "failure"
  | "generic"

export type TimelineToolState = "pending" | "running" | "completed" | "error" | string

export type TimelineToolEvent = {
  type: "tool"
  tool: string
  class: TimelineToolClass
  state: TimelineToolState
  input: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: unknown
  title: string
  lines: string[]
  result?: string
}

export type TimelineRow = {
  type: "row"
  id: string
  state: TimelineToolState
  title: string
  tool?: string
  class?: TimelineToolClass
}

export type TimelineCollapse = {
  type: "collapse"
  id: string
  count: number
}

export type TimelineEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; completed: boolean }
  | TimelineToolEvent
  | { type: "metadata"; label: string; value?: string }
