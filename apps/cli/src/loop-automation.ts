import path from "node:path"
import type { Loop, LoopJournalEvent, LoopSnapshot, LoopTemplateInfo, LoopTrigger, LoopBudget, LoopTickResult } from "@mendcode/protocol"
import type { AutomationDeps, Common, ParseResult } from "./automation"
import { PROGRAM_NAME } from "@mendcode/program"

export type LoopAutomation =
  | { kind: "loop.status"; all: boolean }
  | { kind: "loop.templates" }
  | { kind: "loop.draft"; name?: string; objective?: string; template?: string; trigger?: LoopTrigger; budget?: LoopBudget; reportOnly?: boolean }
  | { kind: "loop.show"; id: string }
  | { kind: "loop.tail"; id: string; limit: number }
  | { kind: "loop.monitor"; id: string; once: boolean; intervalMs: number }
  | { kind: "loop.tick"; id?: string; limit: number; execute: boolean; reportOnly: boolean }
  | { kind: "loop.activate"; id: string; reason?: string }

export const LOOP_CONTROL_USAGE = [
  "  status [--all]                                state, budget, next wake and scheduler",
  "  examples|templates                           built-in templates",
  "  draft [NAME OBJECTIVE] [--template ID] [--name N] [--objective O] [--interval-ms N | --daily-at HH:MM --timezone Z]",
  "  show <id>                                    objective, runs, children and journal",
  "  tail <id> [--limit N]                         last 50 journal events (1–200); JSON lines with --json",
  "  monitor <id> [--once] [--interval-ms N]        refresh every 2000ms; non-TTY prints once",
  "  tick [id] [--limit N] [--execute] [--report-only]  dry-run unless --execute; due loops default limit 1",
  "  activate <id> [--reason TEXT] [--no-service]   enable the integrated daemon scheduler",
  "  aliases: loops … · control-plane loops …",
].join("\n")

/** v1 plural/control-plane spelling; existing singular commands retain their parser. */
function commandOffset(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith("--")) return i
    if (token === "--dir" || token === "--format") i++
  }
  return -1
}

export function loopAliases(argv: string[]) {
  const index = commandOffset(argv)
  if (argv[index] === "control-plane" && (argv[index + 1] === "loops" || argv[index + 1] === "loop")) return [...argv.slice(0, index), "loop", ...argv.slice(index + 2)]
  return argv[index] === "loops" ? [...argv.slice(0, index), "loop", ...argv.slice(index + 1)] : argv
}

const KINDS = new Set(["loop.status", "loop.templates", "loop.draft", "loop.show", "loop.tail", "loop.monitor", "loop.tick", "loop.activate"])
export const isLoopAutomation = (input: { kind: string }): input is LoopAutomation & Common => KINDS.has(input.kind)

