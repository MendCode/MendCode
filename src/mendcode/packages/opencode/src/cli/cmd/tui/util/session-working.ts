export const RECENT_WORKING_ASSISTANT_WINDOW_MS = 30_000
export const STALE_BUSY_SESSION_WINDOW_MS = 60_000
export const SESSION_STOPPED_CONNECTION_MESSAGE = "agent stopped: local server connection lost"

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
  now?: number
  assistantCreated?: number
  statusUntil?: number
  statusNext?: number
}) {
  const now = input.now ?? Date.now()
  if (input.statusType === "busy") {
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

export function sessionStatusExpiryDelay(status: TuiSessionStatus, now = Date.now()) {
  if (status.type === "busy") {
    const expiry = typeof status.until === "number" && status.until > now ? status.until : now + STALE_BUSY_SESSION_WINDOW_MS
    return Math.max(1, expiry - now + 1)
  }
  if (status.type === "retry" && status.next > now) return Math.max(1, status.next - now + 1)
  return undefined
}
