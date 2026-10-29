import type { HookInfo, HookRunInfo, HooksReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import { clip, deck, deckChrome, fit } from "./deck"
import { shortenMiddle, truncateEnd } from "./session-list"
import { formatDuration, todayTimeOrDateTime } from "./time"
import { wrap } from "./wrap"

/**
 * `/hooks`: the shell command hooks (`hooks.json`) of this project, which of them run, and the recent runs. Read-only
 * except for `t`, the same project trust `/tools` and `/trust` set. With `prompt` it is the startup trust prompt: the
 * project ships hooks, tools or extensions that wait for trust, and `y` or `n` answers it.
 */
export type HooksPageState = { selected: number; tab: "hooks" | "runs"; prompt: boolean }

/** `trust`: allow (true) or stop allowing (false) project-local hooks, tools and extensions in this directory. */
export type HooksPageAction = { type: "none" } | { type: "close" } | { type: "refresh" } | { type: "trust"; trusted: boolean }

const NONE: HooksPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const SWITCH = new Set(["\t", "\x1b[Z", "\x1b[C", "\x1b[D", "h", "l"])
const HINTS = "↑↓ select · tab or 1/2 switch · t trust this project · r refresh · esc back"
const PROMPT_HINTS = "y trust this project · n not now"
const TABS = [{ key: "1", label: "Hooks" }, { key: "2", label: "Recent runs" }]
const EXAMPLE = ["{", '  "hooks": { "PreToolUse": [ { "matcher": "bash",', '    "hooks": [ { "type": "command", "command": "./check.sh", "timeout": 10 } ] } ] }', "}"]

export function createHooksPageState(prompt = false): HooksPageState {
  return { selected: 0, tab: "hooks", prompt }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** Whether anything project-local waits for trust. */
export const pendingTotal = (report: HooksReport) => report.pending.hooks + report.pending.tools + report.pending.extensions + (report.pending.mcp ?? 0)

/** Handles one raw key. Returns the same state object when nothing changed. */
export function hooksPageKey(state: HooksPageState, key: string, report: HooksReport | undefined): { state: HooksPageState; action: HooksPageAction } {
  if (state.prompt) {
    if (key === "y" || key === "Y" || key === "\r") return { state, action: { type: "trust", trusted: true } }
    if (key === "n" || key === "N" || key === "\x1b" || key === "q") return { state, action: { type: "close" } }
    return { state, action: NONE }
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "r" || key === "R") return { state, action: { type: "refresh" } }
  if (key === "1" || key === "2") {
    const tab = key === "1" ? "hooks" : "runs"
    return tab === state.tab ? { state, action: NONE } : { state: { ...state, tab, selected: 0 }, action: NONE }
  }
  if (SWITCH.has(key)) return { state: { ...state, tab: state.tab === "hooks" ? "runs" : "hooks", selected: 0 }, action: NONE }
  const length = state.tab === "hooks" ? report?.hooks.length ?? 0 : report?.runs.length ?? 0
  const go = (index: number) => {
    const next = clamp(index, length)
    return next === state.selected ? { state, action: NONE } : { state: { ...state, selected: next }, action: NONE }
  }
  if (UP.has(key)) return go(state.selected - 1)
  if (DOWN.has(key)) return go(state.selected + 1)
  if (key === "t" && report) return { state, action: { type: "trust", trusted: !report.trusted } }
  return { state, action: NONE }
}

const outcomeTone = (outcome: HookRunInfo["outcome"]): ColorName => (outcome === "ok" ? "success" : outcome === "blocked" ? "warning" : "error")

/** An http hook whose URL is not in `allowedHttpHookUrls` (as opposed to a project hook waiting for trust). */
const notAllowed = (hook: HookInfo) => !hook.active && hook.inactiveReason?.includes("allowedHttpHookUrls") === true

function hookRow({ hook, selected, width, glyphs }: { hook: HookInfo; selected: boolean; width: number; glyphs: Glyphs }): Line {
  const label = hook.active ? truncateEnd(hook.layer ?? hook.source, 11) : notAllowed(hook) ? "not allowed" : "not trusted"
  const eventWidth = 18
  const matcherWidth = Math.min(14, Math.max(0, Math.floor(width / 5)))
  const labelWidth = 11
  const commandWidth = Math.max(0, width - 2 - 2 - eventWidth - 1 - (matcherWidth ? matcherWidth + 1 : 0) - labelWidth - 1)
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: "● ", fg: hook.active ? "success" : "warning" },
    { text: hook.event.padEnd(eventWidth), fg: selected ? "primary" : "text", bold: selected },
    { text: " " },
  ]
  if (matcherWidth) line.push({ text: truncateEnd(hook.matcher ?? "*", matcherWidth).padEnd(matcherWidth), fg: "muted" }, { text: " " })
  if (commandWidth >= 6) line.push({ text: shortenMiddle(hook.command.replace(/\s+/g, " "), commandWidth).padEnd(commandWidth), fg: "muted" }, { text: " " })
  line.push({ text: label.padStart(labelWidth), fg: hook.active ? "success" : "warning" })
  return fit(line, width)
}

