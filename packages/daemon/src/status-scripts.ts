import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { Clock, TimerHandle } from "@mendcode/kernel"
import type { ExtensionLayer } from "@mendcode/packages"
import type { StatusSegment } from "@mendcode/protocol"
import { quotaReadings, type QuotaSnapshotLike } from "@mendcode/protocol/wire"
import { runManaged } from "@mendcode/tools"
import { z } from "zod"

/**
 * Script-backed status (v1's `promptStatus.scripts`): a layer's `statusline.json` names a command for the left
 * and/or right side of the status rows. The daemon runs it every `refreshMs` only while some client watches that
 * project, and pushes the parsed segments. Project scripts run only in trusted directories, like custom tools.
 */
export const STATUSLINE_FILE = "statusline.json"
export const MIN_REFRESH_MS = 1_000
export const DEFAULT_REFRESH_MS = 5_000
export const DEFAULT_SCRIPT_TIMEOUT_MS = 1_500
export const MAX_SCRIPT_TIMEOUT_MS = 10_000
const MAX_SEGMENTS = 12
const MAX_TEXT = 120
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const sideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  prepend: z.boolean().optional(),
  command: z.array(z.string().min(1)).min(1).max(20).optional(),
  refreshMs: z.number().int().min(MIN_REFRESH_MS).max(3_600_000).optional(),
  timeoutMs: z.number().int().min(50).max(MAX_SCRIPT_TIMEOUT_MS).optional(),
})
const fileSchema = z.strictObject({ left: sideSchema.optional(), right: sideSchema.optional() })

export type StatusSide = "left" | "right"
export type StatusScript = { side: StatusSide; command: string[]; refreshMs: number; timeoutMs: number; dir: string; source: ExtensionLayer["source"]; prepend?: boolean }

