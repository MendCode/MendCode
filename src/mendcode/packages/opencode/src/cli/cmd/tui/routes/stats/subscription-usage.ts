import { open, readdir } from "node:fs/promises"
import path from "node:path"
import { Global } from "@mendcode/core/global"

export type SubscriptionUsageWindow = {
  label: string
  usedPercent: number
  windowMinutes: number
  resetsAt?: number
}

export type SubscriptionUsageSnapshot = {
  provider: "codex"
  plan?: string
  updatedAt?: number
  windows: SubscriptionUsageWindow[]
}

type CodexRateWindow = {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

type CodexAppRateWindow = {
  usedPercent?: unknown
  windowDurationMins?: unknown
  resetsAt?: unknown
}

type CodexAppRateLimits = {
  planType?: unknown
  primary?: unknown
  secondary?: unknown
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function subscriptionWindowLabel(minutes: number) {
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function parseWindow(value: unknown): SubscriptionUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as CodexRateWindow
  const usedPercent = finiteNumber(input.used_percent)
  const windowMinutes = finiteNumber(input.window_minutes)
  if (usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) return undefined
  const resetsAt = finiteNumber(input.resets_at)
  return {
    label: subscriptionWindowLabel(windowMinutes),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1000 }),
  }
}

function parseAppWindow(value: unknown): SubscriptionUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as CodexAppRateWindow
  const usedPercent = finiteNumber(input.usedPercent)
  const windowMinutes = finiteNumber(input.windowDurationMins)
  if (usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) return undefined
  const resetsAt = finiteNumber(input.resetsAt)
  return {
    label: subscriptionWindowLabel(windowMinutes),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowMinutes,
    ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1000 }),
  }
}

export function parseCodexAppServerUsage(input: unknown): SubscriptionUsageSnapshot | undefined {
  if (!input || typeof input !== "object") return undefined
  const result = input as {
    rateLimits?: CodexAppRateLimits
    rateLimitsByLimitId?: Record<string, CodexAppRateLimits | undefined> | null
  }
  const limits = result.rateLimitsByLimitId?.codex ?? result.rateLimits
  if (!limits) return undefined
  const windows = [parseAppWindow(limits.primary), parseAppWindow(limits.secondary)].filter(
    (item): item is SubscriptionUsageWindow => Boolean(item),
  )
  if (windows.length === 0) return undefined
  return {
    provider: "codex",
    plan: typeof limits.planType === "string" ? limits.planType : undefined,
    updatedAt: Date.now(),
    windows,
  }
}

export function parseCodexSubscriptionUsage(input: string): SubscriptionUsageSnapshot | undefined {
  const lines = input.split("\n")
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      const event = JSON.parse(line) as {
        timestamp?: unknown
        payload?: {
          type?: unknown
          info?: {
            rate_limits?: {
              plan_type?: unknown
              primary?: unknown
              secondary?: unknown
            }
          }
        }
      }
      if (event.payload?.type !== "token_count") continue
      const limits = event.payload.info?.rate_limits
      if (!limits) continue
      const windows = [parseWindow(limits.primary), parseWindow(limits.secondary)].filter(
        (item): item is SubscriptionUsageWindow => Boolean(item),
      )
      if (windows.length === 0) continue
      const timestamp = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN
      return {
        provider: "codex",
        plan: typeof limits.plan_type === "string" ? limits.plan_type : undefined,
        updatedAt: Number.isFinite(timestamp) ? timestamp : undefined,
        windows,
      }
    } catch {
      continue
    }
  }
  return undefined
}

async function latestCodexSessionFile(root: string) {
  let directories = [root]
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = []
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      next.push(
        ...entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(directory, entry.name))
          .sort((left, right) => right.localeCompare(left)),
      )
    }
    if (next.length === 0) return undefined
    directories = next.slice(0, 4)
  }

  const files = (
    await Promise.all(
      directories.map(async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => path.join(directory, entry.name))
      }),
    )
  ).flat()
  return files.sort((left, right) => right.localeCompare(left))[0]
}

async function readFileTail(file: string, bytes = 512 * 1024) {
  const handle = await open(file, "r")
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    return buffer.toString("utf8")
  } finally {
    await handle.close()
  }
}

async function readCodexAppServerUsage() {
  const process = Bun.spawn(["codex", "app-server", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  const reader = process.stdout.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  async function response(id: number, timeoutMs: number) {
    const read = async () => {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return undefined
        pending += decoder.decode(chunk.value, { stream: true })
        let newline = pending.indexOf("\n")
        while (newline >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          newline = pending.indexOf("\n")
          try {
            const value = JSON.parse(line) as { id?: unknown; result?: unknown }
            if (value.id === id) return value.result
          } catch {
            continue
          }
        }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        read(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  try {
    process.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "mendcode-stats", title: "MendCode Stats", version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })}\n`,
    )
    process.stdin.flush()
    if (!(await response(1, 1_500))) return undefined
    process.stdin.write(
      `${JSON.stringify({ method: "initialized" })}\n${JSON.stringify({
        method: "account/rateLimits/read",
        id: 2,
      })}\n`,
    )
    process.stdin.flush()
    return parseCodexAppServerUsage(await response(2, 3_000))
  } finally {
    process.kill()
    await reader.cancel().catch(() => undefined)
  }
}

export async function loadSubscriptionUsage() {
  const live = await readCodexAppServerUsage().catch(() => undefined)
  if (live) return live
  const root = path.join(Global.Path.home, ".codex", "sessions")
  const file = await latestCodexSessionFile(root)
  if (!file) return undefined
  return parseCodexSubscriptionUsage(await readFileTail(file))
}
