export const RECENT_WORKING_ASSISTANT_WINDOW_MS = 30_000
export const STALE_BUSY_SESSION_WINDOW_MS = 60_000
export const SESSION_AGENT_STATE_UNKNOWN_MESSAGE = "agent state unknown"

export function displayConnectionStatus<T extends string>(input: { status: T; recoveringSince?: number }): T {
  // Snapshot reconciliation can outlive a healthy SSE connection. Keep that
  // safety marker internal instead of telling the user the transport was lost.
  return input.status
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
  if (input.connectionStatus === "connecting") return "Connecting to backend…"
  if (input.connectionStatus !== "reconnecting") return
  const attempt = input.attempt && input.attempt > 1 ? ` (#${input.attempt})` : ""
  return `Reconnecting to backend…${attempt}`
}

export function retryStatusMessage(message?: string) {
  const value = message?.trim()
  return value ? `Retrying provider… ${value}` : "Retrying provider…"
}

type TuiSessionStatus =
  | { type: "idle" }
  | { type: "busy"; until?: number }
  | { type: "retry"; attempt?: number; message?: string; next: number; heartbeatAt?: number }

type ActivityAssistantMessage = {
  id?: string
  parentID?: string
  role: string
  finish?: string
  error?: unknown
  time: { created?: number; completed?: number }
}

type ActivityUserMessage = {
  id?: string
  role: string
  time: { created?: number }
}

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
  statusHeartbeatAt?: number
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
      statusHeartbeatAt: input.statusHeartbeatAt,
      statusUntil: input.statusUntil,
    })
  }
  if (input.statusType === "retry") {
    if (typeof input.statusNext !== "number" || input.statusNext > now) return true
    return typeof input.statusHeartbeatAt === "number" && now - input.statusHeartbeatAt <= STALE_BUSY_SESSION_WINDOW_MS
  }
  return isRecentWorkingAssistant({ now, assistantCreated: input.assistantCreated })
}

export function terminalAssistantSettlesLatestTurn(input: {
  latestMessage?: ActivityAssistantMessage
  latestUser?: ActivityUserMessage
  hasActiveTool?: boolean
}) {
  const message = input.latestMessage
  if (!message || message.role !== "assistant") return false
  const continuation = message.finish === "tool-calls" || message.finish === "unknown"
  const explicitTerminal = Boolean(message.error || (message.finish && !continuation))
  // Direct shell turns can persist their completed timestamp before a finish
  // reason is available. This is also the durable receipt left by an aborted
  // tool run, whose output contains "User aborted the command" but whose
  // assistant message may not carry an error or finish field in the TUI
  // snapshot. A completed non-continuation assistant is terminal evidence;
  // tool-calls/unknown remain live continuations until their next step settles.
  const completedWithoutContinuation = message.time.completed !== undefined && !continuation
  if (!explicitTerminal && !completedWithoutContinuation) return false
  // An explicit finish/error is authoritative over a residual pending tool
  // part. Without that explicit receipt, keep the tool alive: a completed
  // tool-call step may still be waiting for its next assistant step.
  if (input.hasActiveTool && !explicitTerminal) return false
  const terminalAt = message.time.completed ?? message.time.created
  if (typeof terminalAt !== "number") return false

  const latestUser = input.latestUser
  if (!latestUser) return true
  if (message.parentID && latestUser.id) return message.parentID === latestUser.id
  const latestUserAt = latestUser.time.created
  return typeof latestUserAt === "number" && latestUserAt <= terminalAt
}

export function isBusyStatusSupersededByTerminalAssistant(input: {
  statusType?: string
  statusKind?: string
  statusStartedAt?: number
  latestMessage?: ActivityAssistantMessage
  latestUser?: ActivityUserMessage
  hasActiveTool?: boolean
}) {
  if ((input.statusType !== "busy" && input.statusType !== "retry") || input.statusKind === "compaction") return false
  if (!terminalAssistantSettlesLatestTurn(input)) return false
  const terminalAt = input.latestMessage?.time.completed ?? input.latestMessage?.time.created
  if (typeof terminalAt !== "number") return false
  // Older/status-recovered sessions may not carry startedAt. Once the latest
  // assistant is durably terminal, a stale busy flag must not keep the TUI in
  // Generating forever. A latest user/assistant parent match is stronger than
  // a reconstructed startedAt: it proves no newer user turn owns that status.
  if (typeof input.statusStartedAt !== "number")
    return true
  return input.latestUser !== undefined || input.statusStartedAt <= terminalAt
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
  latestUser?: Parameters<typeof isBusyStatusSupersededByTerminalAssistant>[0]["latestUser"]
  hasActiveTool?: boolean
}) {
  return isBusyStatusSupersededByTerminalAssistant(input)
}

export function isStaleBusySession(input: {
  statusType: string
  now?: number
  assistantCreated?: number
  statusHeartbeatAt?: number
  sessionUpdated?: number
  statusUntil?: number
  staleMs?: number
}) {
  if (input.statusType !== "busy") return false
  const now = input.now ?? Date.now()
  if (typeof input.statusUntil === "number" && input.statusUntil > now) return false
  const lastAssistantActivity = lastActivityTime(input.assistantCreated, input.statusHeartbeatAt)
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
    const expiry =
      typeof status.until === "number" && status.until > now ? status.until : now + STALE_BUSY_SESSION_WINDOW_MS
    return Math.max(1, expiry - now + 1)
  }
  if (status.type === "retry") {
    const heartbeatExpiry =
      typeof status.heartbeatAt === "number" ? status.heartbeatAt + STALE_BUSY_SESSION_WINDOW_MS : undefined
    const expiry = Math.max(status.next, heartbeatExpiry ?? status.next)
    return expiry > now ? Math.max(1, expiry - now + 1) : undefined
  }
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