function hookDetail({ hook, width }: { hook: HookInfo; width: number }): Line[] {
  const lines: Line[] = [
    ...wrap(`${hook.kind === "http" ? "posts" : hook.kind === "prompt" ? "asks " : "runs "} ${hook.command.replace(/\s+/g, " ")}`, width).slice(0, 3).map((text): Line => fit([{ text, fg: "body" }], width)),
    fit([{ text: `when  ${hook.matcher ? `${hook.event} · matches ${hook.matcher}` : hook.event} · ${hook.kind ?? "command"} · timeout ${formatDuration(hook.timeoutMs)}`, fg: "muted" }], width),
    fit([{ text: `layer ${hook.layer ?? hook.source}`, fg: "muted" }], width),
    fit([{ text: `file  ${truncateEnd(hook.file, width - 6)}${hook.pkg && !hook.layer ? ` (package ${hook.pkg})` : ""}`, fg: "muted", dim: true }], width),
  ]
  if (notAllowed(hook)) lines.push(...wrap("not allowed: add this url to the allowedHttpHookUrls setting to let it run", width).map((text): Line => fit([{ text, fg: "warning" }], width)))
  else if (!hook.active) lines.push(...wrap("not trusted: press t to let this project's hooks run (they run as commands, as you)", width).map((text): Line => fit([{ text, fg: "warning" }], width)))
  return lines
}

function runRow({ run, selected, width, now, glyphs }: { run: HookRunInfo; selected: boolean; width: number; now: number; glyphs: Glyphs }): Line {
  const at = todayTimeOrDateTime(run.at, now)
  const subject = run.tool ? `${run.event} · ${run.tool}` : run.event
  const outcome = run.exitCode !== undefined && run.outcome !== "ok" ? `${run.outcome} ${run.exitCode}` : run.outcome
  const fixed = 2 + 2 + 20 + 1 + 20 + 1 + 9 + 1 + 7
  const message = run.message ? shortenMiddle(run.message, Math.max(0, width - fixed - 1)) : ""
  return fit([
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: "● ", fg: outcomeTone(run.outcome) },
    { text: truncateEnd(at, 20).padEnd(20), fg: "muted" },
    { text: " " },
    { text: truncateEnd(subject, 20).padEnd(20), fg: selected ? "primary" : "text", bold: selected },
    { text: " " },
    { text: outcome.padEnd(9), fg: outcomeTone(run.outcome) },
    { text: " " },
    { text: formatDuration(run.durationMs).padStart(7), fg: "muted" },
    ...(message ? [{ text: ` ${message}`, fg: "muted" as ColorName }] : []),
  ], width)
}