export function parseLoopAutomation(argv: string[]): ParseResult | undefined {
  const commandIndex = commandOffset(argv)
  if (argv[commandIndex] !== "loop" || argv.includes("--version")) return
  const sub = argv[commandIndex + 1]?.startsWith("--") ? "status" : argv[commandIndex + 1] ?? "status"
  if (!["status", "examples", "templates", "draft", "show", "tail", "monitor", "tick", "activate"].includes(sub) || argv.includes("--help")) return
  const values = new Set(["dir", "format", "name", "objective", "template", "interval-ms", "daily-at", "timezone", "every", "daily", "limit", "reason", "runs"])
  const booleans = new Set(["json", "all", "once", "execute", "report-only", "no-service", "goal", "dry-run"])
  const flags = new Map<string, string | true>()
  const args: string[] = []
  const bad = (message: string): ParseResult => ({ ok: false, message, topic: "loop" })
  for (let i = 0; i < argv.length; i++) {
    if (i === commandIndex || i === commandIndex + 1 && argv[i] === sub) continue
    const token = argv[i]!
    if (token === "--") { args.push(...argv.slice(i + 1)); break }
    if (!token.startsWith("--")) { args.push(token); continue }
    const [key, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (booleans.has(key!)) {
      if (inline !== undefined) return bad(`--${key} takes no value`)
      flags.set(key!, true)
    } else if (values.has(key!)) {
      const value = inline ?? argv[++i]
      if (!value || value.startsWith("--")) return bad(`--${key} needs a value`)
      flags.set(key!, value)
    } else return bad(`unknown flag --${key}`)
  }
  const allowed: Record<string, string[]> = {
    status: ["all"], examples: [], templates: [], draft: ["name", "objective", "template", "interval-ms", "daily-at", "timezone", "every", "daily", "runs", "goal", "report-only"],
    show: [], tail: ["limit"], monitor: ["once", "interval-ms"], tick: ["limit", "execute", "report-only", "dry-run"], activate: ["reason", "no-service"],
  }
  for (const flag of flags.keys()) if (!["dir", "format", "json", ...allowed[sub]!].includes(flag)) return bad(`--${flag} is not valid for loop ${sub}`)
  const str = (key: string) => typeof flags.get(key) === "string" ? flags.get(key) as string : undefined
  const common: Common = { json: flags.has("json") || str("format") === "json", ...(str("dir") ? { dir: str("dir")! } : {}) }
  if (str("format") && !["json", "text", "table"].includes(str("format")!)) return bad("--format must be json, text or table")
  const ok = (command: LoopAutomation): ParseResult => ({ ok: true, command: { ...common, ...command } })
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(str(key) ?? fallback)
    return Number.isInteger(value) && value >= min && value <= max ? value : undefined
  }
  if (sub === "status" || sub === "examples" || sub === "templates") return args.length ? bad(`loop ${sub} takes no arguments`) : ok(sub === "status" ? { kind: "loop.status", all: flags.has("all") } : { kind: "loop.templates" })
  if (sub === "draft") {
    const template = str("template")
    const name = str("name") ?? (str("objective") ? args[0] : args.length > 1 ? args[0] : undefined)
    const objective = (str("objective") ?? (str("name") ? args.join(" ") : args.slice(1).join(" "))) || undefined
    if (!template && (!name || !objective)) return bad("loop draft needs --template or a name and objective")
    if (name && name.length > 120 || objective && objective.length > 8_000) return bad("draft name/objective is too long")
    if (flags.has("interval-ms") && flags.has("every") || flags.has("daily-at") && flags.has("daily")) return bad("choose one interval or daily spelling")
    const daily = str("daily-at") ?? str("daily")
    const interval = flags.has("interval-ms") || flags.has("every")
    if (interval && (daily || flags.has("timezone"))) return bad("choose interval or daily scheduling")
    let trigger: LoopTrigger | undefined
    if (daily || flags.has("timezone")) {
      if (!daily || !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily)) return bad("daily scheduling needs HH:MM")
      const timezone = str("timezone")
      if (timezone) { try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }) } catch { return bad("unknown time zone") } }
      trigger = { kind: "daily", at: daily, ...(timezone ? { timezone } : {}) }
    } else if (interval) {
      const span = /^(\d+)(m|h|d)$/.exec(str("every") ?? "")
      const everyMs = str("every") ? span ? Number(span[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as "m" | "h" | "d"]) : NaN : integer("interval-ms", 60_000, 60_000, 30 * 86_400_000)
      if (!everyMs || !Number.isInteger(everyMs) || everyMs < 60_000 || everyMs > 30 * 86_400_000) return bad("interval must be 1 minute to 30 days")
      trigger = { kind: "interval", everyMs }
    }
    const runs = flags.has("runs") ? integer("runs", 1, 1, 1_000) : undefined
    if (flags.has("runs") && runs === undefined) return bad("--runs must be 1–1000")
    const budget: LoopBudget | undefined = flags.has("goal") ? { mode: "goal", ...(runs ? { maxRuns: runs } : {}) } : runs ? { mode: "fixed", maxRuns: runs } : undefined
    return ok({ kind: "loop.draft", ...(name ? { name } : {}), ...(objective ? { objective } : {}), ...(template ? { template } : {}), ...(trigger ? { trigger } : {}), ...(budget ? { budget } : {}), ...(flags.has("report-only") ? { reportOnly: true } : {}) })
  }
  if (sub !== "tick" && !args[0]) return bad(`loop ${sub} needs <id>`)
  if (args.length > 1) return bad(`loop ${sub} takes at most one id`)
  if (sub === "tick" || sub === "tail") {
    const limit = integer("limit", sub === "tick" ? 1 : 50, 1, sub === "tick" ? 100 : 200)
    if (limit === undefined) return bad(`--limit must be 1–${sub === "tick" ? 100 : 200}`)
    if (sub === "tail") return ok({ kind: "loop.tail", id: args[0]!, limit })
    if (flags.has("execute") && flags.has("dry-run")) return bad("--execute and --dry-run conflict")
    return ok({ kind: "loop.tick", ...(args[0] ? { id: args[0] } : {}), limit, execute: flags.has("execute"), reportOnly: flags.has("report-only") })
  }
  if (sub === "monitor") {
    const intervalMs = integer("interval-ms", 2_000, 100, 3_600_000)
    return intervalMs === undefined ? bad("--interval-ms must be 100–3600000") : ok({ kind: "loop.monitor", id: args[0]!, once: flags.has("once"), intervalMs })
  }
  if (sub === "show") return ok({ kind: "loop.show", id: args[0]! })
  const reason = str("reason")
  if (reason && reason.length > 500) return bad("--reason is at most 500 characters")
  return ok({ kind: "loop.activate", id: args[0]!, ...(reason ? { reason } : {}) })
}

