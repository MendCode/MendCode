export type SessionMessageOrderable = {
  id: string
  time: {
    created: number
  }
}

export type SessionCompactionBoundaryMessage = SessionMessageOrderable & {
  role: string
  summary?: unknown
  time: SessionMessageOrderable["time"] & {
    completed?: number
  }
}

export function compareSessionMessages(a: SessionMessageOrderable, b: SessionMessageOrderable) {
  const created = a.time.created - b.time.created
  if (created !== 0) return created
  return a.id.localeCompare(b.id)
}

export function sortSessionMessages<T extends SessionMessageOrderable>(messages: readonly T[]) {
  return [...messages].sort(compareSessionMessages)
}

export function isSessionMessageAfter(a: SessionMessageOrderable, b: SessionMessageOrderable) {
  return compareSessionMessages(a, b) > 0
}

export function isSessionMessageBefore(a: SessionMessageOrderable, b: SessionMessageOrderable) {
  return compareSessionMessages(a, b) < 0
}

export function latestCompletedCompactionSummaryID(messages: readonly SessionCompactionBoundaryMessage[]) {
  return sortSessionMessages(messages).findLast(
    (message) => message.role === "assistant" && message.summary === true && message.time.completed !== undefined,
  )?.id
}

export * as SessionMessageOrder from "./session-message-order"
