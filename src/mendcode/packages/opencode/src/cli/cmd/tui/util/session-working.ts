export const RECENT_WORKING_ASSISTANT_WINDOW_MS = 30_000
export const STALE_BUSY_SESSION_WINDOW_MS = 60_000
export const SESSION_AGENT_STATE_UNKNOWN_MESSAGE = "agent state unknown"

export function displayConnectionStatus(input: { status: string; recoveringSince?: number }) {
  return input.status === "connected" && input.recoveringSince !== undefined ? "reconnecting" : input.status
}

export function shouldShowAgentStateUnknown(input: {
  connectionStatus: string
  hasUncertainAgentState: boolean
  hasKnownAgentActivity?: boolean
}) {
  if (
    input.hasKnownAgentActivity &&
    (input.connectionStatus === "connecting" || input.connectionStatus === "reconnecting")
  )
    return false
  return input.connectionStatus !== "connected" && input.hasUncertainAgentState
}

export function knownAgentActivityConnectionLabel(input: {
  connectionStatus: string
  hasKnownAgentActivity: boolean
  attempt?: number
}) {
  if (!input.hasKnownAgentActivity) return
  if (input.connectionStatus === "connecting") return "connecting transport..."
  if (input.connectionStatus !== "reconnecting") return
  const attempt = input.attempt && input.attempt > 1 ? ` #${input.attempt}` : ""
  return `syncing connection${attempt}...`
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
  hasActiveTool?: boolean
}) {
  const now = input.now ?? Date.now()
  if (input.statusType === "busy") {
    if (input.statusKind === "compaction") return true
    if (input.hasActiveTool) return true
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
  if ((input.statusType !== "busy" && input.statusType !== "retry") || input.statusKind === "compaction") return false
  const message = input.latestMessage
  if (!message || message.role !== "assistant") return false
  const continuation = message.finish === "tool-calls" || message.finish === "unknown"
  const terminalFinish = Boolean(message.finish && !continuation)
  // Direct shell turns can persist their completed timestamp before a finish
  // reason is available. This is also the durable receipt left by an aborted
  // tool run, whose output contains "User aborted the command" but whose
  // assistant message may not carry an error or finish field in the TUI
  // snapshot. A completed non-continuation assistant is terminal evidence;
  // tool-calls/unknown remain live continuations until their next step settles.
  const completedWithoutContinuation = message.time.completed !== undefined && !continuation
  if (!terminalFinish && !message.error && !completedWithoutContinuation) return false
  const terminalAt = message.time.completed ?? message.time.created
  if (typeof terminalAt !== "number") return false
  // Older/status-recovered sessions may not carry startedAt. Once the latest
  // assistant is durably terminal, a stale busy flag must not keep the TUI in
  // Generating forever. When startedAt exists, retain the ordering guard so a
  // newer turn is never hidden by an older terminal response.
  if (typeof input.statusStartedAt !== "number") return Boolean(message.time.completed || terminalFinish || message.error)
  return input.statusStartedAt <= terminalAt
}

/**
 * A terminal assistant is authoritative over stale transport/recovery labels,
 * but only when its own tool stream has no pending/running work left.
 */
export function terminalAssistantSettlesActivity(input: {
  statusType?: string
  statusKind?: string
  statusStartedAt?: number
  latestMessage?: Parameters<typeof isBusyStatusSupersededByTerminalAssistant>[0]["latestMessage"]
  hasActiveTool?: boolean
}) {
  if (input.hasActiveTool) return false
  return isBusyStatusSupersededByTerminalAssistant(input)
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
