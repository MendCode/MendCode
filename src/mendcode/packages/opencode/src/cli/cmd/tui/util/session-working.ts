export const RECENT_WORKING_ASSISTANT_WINDOW_MS = 30_000
export const STALE_BUSY_SESSION_WINDOW_MS = 60_000
export const SESSION_STOPPED_CONNECTION_MESSAGE = "agent stopped: local server connection lost"

export function shouldShowSessionStoppedConnection(input: {
  connectionStatus: string
  hasOrphanedAssistant: boolean
}) {
  return input.connectionStatus !== "connected" && input.hasOrphanedAssistant
}

type TuiSessionStatus =
  | { type: "idle" }
  | { type: "busy"; until?: number }
  | { type: "retry"; attempt?: number; message?: string; next: number }

function lastActivityTime(...values: Array<number | undefined>) {
  return values
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item > 0)
    .toSorted((a, b) => b - a)[0]
}

export function isRecentWorkingAssistant(input: {
  now?: number
  assistantCreated?: number
  sessionUpdated?: number
  windowMs?: number
}) {
  const now = input.now ?? Date.now()
  const windowMs = input.windowMs ?? RECENT_WORKING_ASSISTANT_WINDOW_MS
  const lastAssistantActivity = lastActivityTime(input.assistantCreated)
  if (!lastAssistantActivity) return false
  return now - lastAssistantActivity <= windowMs
}

export function isAssistantWorking(input: {
  statusType?: string
  statusKind?: string
  now?: number
  assistantCreated?: number
  statusUntil?: number
  statusNext?: number
}) {
  const now = input.now ?? Date.now()
  if (input.statusType === "busy") {
    if (input.statusKind === "compaction") return true
    return !isStaleBusySession({
      statusType: input.statusType,
      now,
      assistantCreated: input.assistantCreated,
      statusUntil: input.statusUntil,
    })
  }
  if (input.statusType === "retry") return typeof input.statusNext !== "number" || input.statusNext > now
  return isRecentWorkingAssistant({ now, assistantCreated: input.assistantCreated })
}

export function isBusyStatusSupersededByTerminalAssistant(input: {
  statusType?: string
  statusKind?: string
  statusStartedAt?: number
  latestMessage?: {
    role: string
    finish?: string
    error?: unknown
    time: { created?: number; completed?: number }
  }
}) {
  if (input.statusType !== "busy" || input.statusKind === "compaction") return false
  const message = input.latestMessage
  if (!message || message.role !== "assistant") return false
  const terminalFinish = Boolean(message.finish && !["tool-calls", "unknown"].includes(message.finish))
  if (!terminalFinish && !message.error) return false
  const terminalAt = message.time.completed ?? message.time.created
  if (typeof input.statusStartedAt !== "number" || typeof terminalAt !== "number") return false
  return input.statusStartedAt <= terminalAt
}

export function isStaleBusySession(input: {
  statusType: string
  now?: number
  assistantCreated?: number
  sessionUpdated?: number
  statusUntil?: number
  staleMs?: number
}) {
  if (input.statusType !== "busy") return false
  const now = input.now ?? Date.now()
  if (typeof input.statusUntil === "number" && input.statusUntil > now) return false
  const lastAssistantActivity = lastActivityTime(input.assistantCreated)
  if (!lastAssistantActivity) return false
  return now - lastAssistantActivity > (input.staleMs ?? STALE_BUSY_SESSION_WINDOW_MS)
}

export function sessionStatusExpiryDelay(
  status: TuiSessionStatus,
  now = Date.now(),
  source: "snapshot" | "live" = "snapshot",
) {
  if (status.type === "busy") {
    if (source === "live" && status.until === undefined) return undefined
    const expiry = typeof status.until === "number" && status.until > now ? status.until : now + STALE_BUSY_SESSION_WINDOW_MS
    return Math.max(1, expiry - now + 1)
  }
  if (status.type === "retry" && status.next > now) return Math.max(1, status.next - now + 1)
  return undefined
}

export function isToolActivityActive(input: {
  toolStatus?: string
  sessionStatusType?: string
  interrupted?: boolean
  activityOverride?: boolean
}) {
  if (input.activityOverride) return true
  if (input.interrupted) return false
  if (input.toolStatus !== "pending" && input.toolStatus !== "running") return false
  return input.sessionStatusType === "busy" || input.sessionStatusType === "retry"
}

export function isSubagentStatusActive(status: string) {
  return status === "working" || status === "waiting" || status === "needs input" || status.startsWith("retry")
}

export function shouldKeepCompactedSubagent(input: { compacted?: boolean; status: string }) {
  return !input.compacted || isSubagentStatusActive(input.status)
}
