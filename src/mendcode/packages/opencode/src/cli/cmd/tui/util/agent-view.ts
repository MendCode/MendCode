import type { Session, SessionStatus } from "@mendcode/sdk/v2"
import { Locale } from "@/util/locale"

export type AgentViewBackgroundSession = {
  sessionID: string
  state: "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped"
  summary?: string | null
  error?: string | null
  pinned?: boolean | null
  process?: {
    pid: number
    started: number
  } | null
  time: {
    created: number
    updated: number
  }
  session?: {
    id: string
    title: string
    directory: string
    path?: string | null
    agent?: string | null
    time: {
      created: number
      updated: number
    }
  } | null
  metadata?: {
    title?: string | null
    tags?: readonly string[] | null
    group?: string | null
    priority?: "low" | "normal" | "high" | "urgent" | null
    notes?: string | null
    pinned?: boolean | null
    archived?: boolean | null
  } | null
}

export type AgentViewSessionItem = {
  background: AgentViewBackgroundSession
  session?: Session
}

export type AgentViewCommand = {
  id: string
  sourceSessionID: string
  targetSessionID: string
  type: "request_summary" | "rename" | "tag" | "pause_after_turn" | "stop" | "send_message"
  payload?: {
    instructions?: string | null
    title?: string | null
    tags?: readonly string[] | null
    reason?: string | null
    text?: string | null
  } | null
  permissions?: readonly string[] | null
  state: "pending" | "accepted" | "running" | "completed" | "rejected" | "failed" | "expired"
  error?: string | null
  result?: string | null
  expiresAt?: number | null
  time: {
    created: number
    updated: number
  }
}

export type AgentViewOrchestrationSummary = {
  pending: number
  active: number
  completed: number
  blocked: number
  pendingCapacity: number
  overLimitTargets: number
}

const visibleCompletedWindowMs = 24 * 60 * 60 * 1000

function normalizePath(value: string) {
  return value.replaceAll("\\", "/")
}

export function isAgentViewPathLike(value: string | undefined | null) {
  if (!value) return false
  const normalized = normalizePath(value.trim())
  return normalized.startsWith("/") || normalized.startsWith("~/") || /^[a-z]:\//i.test(normalized)
}

export function formatAgentViewPathLabel(value: string | undefined | null) {
  if (!value) return undefined
  const normalized = normalizePath(value.trim()).replace(/\/+$/, "")
  if (!normalized) return undefined
  const homeLabel = normalized.replace(/^\/Users\/[^/]+/, "~")
  const parts = homeLabel.split("/").filter(Boolean)
  if (homeLabel.startsWith("~/") && parts.length >= 2) return `${parts.at(-2)}/${parts.at(-1)}`
  if (/^[a-z]:$/i.test(parts[0] ?? "") && parts.length >= 3) return `${parts.at(-2)}/${parts.at(-1)}`
  if (parts.length >= 2) return `${parts.at(-2)}/${parts.at(-1)}`
  return homeLabel
}

export function formatAgentViewDetailLabel(value: string | undefined | null) {
  if (!value) return undefined
  if (isAgentViewPathLike(value)) return formatAgentViewPathLabel(value)
  return value
}

export function isTemporaryAgentViewDirectory(value: string | undefined) {
  if (!value) return false
  const normalized = normalizePath(value)
  return (
    normalized.startsWith("/private/var/folders/") ||
    normalized.startsWith("/var/folders/") ||
    normalized.startsWith("/tmp/") ||
    normalized.startsWith("/private/tmp/") ||
    normalized.startsWith("/var/tmp/") ||
    normalized.includes("/opencode-test-") ||
    normalized.includes("/opencode-debug-data-") ||
    normalized.includes("/mendcode-test-") ||
    normalized.includes("/AppData/Local/Temp/")
  )
}

export function isAgentViewSessionVisible(input: {
  item: AgentViewSessionItem
  status?: SessionStatus
  pendingInput?: number
  pendingCommands?: number
  activeCommands?: number
  blockedCommands?: number
  now?: number
}) {
  const { item, status } = input
  if (item.background.pinned || item.background.metadata?.pinned || item.background.error) return true

  const active =
    (input.pendingInput ?? 0) > 0 ||
    (input.pendingCommands ?? 0) > 0 ||
    (input.activeCommands ?? 0) > 0 ||
    (input.blockedCommands ?? 0) > 0 ||
    status?.type === "busy" ||
    status?.type === "retry" ||
    item.background.state === "queued" ||
    item.background.state === "working" ||
    item.background.state === "needs_input"
  if (active) return true

  const directory = item.background.session?.directory || item.session?.directory
  if (isTemporaryAgentViewDirectory(directory)) return false
  if (!item.background.session && !item.session) return false
  if (item.background.metadata?.archived) return false

  return (input.now ?? Date.now()) - item.background.time.updated <= visibleCompletedWindowMs
}

export function isAgentViewSessionFallbackVisible(item: AgentViewSessionItem) {
  const directory = item.background.session?.directory || item.session?.directory
  if (isTemporaryAgentViewDirectory(directory)) return false
  return Boolean(item.background.session || item.session)
}

