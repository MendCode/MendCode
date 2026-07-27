import { existsSync } from "fs"
import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises"
import { networkInterfaces } from "os"
import path from "path"
import { memoryPaths, readGlobalMemoryConfig, writeGlobalMemoryConfig } from "./config"
import { readDreamRuns, runMemoryDream, type DreamModelAdapter, type DreamRun } from "./dream"
import type { DreamSourcePermissions } from "./dream-sources"
import { listMemoryProposals } from "./proposals"
import { memoryWorkspaceOverview, type MemoryWorkspace } from "./workspaces"

const OVERNIGHT_MISSED_GRACE_MINUTES = 60

export type DreamScheduleWindow = {
  enabled: boolean
  start: string
  end: string
  timezone?: string
}

export type DreamScheduleState = {
  date: string
  status: string
  reason: string
  manualTriggerRequired: boolean
  window?: DreamScheduleWindow
  updatedAt?: string
}

function schedulerDir(root?: string) {
  return path.join(memoryPaths(root).globalDir, "dream")
}

function lockFile(root: string | undefined, key: string) {
  return path.join(schedulerDir(root), `${key}.lock`)
}

async function acquireDreamLock(root: string | undefined, key: string) {
  const file = lockFile(root, key)
  await mkdir(path.dirname(file), { recursive: true })
  return writeFile(file, JSON.stringify({ startedAt: new Date().toISOString() }), { flag: "wx" })
    .then(() => file)
    .catch((error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return null
      throw error
    })
}

function minutes(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function localClock(now: Date, timezone?: string) {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now)
      const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""
      const hour = Number(value("hour"))
      const minute = Number(value("minute"))
      return {
        date: `${value("year")}-${value("month")}-${value("day")}`,
        current: (hour === 24 ? 0 : hour) * 60 + minute,
      }
    } catch {
      // Invalid user-provided timezone should not break Dream status rendering.
    }
  }
  return {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    current: now.getHours() * 60 + now.getMinutes(),
  }
}

function previousDate(date: string) {
  const [year, month, day] = date.split("-").map(Number)
  if (!year || !month || !day) return date
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)
}

function localDate(now: Date, timezone?: string) {
  return localClock(now, timezone).date
}

function scheduleDate(now: Date, window: DreamScheduleWindow) {
  const start = minutes(window.start)
  const end = minutes(window.end)
  const clock = localClock(now, window.timezone)
  if (start !== null && end !== null && start > end) {
    if (clock.current <= end) return previousDate(clock.date)
    if (clock.current > end && clock.current < start && clock.current - end <= OVERNIGHT_MISSED_GRACE_MINUTES) return previousDate(clock.date)
  }
  return clock.date
}

function padTime(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function parseTimeToken(value: string) {
  const trimmed = value.trim().toLowerCase()
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/)
  if (!match) return null
  let hour = Number(match[1])
  const minute = match[2] ? Number(match[2]) : 0
  const meridiem = match[3]
  if (minute < 0 || minute > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    if (meridiem === "pm" && hour !== 12) hour += 12
    if (meridiem === "am" && hour === 12) hour = 0
  }
  if (hour < 0 || hour > 23) return null
  return padTime(hour, minute)
}

function timezoneFromText(text: string) {
  const zone = text.match(/\b([A-Z][A-Za-z_]+\/[A-Za-z_]+)\b/)?.[1]
  if (zone) return zone
  if (/\b(?:utc|gmt)\b/i.test(text)) return "UTC"
  if (/\bnew\s+york\b/i.test(text)) return "America/New_York"
  return undefined
}

export function dreamScheduleWindowFromText(text: string): DreamScheduleWindow | null {
  const normalized = text.replace(/[–—]/g, "-")
  const range = normalized.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|to|a|hasta)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
  if (range) {
    const start = parseTimeToken(range[1]!)
    const end = parseTimeToken(range[2]!)
    if (start && end) return { enabled: true, start, end, timezone: timezoneFromText(text) }
  }
  const fixed = normalized.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
  const time = fixed ? parseTimeToken(fixed[1]!) : null
  if (!time) return null
  return { enabled: true, start: time, end: time, timezone: timezoneFromText(text) }
}

function insideWindow(now: Date, window: DreamScheduleWindow) {
  const start = minutes(window.start)
  const end = minutes(window.end)
  if (start === null || end === null) return false
  const current = localClock(now, window.timezone).current
  return start <= end ? current >= start && current <= end : current >= start || current <= end
}