/** The effective script per side: a later layer's `statusline.json` side replaces an earlier one. */
export function statusScripts(layers: readonly ExtensionLayer[]): { scripts: StatusScript[]; problems: string[] } {
  const bySide = new Map<StatusSide, StatusScript>()
  const problems: string[] = []
  for (const layer of layers) {
    const file = path.join(layer.dir, STATUSLINE_FILE)
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      problems.push(`${file}: invalid JSON: ${(error as Error).message}`)
      continue
    }
    const parsed = fileSchema.safeParse(json)
    if (!parsed.success) {
      problems.push(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`)
      continue
    }
    for (const side of ["left", "right"] as const) {
      const entry = parsed.data[side]
      if (!entry) continue
      if (entry.enabled === false) { bySide.delete(side); continue }
      if (!entry.command) continue
      bySide.set(side, {
        side,
        // "./x" anywhere in the command is the layer's folder (a package ships its script next to the file).
        command: entry.command.map((part) => (/^\.{1,2}[\\/]/.test(part) ? path.resolve(layer.dir, part) : part)),
        refreshMs: entry.refreshMs ?? DEFAULT_REFRESH_MS,
        timeoutMs: entry.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
        dir: layer.dir,
        source: layer.source,
        ...(entry.prepend ? { prepend: true } : {}),
      })
    }
  }
  return { scripts: [...bySide.values()], problems }
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text)
// Whole escape sequences first, then any other control character (a lone ESC included).
const clean = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
const singleLine = (text: string) => clean(text.replace(/[\t\n\r]/g, " "))

/** Only explicit `{ rows }` opts into multiline; each row's segments concatenate without added separators. */
export function parseStatusRows(output: string): StatusSegment[][] | undefined {
  try {
    const json = JSON.parse(output) as { rows?: unknown } | null
    if (!json || !Array.isArray(json.rows)) return undefined
    const rows: StatusSegment[][] = []
    for (const row of json.rows.slice(0, 4)) {
      if (!Array.isArray(row)) continue
      const segments: StatusSegment[] = []
      for (const raw of row.slice(0, 32)) {
        if (!raw || typeof raw !== "object" || typeof raw.text !== "string") continue
        const text = singleLine(raw.text).slice(0, 240)
        if (!text.trim()) continue
        segments.push({ text, ...(typeof raw.fg === "string" && HEX.test(raw.fg) ? { fg: raw.fg } : {}), ...(raw.bold === true ? { bold: true } : {}) })
      }
      if (segments.length) rows.push(segments)
    }
    return rows
  } catch {
    return undefined
  }
}

/** A script's stdout as segments: JSON `{ segments: [{text, fg?, bold?}] }`, TSV `fg<TAB>bold<TAB>text` lines, or plain text. */
export function parseStatusOutput(output: string): StatusSegment[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as { segments?: unknown } | null
      const rawSegments = Array.isArray(json) ? json : json?.segments
      if (Array.isArray(rawSegments)) {
        const segments: StatusSegment[] = []
        for (const raw of rawSegments.slice(0, MAX_SEGMENTS)) {
          if (typeof raw !== "object" || raw === null || typeof (raw as { text?: unknown }).text !== "string") continue
          const { text, fg, bold } = raw as { text: string; fg?: unknown; bold?: unknown }
          segments.push({ text: clip(singleLine(text)), ...(typeof fg === "string" && HEX.test(fg) ? { fg } : {}), ...(bold === true ? { bold: true } : {}) })
        }
        return segments
      }
    } catch {
      // Not JSON after all: falls through to plain text.
    }
  }
  const lines = trimmed.split("\n")
  if (lines.every((line) => line.split("\t").length >= 3)) {
    return lines.slice(0, MAX_SEGMENTS).map((line) => {
      const [fg = "", bold = "", ...rest] = line.split("\t")
      return { text: clip(singleLine(rest.join("\t"))), ...(HEX.test(fg) ? { fg } : {}), ...(["1", "true"].includes(bold.trim().toLowerCase()) ? { bold: true } : {}) }
    })
  }
  return [{ text: clip(lines.map((line) => singleLine(line).trim()).filter(Boolean).join(" · ")) }]
}

/**
 * What a script reads in `MENDCODE_USAGE_JSON`: `{ now, quota: [{ provider, window, usedPercent, leftPercent, resetsAt?, observedAt, ageMs, stale }] }`
 * with the windows the daemon has a reading for (a missing one is unknown, never 0 or 100). The fields are those of `api.usage().quota`.
 */
export function usageJson(snapshots: readonly QuotaSnapshotLike[], now: number): string {
  const quota = quotaReadings(snapshots, now).map(({ windowId: _id, windowMinutes: _minutes, source: _source, ...reading }) => reading)
  return JSON.stringify({ now, quota })
}

export type StatusLine = { directory: string; left: StatusSegment[]; right: StatusSegment[]; problems: string[]; leftRows?: StatusSegment[][]; rightRows?: StatusSegment[][] }

type Watch = { directory: string; watchers: number; timers: Map<StatusSide, TimerHandle>; running: Set<StatusSide>; abort: AbortController; last: StatusLine }

/**
 * Runs the status scripts of watched projects. `watch` returns an unwatch function; the last unwatch of a directory
 * stops its timers and any running script (P6: nothing runs for a project nobody looks at).
 */
export function createStatusScripts(options: {
  clock: Clock
  layersFor(directory: string): ExtensionLayer[]
  isTrusted(directory: string): boolean
  publish(line: StatusLine): void
  env?: Record<string, string | undefined>
  /** The provider quota snapshots the daemon last saw: each run gets them as `MENDCODE_USAGE_JSON`. */
  quotas?(): readonly QuotaSnapshotLike[]
}) {
  const watches = new Map<string, Watch>()

  function runSide(watch: Watch, script: StatusScript) {
    if (watch.running.has(script.side) || watch.abort.signal.aborted) return
    watch.running.add(script.side)
    void runManaged({
      argv: script.command,
      cwd: watch.directory,
      env: { ...(options.env ?? process.env), MENDCODE_PROJECT_DIR: watch.directory, MENDCODE_STATUS_SIDE: script.side, MENDCODE_STATUS_FORMAT: "rows-v1", MEND_TUI_STATUS_FORMAT: "rows-v1", MENDCODE_USAGE_JSON: usageJson(options.quotas?.() ?? [], options.clock.now()), TERM: "dumb" },
      timeoutMs: script.timeoutMs,
      signal: watch.abort.signal,
    }).then((result) => {
      watch.running.delete(script.side)
      if (watch.abort.signal.aborted) return
      const failed = result.spawnError || result.exitCode !== 0 || result.timedOut
      const prepend = (segment: StatusSegment) => script.prepend ? { ...segment, prepend: true } : segment
      const rows = failed ? undefined : parseStatusRows(result.output)?.map((row) => row.map(prepend))
      // The old fields carry a bounded first row; terminals without rows support still have useful status.
      const segments = rows ? (rows[0] ?? []).slice(0, MAX_SEGMENTS).map((segment) => ({ ...segment, text: clip(segment.text) })) : failed ? [] : parseStatusOutput(result.output).map(prepend)
      const next = { ...watch.last, [script.side]: segments, [`${script.side}Rows`]: rows }
      if (JSON.stringify(next) === JSON.stringify(watch.last)) return
      watch.last = next
      options.publish(next)
    })
  }

  /** One timer per side, re-armed after each run; a run still going when the next tick comes is not doubled. */
  function schedule(watch: Watch, script: StatusScript) {
    const tick = () => {
      if (watch.abort.signal.aborted) return
      runSide(watch, script)
      watch.timers.set(script.side, options.clock.setTimer(script.refreshMs, tick))
    }
    tick()
  }

  function halt(watch: Watch) {
    watch.abort.abort()
    for (const timer of watch.timers.values()) timer.cancel()
    watch.timers.clear()
  }

  function start(directory: string): Watch {
    const { scripts, problems } = statusScripts(options.layersFor(directory))
    const allowed = scripts.filter((script) => script.source === "user" || options.isTrusted(directory))
    const skipped = scripts.length - allowed.length
    const watch: Watch = {
      directory,
      watchers: 0,
      timers: new Map(),
      running: new Set(),
      abort: new AbortController(),
      last: { directory, left: [], right: [], problems: skipped ? [...problems, "project status scripts run once the project is trusted in /tools"] : problems },
    }
    if (watch.last.problems.length) options.publish(watch.last)
    for (const script of allowed) schedule(watch, script)
    return watch
  }

  return {
    watch(directory: string) {
      const key = path.resolve(directory)
      const watch = watches.get(key) ?? start(key)
      watches.set(key, watch)
      watch.watchers++
      // A late watcher gets the current line at once.
      if (watch.watchers > 1) options.publish(watch.last)
      let done = false
      return () => {
        if (done) return
        done = true
        watch.watchers--
        if (watch.watchers > 0) return
        halt(watch)
        watches.delete(key)
      }
    },
    /** Watched directories, for diagnostics and tests. */
    active: () => [...watches.keys()],
    stop() {
      for (const watch of watches.values()) halt(watch)
      watches.clear()
    },
  }
}