export function formatAgentViewSessionTime(input: number, now: number = Date.now()) {
  const date = new Date(input)
  const current = new Date(now)
  const isToday =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate()
  if (isToday) return `Today · ${Locale.time(input)}`

  const sameYear = date.getFullYear() === current.getFullYear()
  const localDate = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: sameYear ? "short" : "numeric",
    ...(sameYear ? {} : { year: "numeric" as const }),
  })
  return `${Locale.time(input)} · ${localDate}`
}

export function agentViewCommandTouchesSession(input: {
  command?: Pick<AgentViewCommand, "sourceSessionID" | "targetSessionID">
  sourceSessionID?: string
  targetSessionID?: string
  sessionID: string
  direction?: "source" | "target" | "either"
}) {
  const sourceSessionID = input.command?.sourceSessionID ?? input.sourceSessionID
  const targetSessionID = input.command?.targetSessionID ?? input.targetSessionID
  if (!sourceSessionID || !targetSessionID) return false
  if (input.direction === "source") return sourceSessionID === input.sessionID
  if (input.direction === "either") return targetSessionID === input.sessionID || sourceSessionID === input.sessionID
  return targetSessionID === input.sessionID
}

export function isAgentViewCommandActionable(command: Pick<AgentViewCommand, "state">) {
  return command.state === "pending"
}

export function agentViewCommandStateRank(command: Pick<AgentViewCommand, "state">) {
  if (command.state === "pending") return 0
  if (command.state === "accepted" || command.state === "running") return 1
  if (command.state === "failed" || command.state === "rejected" || command.state === "expired") return 2
  return 3
}

export function countAgentViewCommands(input: {
  commands: readonly AgentViewCommand[]
  sessionID: string
  states?: readonly AgentViewCommand["state"][]
  direction?: "source" | "target" | "either"
}) {
  const states = input.states ? new Set(input.states) : undefined
  return input.commands.filter(
    (command) =>
      agentViewCommandTouchesSession({ ...command, sessionID: input.sessionID, direction: input.direction }) &&
      (!states || states.has(command.state)),
  ).length
}

export function summarizeAgentViewOrchestration(input: {
  commands: readonly AgentViewCommand[]
  sessionIDs: Iterable<string>
  pendingLimitPerTarget?: number
}): AgentViewOrchestrationSummary {
  const sessionIDs = new Set(input.sessionIDs)
  const pendingLimit = Math.max(1, input.pendingLimitPerTarget ?? 3)
  const pendingByTarget = new Map<string, number>()
  const summary: AgentViewOrchestrationSummary = {
    pending: 0,
    active: 0,
    completed: 0,
    blocked: 0,
    pendingCapacity: sessionIDs.size * pendingLimit,
    overLimitTargets: 0,
  }
  for (const command of input.commands) {
    if (!sessionIDs.has(command.targetSessionID)) continue
    if (command.state === "pending") {
      summary.pending++
      pendingByTarget.set(command.targetSessionID, (pendingByTarget.get(command.targetSessionID) ?? 0) + 1)
      continue
    }
    if (command.state === "accepted" || command.state === "running") {
      summary.active++
      continue
    }
    if (command.state === "completed") {
      summary.completed++
      continue
    }
    summary.blocked++
  }
  summary.overLimitTargets = [...pendingByTarget.values()].filter((count) => count > pendingLimit).length
  return summary
}

export function formatAgentViewOrchestrationSummary(input: AgentViewOrchestrationSummary) {
  const pendingLabel = input.pendingCapacity > 0 ? `${input.pending}/${input.pendingCapacity} queued` : `${input.pending} queued`
  const limitLabel = input.overLimitTargets > 0 ? ` · ${input.overLimitTargets} over limit` : ""
  return `Coordinator commands · ${pendingLabel}${limitLabel} · ${input.active} running · ${input.completed} done · ${input.blocked} blocked`
}

export function formatAgentViewCommandType(command: Pick<AgentViewCommand, "type">) {
  if (command.type === "request_summary") return "request summary"
  if (command.type === "rename") return "rename row"
  if (command.type === "tag") return "update tags"
  if (command.type === "pause_after_turn") return "pause after turn"
  if (command.type === "stop") return "stop worker"
  return "send message"
}

export function formatAgentViewCommandSummary(command: Pick<AgentViewCommand, "type" | "payload" | "state">) {
  const action = formatAgentViewCommandType(command)
  const detail =
    command.type === "rename"
      ? command.payload?.title
      : command.type === "tag"
        ? command.payload?.tags?.map((tag) => `#${tag}`).join(" ")
        : command.type === "send_message"
          ? command.payload?.text
          : command.payload?.instructions ?? command.payload?.reason
  const state = command.state === "pending" ? "pending" : command.state
  return Locale.truncate(
    [state, action, detail]
      .filter(Boolean)
      .join(" · ")
      .replace(/\s+/g, " ")
      .trim(),
    120,
  )
}