export async function evaluateDreamSchedule(input: {
  root?: string
  window: DreamScheduleWindow
  now?: Date
  workspaceID?: string | null
  groupID?: string | null
}) {
  const now = input.now ?? new Date()
  const date = scheduleDate(now, input.window)
  const runs = await readDreamRuns(input.root)
  const completedRunsToday = runs.filter((run) =>
    run.status === "completed" &&
    scheduleDate(new Date(run.startedAt), input.window) === date &&
    (input.workspaceID ? run.workspaceID === input.workspaceID : true) &&
    (input.groupID ? run.groupID === input.groupID : true))
  const latestCompletedAt = completedRunsToday
    .map((run) => run.completedAt ?? run.startedAt)
    .toSorted((left, right) => right.localeCompare(left))[0]
  const pending = latestCompletedAt
    ? await listMemoryProposals(input.root, "pending").catch(() => [])
    : []
  const hasPendingWorkSinceLastRun = latestCompletedAt
    ? pending.some((proposal) => (proposal.updatedAt || proposal.createdAt).localeCompare(latestCompletedAt) > 0)
    : false
  if (!input.window.enabled) return { action: "disabled" as const, date, reason: "Dream schedule disabled" }
  if (completedRunsToday.length && !hasPendingWorkSinceLastRun) return { action: "skip" as const, date, reason: "Dream already ran today" }
  if (completedRunsToday.length && hasPendingWorkSinceLastRun && insideWindow(now, input.window)) {
    return { action: "run" as const, date, reason: "New pending memory work arrived after the last Dream run" }
  }
  if (insideWindow(now, input.window)) return { action: "run" as const, date, reason: "Inside configured Dream window" }
  const start = minutes(input.window.start)
  const end = minutes(input.window.end)
  const current = localClock(now, input.window.timezone).current
  if (start !== null && end !== null && start <= end && current > end) return { action: "missed" as const, date, reason: "Dream window missed; manual trigger required" }
  if (start !== null && end !== null && start > end && current > end && current < start && current - end <= OVERNIGHT_MISSED_GRACE_MINUTES) {
    return { action: "missed" as const, date, reason: "Dream window missed; manual trigger required" }
  }
  return { action: "wait" as const, date, reason: "Waiting for Dream window" }
}

