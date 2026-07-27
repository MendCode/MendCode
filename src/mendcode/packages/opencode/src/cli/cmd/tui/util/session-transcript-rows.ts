export type SessionTranscriptMessage = {
  id: string
  role?: string
  parentID?: string
}

export function sessionTranscriptRows<T extends SessionTranscriptMessage>(
  messages: readonly T[],
  queuedIDs: ReadonlySet<string>,
  options: { boundaryIDs?: ReadonlySet<string> } = {},
) {
  const unique = [...new Map(messages.map((message) => [message.id, message] as const)).values()]
  const positions = new Map(unique.map((message, index) => [message.id, index] as const))
  const boundaryPrefix = unique.reduce<number[]>((prefix, message, index) => {
    prefix.push(prefix[index] + (options.boundaryIDs?.has(message.id) ? 1 : 0))
    return prefix
  }, [0])
  const childrenByParent = new Map<string, T[]>()
  const groupedChildIDs = new Set<string>()

  for (const [index, message] of unique.entries()) {
    if (message.role !== "assistant" || !message.parentID) continue
    const parent = unique[positions.get(message.parentID) ?? -1]
    const parentIndex = positions.get(message.parentID)
    if (parent?.role !== "user" || parentIndex === undefined) continue
    // Queueing can place a later user before another assistant iteration, so keep
    // those assistant children with their parent. A compaction user is a hard
    // transcript boundary: follow-up assistants may still retain the old parent,
    // but must remain after the compaction summary.
    if (boundaryPrefix[index] !== boundaryPrefix[parentIndex + 1]) continue
    const children = childrenByParent.get(message.parentID) ?? []
    children.push(message)
    childrenByParent.set(message.parentID, children)
    groupedChildIDs.add(message.id)
  }

  const transcript: T[] = []
  for (const message of unique) {
    if (groupedChildIDs.has(message.id)) continue
    transcript.push(message)
    if (message.role === "user") transcript.push(...(childrenByParent.get(message.id) ?? []))
  }

  const visible = transcript.filter((message) => !queuedIDs.has(message.id))
  const queued = transcript.filter((message) => queuedIDs.has(message.id))
  return [...visible, ...queued]
}

export * as SessionTranscriptRows from "./session-transcript-rows"
