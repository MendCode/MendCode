import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"

export const ReasoningRequested = BusEvent.define("session.reasoning.updated", Schema.Struct({
  sessionID: Schema.String,
  messageID: Schema.String,
  mode: Schema.Literals(["auto", "manual"]),
  effort: Schema.String,
  reason: Schema.String,
  modelID: Schema.String,
  providerID: Schema.String,
  requestedAt: Schema.Number,
}))
export const ReasoningCleared = BusEvent.define("session.reasoning.cleared", Schema.Struct({
  sessionID: Schema.String, messageID: Schema.String, requestedAt: Schema.Number,
}))

export type ReasoningRequestState = Schema.Schema.Type<typeof ReasoningRequested.properties>
const current = new Map<string, ReasoningRequestState>()

/** Live last-request telemetry; an absent entry after restart never implies a default was applied. */
export function getReasoningState(sessionID: string) {
  const value = current.get(sessionID)
  return value ? { ...value } : undefined
}

export function recordReasoningState(value: ReasoningRequestState) {
  current.delete(value.sessionID)
  current.set(value.sessionID, { ...value })
  while (current.size > 128) current.delete(current.keys().next().value!)
}

export function clearReasoningState(sessionID: string) { current.delete(sessionID) }

export function requestedReasoningEffort(options: Record<string, any>) {
  const value = options.reasoningEffort ?? options.reasoning?.effort ?? options.effort ?? options.thinkingLevel
  return typeof value === "string" ? value : undefined
}