const time = (at: number | undefined) => at === undefined ? "none" : new Date(at).toISOString()
const triggerText = (trigger: LoopTrigger) => trigger.kind === "daily" ? `daily ${trigger.at}${trigger.timezone ? ` ${trigger.timezone}` : ""}` : trigger.kind === "interval" || trigger.kind === "adaptive" ? `${trigger.kind} ${trigger.everyMs}ms` : trigger.kind
export function loopStatusText(loops: Loop[]) {
  return loops.length ? loops.map((loop) => `${loop.loopId}  ${loop.draft ? "draft" : loop.state}  ${loop.name}  ${triggerText(loop.trigger)}  budget=${loop.budget.mode}${"maxRuns" in loop.budget && loop.budget.maxRuns ? `≤${loop.budget.maxRuns}` : ""}  runs=${loop.runs}  next=${time(loop.nextWakeAt)}  scheduler=integrated`).join("\n") + "\n" : "Loop workflows: none\n"
}
export function loopEventsText(events: LoopJournalEvent[]) {
  return events.length ? events.map((event) => `${time(event.at)} ${event.type.padEnd(12)} ${event.title}`).join("\n") + "\n" : "No loop events.\n"
}
export function loopSnapshotText(snapshot: LoopSnapshot) {
  const { loop, scheduler, children, events } = snapshot
  return [
    `Loop Workflow: ${loop.name}`, `ID: ${loop.loopId}`, `State: ${loop.draft ? "draft" : loop.state}    Next: ${time(loop.nextWakeAt)}`,
    `Scheduler: ${scheduler.kind}${scheduler.overdue ? " · overdue" : ""}`,
    `Budget: ${loop.budget.mode}${"maxRuns" in loop.budget && loop.budget.maxRuns ? ` ≤${loop.budget.maxRuns}` : ""}    Runs: ${loop.runs}    Children: ${children.length}`,
    `Root session: ${loop.sessionId}`, `Trigger: ${triggerText(loop.trigger)}`, `Mode: ${loop.reportOnly ? "report-only" : "edits"}`, ...(loop.reason ? [`Reason: ${loop.reason}`] : []),
    "", "Objective", loop.objective, ...(loop.criteria ? ["", "Done when", loop.criteria] : []), "", "Children",
    ...(children.length ? children.map((child) => `  ${child.state} ${child.title} (${child.sessionId})`) : ["  none"]),
    "", "Runs", ...(loop.history.length ? loop.history.map((run) => `  #${run.run} ${run.outcome ?? "running"} ${run.checkpoint?.summary ?? ""}${run.sessionId ? ` (${run.sessionId})` : ""}`) : ["  none"]),
    "", "Journal", loopEventsText(events).trimEnd(),
  ].join("\n") + "\n"
}