async function writeDreamScheduleState(root: string | undefined, state: DreamScheduleState) {
  const file = path.join(schedulerDir(root), "schedule.json")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

export async function configureDreamSchedule(root: string | undefined, window: DreamScheduleWindow, reason = "Dream schedule configured") {
  const state = {
    date: localDate(new Date(), window.timezone),
    status: window.enabled ? "scheduled" : "disabled",
    reason,
    manualTriggerRequired: false,
    window,
  }
  await writeGlobalMemoryConfig({ dreamWindow: window }, root)
  await writeDreamScheduleState(root, state)
  return state
}

export async function configureDreamScheduleFromText(root: string | undefined, text: string, reason = "Dream schedule configured from proposal") {
  const window = dreamScheduleWindowFromText(text)
  if (!window) throw new Error("Dream proposal is missing a schedule window, e.g. 18:00-23:00")
  return configureDreamSchedule(root, window, reason)
}

async function recoverDreamScheduleFromAppliedProposal(root?: string) {
  const paths = memoryPaths(root)
  if (!existsSync(paths.proposalsDir)) return null
  const files = await readdir(paths.proposalsDir).catch(() => [] as string[])
  const proposals = await Promise.all(files
    .filter((file) => file.endsWith(".json"))
    .map(async (file) => {
      try {
        return JSON.parse(await readFile(path.join(paths.proposalsDir, file), "utf8")) as {
          status?: string
          text?: string
          tags?: string[]
          updatedAt?: string
          createdAt?: string
        }
      } catch {
        return null
      }
    }))
  const applied = proposals
    .filter((proposal): proposal is NonNullable<typeof proposal> =>
      proposal?.status === "applied" &&
      typeof proposal.text === "string" &&
      Array.isArray(proposal.tags) &&
      proposal.tags.includes("dream-dry-run"))
    .toSorted((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))
  const latest = applied[0]
  if (!latest?.text) return null
  return configureDreamScheduleFromText(root, latest.text, "Recovered from applied Dream proposal")
}

async function dreamScheduleFromSettings() {
  const config = await readGlobalMemoryConfig().catch(() => null)
  if (!config?.dreamWindow) return null
  return {
    date: localDate(new Date(), config.dreamWindow.timezone),
    status: config.dreamWindow.enabled ? "scheduled" : "disabled",
    reason: "Dream window configured in memory settings",
    manualTriggerRequired: false,
    window: config.dreamWindow,
  } satisfies DreamScheduleState
}

export async function markDreamMissed(root: string | undefined, date: string, reason: string, window?: DreamScheduleWindow) {
  const state = { date, status: "missed" as const, reason, manualTriggerRequired: true, window }
  await writeDreamScheduleState(root, state)
  return state
}

export async function runScheduledMemoryDream(input: {
  root?: string
  window: DreamScheduleWindow
  now?: Date
  workspaceID?: string | null
  groupID?: string | null
  permissions?: DreamSourcePermissions
  model?: DreamModelAdapter
}) {
  const evaluation = await evaluateDreamSchedule(input)
  if (evaluation.action === "missed") return markDreamMissed(input.root, evaluation.date, evaluation.reason, input.window)
  if (evaluation.action !== "run") {
    const state = {
      status: evaluation.action,
      reason: evaluation.reason,
      date: evaluation.date,
      manualTriggerRequired: false,
      window: input.window,
    }
    await writeDreamScheduleState(input.root, state)
    return state
  }
  const key = `dream-${input.workspaceID ?? input.groupID ?? "default"}`
  const lock = await acquireDreamLock(input.root, key)
  if (!lock) return { status: "locked" as const, reason: "Dream already running", date: evaluation.date }
  try {
    return await runMemoryDream({ ...input, source: "scheduled" })
  } finally {
    await rm(lock, { force: true }).catch(() => {})
  }
}

export async function readDreamScheduleState(root?: string) {
  const configured = await dreamScheduleFromSettings()
  const file = path.join(schedulerDir(root), "schedule.json")
  if (!existsSync(file)) return configured ?? recoverDreamScheduleFromAppliedProposal(root)
  const persisted = JSON.parse(await readFile(file, "utf8")) as DreamScheduleState
  if (!configured) return persisted
  return {
    ...persisted,
    window: persisted.window ?? configured.window,
  }
}

export function hasUsableNetworkInterface() {
  return Object.values(networkInterfaces()).some((items) =>
    items?.some((item) => !item.internal && (item.family === "IPv4" || item.family === "IPv6")),
  )
}

export async function runGlobalDreamSchedulerTick(input: {
  now?: Date
  permissions?: DreamSourcePermissions
  model?: DreamModelAdapter
  networkAvailable?: () => boolean | Promise<boolean>
  workspaces?: MemoryWorkspace[]
} = {}) {
  const config = await readGlobalMemoryConfig()
  const window = config.dreamWindow ?? (await readDreamScheduleState())?.window
  if (!window) return { status: "not-configured" as const, reason: "Global Dream window is not configured", runs: [] as DreamRun[] }

  const online = await (input.networkAvailable?.() ?? hasUsableNetworkInterface())
  if (!online) {
    const state = {
      date: localDate(input.now ?? new Date(), window.timezone),
      status: "wait",
      reason: "Waiting for network before running global Dream",
      manualTriggerRequired: false,
      window,
    } satisfies DreamScheduleState
    await writeDreamScheduleState(undefined, state)
    return { status: "offline" as const, reason: state.reason, state, runs: [] as DreamRun[] }
  }

  const overview = input.workspaces ? null : await memoryWorkspaceOverview(undefined)
  const workspaces = (input.workspaces ?? overview?.activeWorkspaces ?? [])
    .filter((workspace) => !workspace.archived)
  if (!workspaces.length) {
    const evaluation = await evaluateDreamSchedule({ window, now: input.now })
    const state = {
      date: evaluation.date,
      status: evaluation.action === "run" ? "wait" : evaluation.action,
      reason: evaluation.action === "run" ? "No registered workspaces for global Dream" : evaluation.reason,
      manualTriggerRequired: evaluation.action === "missed",
      window,
    } satisfies DreamScheduleState
    await writeDreamScheduleState(undefined, state)
    return { status: "no-workspaces" as const, reason: state.reason, state, runs: [] as DreamRun[] }
  }

  const runs: DreamRun[] = []
  for (const workspace of workspaces) {
    const result = await runScheduledMemoryDream({
      root: workspace.root,
      window,
      now: input.now,
      workspaceID: workspace.id,
      permissions: input.permissions,
      model: input.model,
    })
    if ("id" in result) runs.push(result)
  }
  return { status: "checked" as const, reason: `Checked ${workspaces.length} global Dream workspace${workspaces.length === 1 ? "" : "s"}`, runs }
}

let backgroundTimer: ReturnType<typeof setInterval> | undefined

export function startGlobalDreamBackgroundService(input: {
  intervalMs?: number
  permissions?: DreamSourcePermissions
  model?: DreamModelAdapter
  networkAvailable?: () => boolean | Promise<boolean>
} = {}) {
  if (backgroundTimer) return { started: false, reason: "Global Dream background service already running" }
  const tick = () => {
    void runGlobalDreamSchedulerTick(input).catch(() => {})
  }
  backgroundTimer = setInterval(tick, input.intervalMs ?? 60_000)
  backgroundTimer.unref?.()
  tick()
  return { started: true, reason: "Global Dream background service started" }
}

export function stopGlobalDreamBackgroundService() {
  if (!backgroundTimer) return false
  clearInterval(backgroundTimer)
  backgroundTimer = undefined
  return true
}

export function isGlobalDreamBackgroundServiceRunning() {
  return Boolean(backgroundTimer)
}