function promptBody({ report, width }: { report: HooksReport; width: number }): Line[] {
  const items = [
    ...(report.pending.hooks ? [plural(report.pending.hooks, "shell hook")] : []),
    ...(report.pending.tools ? [plural(report.pending.tools, "custom tool")] : []),
    ...(report.pending.extensions ? [plural(report.pending.extensions, "extension")] : []),
    ...(report.pending.mcp ? [plural(report.pending.mcp, "MCP server")] : []),
  ]
  const lines: Line[] = [
    [{ text: "Trust the code in this project?", fg: "text", bold: true }],
    [],
    ...wrap(`${report.directory} ships ${items.join(", ")} that run commands on this machine, as you.`, width).map((text): Line => [{ text, fg: "body" }]),
    [],
  ]
  for (const hook of report.hooks.filter((entry) => !entry.active && !notAllowed(entry)).slice(0, 6)) lines.push(clip([{ text: `  ${hook.event.padEnd(18)} `, fg: "text" }, { text: shortenMiddle(hook.command.replace(/\s+/g, " "), Math.max(4, width - 20)), fg: "muted" }], width))
  if (report.pending.hooks > 6) lines.push([{ text: `  … ${report.pending.hooks - 6} more`, fg: "muted" }])
  lines.push([], ...wrap("Nothing from the project runs until you trust it. You can change this later with /trust.", width).map((text): Line => [{ text, fg: "muted" }]))
  return lines
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderHooksPage(input: { report: HooksReport; state: HooksPageState; now: number; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { report, state, width } = input
  const height = Math.max(0, input.height)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const inner = Math.max(1, width - 2)

  if (state.prompt) return deck({ page: "Trust", subtitle: "this project", status: { label: `${pendingTotal(report)} waiting`, tone: "warn" }, body: promptBody({ report, width: inner }), hints: PROMPT_HINTS, width, height })

  const room = Math.max(0, height - deckChrome(HINTS, width, { tabs: true }))
  const problems = report.problems.slice(0, 3).map((problem): Line => clip([{ text: truncateEnd(problem, inner), fg: "warning" }], width))
  const header: Line[] = [
    ...(report.enabled ? [] : [fit([{ text: "hooks are off: the daemon runs with MENDCODE_HOOKS=0", fg: "warning" }], inner)]),
    ...(report.pending.hooks ? [fit([{ text: `${plural(report.pending.hooks, "project hook")} not trusted · press t`, fg: "warning" }], inner)] : []),
  ]
  let body: Line[]
  let summary = ""
  if (state.tab === "hooks") {
    if (report.hooks.length === 0) {
      body = [fit([{ text: "no hooks · add hooks.json to the data dir or .mendcode/", fg: "muted" }], inner), [], ...EXAMPLE.map((text): Line => fit([{ text, fg: "code" }], inner))]
    } else {
      const selected = clamp(state.selected, report.hooks.length)
      const detail = hookDetail({ hook: report.hooks[selected]!, width: inner })
      const capacity = Math.max(1, room - header.length - problems.length - detail.length - 1)
      const count = Math.min(report.hooks.length, capacity)
      const start = selected < count ? 0 : selected - count + 1
      const shown = report.hooks.slice(start, start + count)
      summary = `${plural(report.hooks.length, "hook")}${shown.length < report.hooks.length ? ` · ${start + 1}-${start + shown.length} shown` : ""}`
      body = [...shown.map((hook, offset) => hookRow({ hook, selected: start + offset === selected, width: inner, glyphs })), [], ...detail]
    }
  } else if (report.runs.length === 0) body = [fit([{ text: "no hook has run yet in this daemon", fg: "muted" }], inner)]
  else {
    const selected = clamp(state.selected, report.runs.length)
    const count = Math.max(1, Math.min(report.runs.length, room - header.length - problems.length))
    const start = selected < count ? 0 : selected - count + 1
    summary = `${plural(report.runs.length, "run")}${count < report.runs.length ? ` · ${start + 1}-${start + count} shown` : ""}`
    body = report.runs.slice(start, start + count).map((run, offset) => runRow({ run, selected: start + offset === selected, width: inner, now: input.now, glyphs }))
  }
  const status = report.pending.hooks ? { label: `${report.pending.hooks} not trusted`, tone: "warn" as const } : undefined
  return deck({ page: "Hooks", subtitle: report.trusted ? "project trusted" : "project not trusted", summary, ...(status ? { status } : {}), body: [...header, ...body, ...(problems.length ? [[], ...problems] : [])], hints: HINTS, tabs: TABS, activeTab: state.tab === "hooks" ? 0 : 1, width, height })
}
