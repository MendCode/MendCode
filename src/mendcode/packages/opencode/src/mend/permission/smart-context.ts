import { createHash } from "node:crypto"

export type AuthorityMessage = {
  id: string
  role: "user" | "assistant" | "tool"
  parentID?: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}

export type AuthorityContextV1 = {
  version: 1
  sessionID?: string
  objectiveEpoch: string
  contextRevision: number
  sourceUserIDs: readonly string[]
  userText: string
  objectiveRoot?: string
  explicitConstraints: readonly string[]
  complete: boolean
  unknownReasons: readonly string[]
  fingerprint: string
}

const MAX_ANCHORS = 12
const MAX_CONTEXT_CHARS = 24_000

function fingerprint(input: Omit<AuthorityContextV1, "fingerprint">) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex")
}

function isTrustedUserMessage(message: AuthorityMessage) {
  if (message.role !== "user" || message.synthetic || message.ignored) return false
  const kind = message.metadata?.kind
  return kind !== "peer_message" && kind !== "peer_response"
}

export function resolveCausalUserMessage(input: {
  messages: readonly AuthorityMessage[]
  assistantMessageID?: string
}) {
  if (!input.assistantMessageID) return
  const assistant = input.messages.find((message) => message.id === input.assistantMessageID)
  if (!assistant) return
  const userID = assistant.role === "assistant" ? assistant.parentID : assistant.id
  if (!userID) return
  const message = input.messages.find((candidate) => candidate.id === userID)
  return message && isTrustedUserMessage(message) ? message : undefined
}

export function buildAuthorityContext(input: {
  messages: readonly AuthorityMessage[]
  assistantMessageID?: string
  sessionID?: string
  objectiveEpoch: string
  contextRevision?: number
  objectiveRoot?: string
  explicitConstraints?: readonly string[]
}): AuthorityContextV1 {
  const causal = resolveCausalUserMessage(input)
  const anchors = input.messages.filter(isTrustedUserMessage).slice(-MAX_ANCHORS)
  const sourceUserIDs = [...(causal ? [causal.id] : []), ...anchors.map((message) => message.id)].filter(
    (id, index, list) => list.indexOf(id) === index,
  )
  const texts = anchors.map((message) => message.text?.trim()).filter((text): text is string => Boolean(text))
  if (causal?.text && !texts.includes(causal.text.trim())) texts.push(causal.text.trim())
  const explicitConstraints = (input.explicitConstraints ?? []).filter(Boolean).slice(0, MAX_ANCHORS)
  const userText = [...texts, ...explicitConstraints].join("\n").slice(0, MAX_CONTEXT_CHARS)
  const unknownReasons: string[] = []
  if (!causal) unknownReasons.push("causal_user_message_missing")
  if (sourceUserIDs.length > MAX_ANCHORS) unknownReasons.push("anchor_budget_exceeded")
  if (userText.length >= MAX_CONTEXT_CHARS) unknownReasons.push("context_budget_exceeded")
  const base: Omit<AuthorityContextV1, "fingerprint"> = {
    version: 1,
    sessionID: input.sessionID,
    objectiveEpoch: input.objectiveEpoch,
    contextRevision: input.contextRevision ?? 0,
    sourceUserIDs,
    userText,
    objectiveRoot: input.objectiveRoot,
    explicitConstraints,
    complete: unknownReasons.length === 0,
    unknownReasons,
  }
  return { ...base, fingerprint: fingerprint(base) }
}

export function contextAllowsAutomaticDecision(context: AuthorityContextV1) {
  return context.complete && context.sourceUserIDs.length > 0 && context.userText.length > 0
}
