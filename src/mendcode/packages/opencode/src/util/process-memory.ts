export type ProcessMemoryUsage = {
  pid: number
  role: string
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  uptimeSeconds: number
  sharedServer?: {
    runtimeID: string
    stateOwner: boolean
    activeClientLeases: number
  }
}

export type DiagnosticsSnapshot = {
  tui: ProcessMemoryUsage
  server?: ProcessMemoryUsage
  serverError?: string
  ui?: {
    sessionCount: number
    cachedSessionCount?: number
    cachedMessageCount?: number
    cachedPartCount?: number
    route: string
  }
}

export function processMemoryUsage(role = process.env.OPENCODE_PROCESS_ROLE ?? "main"): ProcessMemoryUsage {
  const memory = process.memoryUsage()
  return {
    pid: process.pid,
    role,
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    uptimeSeconds: process.uptime(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isProcessMemoryUsage(value: unknown): value is ProcessMemoryUsage {
  if (!isRecord(value)) return false
  if (
    value.sharedServer !== undefined &&
    (!isRecord(value.sharedServer) ||
      typeof value.sharedServer.runtimeID !== "string" ||
      typeof value.sharedServer.stateOwner !== "boolean" ||
      typeof value.sharedServer.activeClientLeases !== "number")
  ) {
    return false
  }
  return (
    typeof value.pid === "number" &&
    typeof value.role === "string" &&
    typeof value.rss === "number" &&
    typeof value.heapTotal === "number" &&
    typeof value.heapUsed === "number" &&
    typeof value.external === "number" &&
    typeof value.arrayBuffers === "number" &&
    typeof value.uptimeSeconds === "number"
  )
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown"
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function formatUptime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown"
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatProcessMemory(label: string, memory: ProcessMemoryUsage) {
  const lines = [
    `${label} (pid ${memory.pid}, ${memory.role})`,
    `  RSS (RAM): ${formatBytes(memory.rss)}`,
    `  JS heap: ${formatBytes(memory.heapUsed)} used / ${formatBytes(memory.heapTotal)} reported`,
    `  External: ${formatBytes(memory.external)}`,
    `  Array buffers: ${formatBytes(memory.arrayBuffers)}`,
    `  Uptime: ${formatUptime(memory.uptimeSeconds)}`,
  ]
  if (memory.sharedServer) {
    lines.push(
      `  Shared server: ${memory.sharedServer.activeClientLeases} client lease(s) · ${memory.sharedServer.stateOwner ? "state owner" : "not state owner"}`,
      `  Runtime: ${memory.sharedServer.runtimeID}`,
    )
  }
  return lines
}

export function formatDiagnostics(input: DiagnosticsSnapshot) {
  const lines = [
    "On-demand sample only; no background monitoring is active.",
    "",
    ...formatProcessMemory("TUI", input.tui),
    "",
  ]

  if (input.server) {
    lines.push(...formatProcessMemory("Connected runtime", input.server))
  } else {
    lines.push(`Connected runtime: unavailable${input.serverError ? ` (${input.serverError})` : ""}`)
  }

  if (input.ui) {
    lines.push("", `TUI counters: ${input.ui.sessionCount} loaded sessions · route ${input.ui.route}`)
    if (
      input.ui.cachedSessionCount !== undefined &&
      input.ui.cachedMessageCount !== undefined &&
      input.ui.cachedPartCount !== undefined
    ) {
      lines.push(
        `TUI cache: ${input.ui.cachedSessionCount} sessions · ${input.ui.cachedMessageCount} messages · ${input.ui.cachedPartCount} parts`,
      )
    }
  }

  lines.push("", "Use Write heap snapshot only when a deeper object-level profile is needed.")
  return lines.join("\n")
}

export * as ProcessMemory from "./process-memory"
