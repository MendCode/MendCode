export type SessionTranscriptMessage = {
  id: string
  role?: string
  parentID?: string
}

export function sessionTranscriptRows<T extends SessionTranscriptMessage>(
  messages: readonly T[],
  queuedIDs: ReadonlySet<string>,
  options: { boundaryIDs?: ReadonlySet<string>; tailIDs?: ReadonlySet<string> } = {},
) {
  const unique = [...new Map(messages.map((message) => [message.id, message] as const)).values()]
  const positions = new Map(unique.map((message, index) => [message.id, index] as const))
  const boundaryPrefix = unique.reduce<number[]>(
    (prefix, message, index) => {
    prefix.push(prefix[index] + (options.boundaryIDs?.has(message.id) ? 1 : 0))
    return prefix
    },
    [0],
  )
  const firstAssistantIndex = new Map<string, number>()
  for (const [index, message] of unique.entries()) {
    if (message.role !== "assistant" || !message.parentID || firstAssistantIndex.has(message.parentID)) continue
    firstAssistantIndex.set(message.parentID, index)
  }
  const deferredParentAtAssistant = new Map<number, T>()
  const deferredParentIDs = new Set<string>()
  for (const [index, message] of unique.entries()) {
    if (message.role !== "user") continue
    const assistantIndex = firstAssistantIndex.get(message.id)
    if (assistantIndex === undefined) continue
    if (boundaryPrefix[assistantIndex] !== boundaryPrefix[index + 1]) continue
    const interveningTurnStarted = unique
      .slice(index + 1, assistantIndex)
      .some(
        (candidate) =>
          candidate.role === "user" &&
          (firstAssistantIndex.get(candidate.id) ?? Number.POSITIVE_INFINITY) < assistantIndex,
      )
    if (!interveningTurnStarted) continue
    deferredParentAtAssistant.set(assistantIndex, message)
    deferredParentIDs.add(message.id)
  }
  const childrenByParent = new Map<string, T[]>()
  const groupedChildIDs = new Set<string>()

  for (const [index, message] of unique.entries()) {
    if (message.role !== "assistant" || !message.parentID) continue
    if (deferredParentIDs.has(message.parentID)) continue
    const parent = unique[positions.get(message.parentID) ?? -1]
    const parentIndex = positions.get(message.parentID)
    if (parent?.role !== "user" || parentIndex === undefined) continue
    // Queueing can place a later user before another assistant iteration, so keep
    // those assistant children with their parent. A compaction user is a hard
    // transcript boundary: follow-up assistants may still retain the old parent,
    // but must remain after the compaction summary.
    if (boundaryPrefix[index] !== boundaryPrefix[parentIndex + 1]) continue
    const interveningTurnStarted = unique
      .slice(parentIndex + 1, index)
      .some(
        (candidate) =>
          candidate.role === "user" && (firstAssistantIndex.get(candidate.id) ?? Number.POSITIVE_INFINITY) < index,
      )
    if (interveningTurnStarted) continue
    const children = childrenByParent.get(message.parentID) ?? []
    children.push(message)
    childrenByParent.set(message.parentID, children)
    groupedChildIDs.add(message.id)
  }

  const transcript: T[] = []
  for (const [index, message] of unique.entries()) {
    const deferredParent = deferredParentAtAssistant.get(index)
    if (deferredParent) transcript.push(deferredParent)
    if (deferredParentIDs.has(message.id)) continue
    if (groupedChildIDs.has(message.id)) continue
    transcript.push(message)
    if (message.role === "user") transcript.push(...(childrenByParent.get(message.id) ?? []))
  }

  const tailIDs = new Set(
    [...queuedIDs, ...(options.tailIDs ?? [])].filter((messageID) => !firstAssistantIndex.has(messageID)),
  )
  const visible = transcript.filter((message) => !tailIDs.has(message.id))
  const queued = transcript.filter((message) => tailIDs.has(message.id))
  return [...visible, ...queued]
}

export * as SessionTranscriptRows from "./session-transcript-rows"
