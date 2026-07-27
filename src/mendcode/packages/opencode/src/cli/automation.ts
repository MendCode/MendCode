import { EOL } from "os"

export const AUTOMATION_PROTOCOL = "mendcode.cli.v1" as const

export type AutomationKind = "event" | "result" | "error"

export type AutomationEnvelope<T = unknown> = {
  protocol: typeof AUTOMATION_PROTOCOL
  kind: AutomationKind
  event: string
  eventID: string
  timestamp: number
  sessionID?: string
  data: T
}

let sequence = 0

function nextEventID(timestamp: number) {
  sequence += 1
  return `evt_${timestamp.toString(36)}_${sequence.toString(36)}`
}

const sensitiveKey =
  /(?:api[_-]?key|authorization|credential|password|secret|(?:access|refresh|id)?[_-]?token(?:$|[_-])|bearer|private[_-]?key|cookie)/i

export function redactAutomationData(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((item) => redactAutomationData(item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactAutomationData(item, name)]))
}

export function automationEnvelope<T>(input: {
  kind: AutomationKind
  event: string
  data: T
  sessionID?: string
  timestamp?: number
  eventID?: string
}): AutomationEnvelope<T> {
  const timestamp = input.timestamp ?? Date.now()
  return {
    protocol: AUTOMATION_PROTOCOL,
    kind: input.kind,
    event: input.event,
    eventID: input.eventID ?? nextEventID(timestamp),
    timestamp,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    data: redactAutomationData(input.data) as T,
  }
}

export function writeAutomationEnvelope<T>(input: Parameters<typeof automationEnvelope<T>>[0]) {
  process.stdout.write(JSON.stringify(automationEnvelope(input)) + EOL)
}

export function automationJSONRequested(args: readonly string[]) {
  return args.some(
    (arg, index) => arg === "--json" || arg === "--format=json" || (arg === "--format" && args[index + 1] === "json"),
  )
}

export * as Automation from "./automation"
