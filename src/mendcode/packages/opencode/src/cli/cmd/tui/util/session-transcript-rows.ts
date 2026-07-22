export type SessionTranscriptMessage = {
  id: string
}

export function sessionTranscriptRows<T extends SessionTranscriptMessage>(
  messages: readonly T[],
  queuedIDs: ReadonlySet<string>,
) {
  const unique = [...new Map(messages.map((message) => [message.id, message] as const)).values()]
  const transcript = unique.filter((message) => !queuedIDs.has(message.id))
  const queued = unique.filter((message) => queuedIDs.has(message.id))
  return [...transcript, ...queued]
}

export * as SessionTranscriptRows from "./session-transcript-rows"
