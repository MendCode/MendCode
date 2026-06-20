import { existsSync } from "fs"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths } from "./config"
import { readDreamRuns, runMemoryDream, type DreamModelAdapter } from "./dream"
import type { DreamSourcePermissions } from "./dream-sources"

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
  return path.join(memoryPaths(root).projectDir, "dream")
}

function lockFile(root: string | undefined, key: string) {
  return path.join(schedulerDir(root), `${key}.lock`)
}

function minutes(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function localDate(now: Date) {
  return now.toISOString().slice(0, 10)
}

function insideWindow(now: Date, window: DreamScheduleWindow) {
  const start = minutes(window.start)
  const end = minutes(window.end)
  if (start === null || end === null) return false
  const current = now.getHours() * 60 + now.getMinutes()
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
  const date = localDate(now)
  const runs = await readDreamRuns(input.root)
  const completedToday = runs.some((run) =>
    run.status === "completed" &&
    run.startedAt.slice(0, 10) === date &&
    (input.workspaceID ? run.workspaceID === input.workspaceID : true) &&
    (input.groupID ? run.groupID === input.groupID : true))
  if (!input.window.enabled) return { action: "disabled" as const, date, reason: "Dream schedule disabled" }
  if (completedToday) return { action: "skip" as const, date, reason: "Dream already ran today" }
  if (insideWindow(now, input.window)) return { action: "run" as const, date, reason: "Inside configured Dream window" }
  const end = minutes(input.window.end)
  const current = now.getHours() * 60 + now.getMinutes()
  if (end !== null && current > end) return { action: "missed" as const, date, reason: "Dream window missed; manual trigger required" }
  return { action: "wait" as const, date, reason: "Waiting for Dream window" }
}

async function writeDreamScheduleState(root: string | undefined, state: DreamScheduleState) {
  const file = path.join(schedulerDir(root), "schedule.json")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
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
  const lock = lockFile(input.root, key)
  await mkdir(path.dirname(lock), { recursive: true })
  if (existsSync(lock)) return { status: "locked" as const, reason: "Dream already running", date: evaluation.date }
  await writeFile(lock, JSON.stringify({ startedAt: new Date().toISOString() }))
  try {
    return await runMemoryDream({ ...input, source: "scheduled" })
  } finally {
    await rm(lock, { force: true }).catch(() => {})
  }
}

export async function readDreamScheduleState(root?: string) {
  const file = path.join(schedulerDir(root), "schedule.json")
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, "utf8")) as DreamScheduleState
}