export async function runLoopAutomation(command: LoopAutomation & Common, deps: AutomationDeps): Promise<number> {
  const dir = command.projectDir ? path.resolve(deps.cwd, command.projectDir) : deps.cwd
  const result = (data: Record<string, unknown>, text: string) => { deps.out.write(command.json ? `${JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "result", command: command.kind, data })}\n` : text); return 0 }
  const fail = (message: string, code = "failed") => { (command.json ? deps.out : deps.err).write(command.json ? `${JSON.stringify({ schema: "mendcode-next.cli.v1", kind: "error", command: command.kind, error: { code, message } })}\n` : `error: ${message}\n`); return 1 }
  const send = async (input: Parameters<typeof deps.client.send>[0]) => deps.client.send(input)
  if (command.kind === "loop.status") {
    const reply = await send({ type: "loop.list", ...(command.all ? {} : { directory: dir }) })
    return reply.ok ? result(reply.result ?? {}, loopStatusText((reply.result?.loops ?? []) as Loop[])) : fail(reply.error.message, reply.error.code)
  }
  if (command.kind === "loop.templates") {
    const reply = await send({ type: "loop.templates" })
    return reply.ok ? result(reply.result ?? {}, ((reply.result?.templates ?? []) as LoopTemplateInfo[]).map((template) => `${template.id} — ${template.name}\n  ${template.description}\n  ${template.summary}\n  ${PROGRAM_NAME} loops draft --template ${template.id}`).join("\n\n") + "\n") : fail(reply.error.message, reply.error.code)
  }
  if (command.kind === "loop.draft") {
    const { kind: _kind, json: _json, dir: _dir, projectDir: _project, compat: _compat, ...input } = command
    const reply = await send({ type: "loop.draft", directory: dir, ...input })
    return reply.ok ? result(reply.result ?? {}, `Created loop draft: ${loopStatusText([reply.result?.loop as Loop])}`) : fail(reply.error.message, reply.error.code)
  }
  if (command.kind === "loop.activate") {
    const reply = await send({ type: "loop.activate", loopId: command.id as never, ...(command.reason ? { reason: command.reason } : {}) })
    return reply.ok ? result(reply.result ?? {}, `Loop updated: ${loopStatusText([reply.result?.loop as Loop])}`) : fail(reply.error.message, reply.error.code)
  }
  if (command.kind === "loop.tail") {
    const reply = await send({ type: "loop.events", loopId: command.id as never, limit: command.limit })
    if (!reply.ok) return fail(reply.error.message, reply.error.code)
    const events = (reply.result?.events ?? []) as LoopJournalEvent[]
    if (command.json) { for (const event of events) deps.out.write(JSON.stringify(event) + "\n"); return 0 }
    return result({ events }, loopEventsText(events))
  }
  if (command.kind === "loop.tick") {
    const reply = await send({ type: "loop.tick", directory: dir, ...(command.id ? { loopId: command.id as never } : {}), limit: command.limit, execute: command.execute, reportOnly: command.reportOnly })
    if (!reply.ok) return fail(reply.error.message, reply.error.code)
    const results = (reply.result?.results ?? []) as LoopTickResult[]
    result({ results }, results.length ? results.map((item) => `${item.loopId} ${item.state}${item.run ? ` run=${item.run}` : ""} ${item.summary}`).join("\n") + "\n" : "No loop workflows due.\n")
    return results.some((item) => item.timedOut) ? 3 : results.some((item) => item.state === "failed" || item.state === "interrupted") ? 1 : 0
  }
  let monitorScreen: import("./ui/screen").Screen | undefined
  let stopped = false
  const once = async () => {
    const reply = await send({ type: "loop.snapshot", loopId: command.id as never })
    if (stopped) return 0
    if (!reply.ok) return fail(reply.error.message, reply.error.code)
    if (command.kind === "loop.monitor" && !command.json && (deps.isTTY ?? process.stdout.isTTY)) {
      const { renderLoopMonitor } = await import("./view/loop-monitor")
      const width = deps.terminalSize?.width ?? process.stdout.columns ?? 100
      const height = deps.terminalSize?.height ?? process.stdout.rows ?? 30
      const rows = renderLoopMonitor(reply.result as unknown as LoopSnapshot, width, height)
      if (deps.drawLoopFrame) deps.drawLoopFrame(rows)
      else {
        const { createScreen } = await import("./ui/screen")
        monitorScreen ??= createScreen({ write: (text) => deps.out.write(text), columns: width, rows: height, isTTY: true }, { ...process.env, MENDCODE_MOUSE: "0", MENDCODE_TERMINAL_TITLE: "0" })
        if (monitorScreen.size.width !== width || monitorScreen.size.height !== height) monitorScreen.resize(width, height)
        monitorScreen.draw(rows, { row: height - 1, col: 0 })
      }
      return 0
    }
    return result(reply.result ?? {}, loopSnapshotText(reply.result as unknown as LoopSnapshot))
  }
  const code = await once()
  if (code || command.kind === "loop.show" || command.once || !(deps.isTTY ?? process.stdout.isTTY)) return code
  return new Promise<number>((resolve) => {
    let timer: { cancel(): void } | undefined
    const stop = (code = 0) => { stopped = true; timer?.cancel(); resolve(code) }
    deps.onInterrupt(() => stop())
    const schedule = () => {
      if (stopped) return
      const callback = () => { if (!stopped) void once().then((code) => code ? stop(code) : schedule()).catch((error: unknown) => stop(stopped ? 0 : fail(String(error)))) }
      timer = deps.setTimer ? deps.setTimer(command.intervalMs, callback) : (() => { const id = setTimeout(callback, command.intervalMs); return { cancel: () => clearTimeout(id) } })()
    }
    schedule()
  })
}
