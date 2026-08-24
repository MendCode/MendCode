#!/usr/bin/env bun
import { readFile } from "fs/promises"
import path from "path"
import { Database as BunDatabase } from "bun:sqlite"
import { Global } from "@mendcode/core/global"
import { resolveDualReadDbPathFromLayout } from "@/storage/resolve-default-sqlite-path"
import { resolveMendProjectRoot } from "../config/paths"
import { loopProjectScopeSql } from "../runtime/loop-project-scope"

const scheduledLoopModes = new Set(["interval", "daily", "adaptive", "external-signal", "self-paced"])

type LoopRow = {
  state: string
  data: unknown
}

type DreamWindow = {
  enabled: boolean
  start: string
  end: string
  timezone?: string
}

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function loopMode(row: LoopRow) {
  const data =
    typeof row.data === "string"
      ? (() => {
          try {
            return JSON.parse(row.data) as unknown
          } catch {
            return undefined
          }
        })()
      : row.data
  return objectValue(objectValue(data)?.spec)?.trigger
}

function loopIsScheduled(row: LoopRow) {
  if (row.state === "working") return true
  const trigger = objectValue(loopMode(row))
  const mode = trigger?.mode
  return typeof mode !== "string" || scheduledLoopModes.has(mode)
}

function envOpen(openKey: string) {
  const mendKey = openKey.startsWith("OPENCODE_") ? `MENDCODE_${openKey.slice("OPENCODE_".length)}` : openKey
  return process.env[mendKey] || process.env[openKey]
}

function backgroundDatabasePath() {
  const override = envOpen("OPENCODE_DB")
  if (override)
    return override === ":memory:" || path.isAbsolute(override) ? override : path.join(Global.Path.data, override)
  const channel = envOpen("OPENCODE_CHANNEL") || "local"
  const disabled = [envOpen("OPENCODE_DISABLE_CHANNEL_DB")].some(
    (value) => value === "1" || value?.toLowerCase() === "true",
  )
  return resolveDualReadDbPathFromLayout(Global.Path.data, channel, disabled)
}

function readLoopRows(root: string, now: number, dueOnly: boolean) {
  let sqlite: BunDatabase | undefined
  try {
    sqlite = new BunDatabase(backgroundDatabasePath(), { readonly: true })
    const duePredicate = dueOnly
      ? `AND (
        w.state = 'working'
        OR (
          w.state IN ('active', 'sleeping')
          AND w.next_wakeup IS NOT NULL
          AND w.next_wakeup <= ?
        )
      )`
      : "AND (w.state = 'working' OR w.state IN ('active', 'sleeping'))"
    const limit = dueOnly ? "LIMIT 20" : ""
    const rows = sqlite
      .query(
        `
      SELECT w.state, w.data
      FROM loop_workflow AS w
      JOIN project AS p ON p.id = w.project_id
      WHERE ${loopProjectScopeSql("?")}
      ${duePredicate}
      ${limit}
    `,
      )
      .all(
        ...(dueOnly
          ? [path.resolve(root), path.resolve(root), path.resolve(root), now]
          : [path.resolve(root), path.resolve(root), path.resolve(root)]),
      ) as LoopRow[]
    return rows
  } catch {
    // A missing/old database must fall back to the full path so migrations and recovery still run.
    return undefined
  } finally {
    sqlite?.close()
  }
}

export function loopBackgroundServiceNeeded(root = resolveMendProjectRoot()) {
  const rows = readLoopRows(root, Date.now(), false)
  if (!rows) return true
  return rows.some(loopIsScheduled)
}

export function loopBackgroundHasWork(root = resolveMendProjectRoot(), now = Date.now()) {
  const rows = readLoopRows(root, now, true)
  if (!rows) return true
  return rows.some(loopIsScheduled)
}

function minutes(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

function dreamWindow(value: unknown): DreamWindow | undefined {
  const raw = objectValue(value)
  if (!raw || raw.enabled !== true || typeof raw.start !== "string" || typeof raw.end !== "string") return undefined
  if (minutes(raw.start) === undefined || minutes(raw.end) === undefined) return undefined
  return {
    enabled: true,
    start: raw.start,
    end: raw.end,
    ...(typeof raw.timezone === "string" && raw.timezone.trim() ? { timezone: raw.timezone.trim() } : {}),
  }
}

function localMinutes(now: Date, timezone?: string) {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now)
      const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ""
      const hour = Number(value("hour"))
      const minute = Number(value("minute"))
      return (hour === 24 ? 0 : hour) * 60 + minute
    } catch {
      // Fall back to the local clock for an invalid timezone, matching the scheduler.
    }
  }
  return now.getHours() * 60 + now.getMinutes()
}

export function dreamBackgroundHasWork(now = new Date()) {
  const globalDir = process.env.MENDCODE_MEMORY_DIR || path.join(Global.Path.data, "memory")
  const files = [path.join(globalDir, "config.json"), path.join(globalDir, "dream", "schedule.json")]
  return Promise.all(
    files.map(async (file) => {
      try {
        return JSON.parse(await readFile(file, "utf8")) as unknown
      } catch {
        return undefined
      }
    }),
  ).then(([config, schedule]) => {
    const window = dreamWindow(objectValue(config)?.dreamWindow) ?? dreamWindow(objectValue(schedule)?.window)
    if (!window) return false
    const start = minutes(window.start)!
    const end = minutes(window.end)!
    const current = localMinutes(now, window.timezone)
    return start <= end ? current >= start && current <= end : current >= start || current <= end
  })
}

function managedLoopService() {
  return (
    process.env.MENDCODE_LOOP_SERVICE === "1" ||
    process.env.XPC_SERVICE_NAME?.startsWith("com.mendcode.loops.") === true
  )
}

async function uninstallManagedLoopService(root: string) {
  if (!managedLoopService()) return
  const { loopServiceArgsFromConfig, loopServiceUninstall } = await import("../runtime/loop-service")
  await loopServiceUninstall(loopServiceArgsFromConfig(root))
}

export async function main(argv = process.argv.slice(2)) {
  const once = argv.includes("--once")
  if (once && argv[0] === "loops" && argv[1] === "daemon") {
    const root = resolveMendProjectRoot()
    if (!loopBackgroundServiceNeeded(root)) {
      await uninstallManagedLoopService(root)
      return
    }
    if (!loopBackgroundHasWork(root)) return
  }
  if (once && argv[0] === "memory" && argv[1] === "dream" && argv[2] === "daemon" && !(await dreamBackgroundHasWork()))
    return
  await import("./control-plane")
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export * as BackgroundDaemon from "./background-daemon"
