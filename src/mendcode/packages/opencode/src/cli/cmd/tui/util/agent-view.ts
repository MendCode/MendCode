import type { Session, SessionStatus } from "@mendcode/sdk/v2"

export type AgentViewBackgroundSession = {
  sessionID: string
  state: "queued" | "working" | "needs_input" | "completed" | "failed" | "stopped"
  summary?: string | null
  error?: string | null
  pinned?: boolean | null
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
}

export type AgentViewSessionItem = {
  background: AgentViewBackgroundSession
  session?: Session
}

const visibleCompletedWindowMs = 24 * 60 * 60 * 1000

function normalizePath(value: string) {
  return value.replaceAll("\\", "/")
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
  now?: number
}) {
  const { item, status } = input
  if (item.background.pinned || item.background.error) return true

  const directory = item.background.session?.directory || item.session?.directory
  if (isTemporaryAgentViewDirectory(directory)) return false
  if (!item.background.session && !item.session) return false

  if ((input.pendingInput ?? 0) > 0) return true
  if (status?.type === "busy" || status?.type === "retry") return true
  if (item.background.state === "queued" || item.background.state === "working" || item.background.state === "needs_input") {
    return true
  }

  return (input.now ?? Date.now()) - item.background.time.updated <= visibleCompletedWindowMs
}
