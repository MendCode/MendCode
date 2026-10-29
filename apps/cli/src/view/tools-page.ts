import type { CustomToolInfo, CustomToolsReport } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type ColorName, type Glyphs, type Line } from "../ui/theme"
import { isWide } from "../ui/breakpoints"
import type { DeckStatus } from "./deck"
import { beside, clip, deck, deckChrome, fit } from "./deck"
import { shortenMiddle, truncateEnd } from "./session-list"
import { textWidth, wrap } from "./wrap"

export type ToolsPageState = { selected: number }

/** `trust`: allow (true) or stop allowing (false) the project's `.mendcode/tools` to run. */
export type ToolsPageAction = { type: "none" } | { type: "close" } | { type: "trust"; trusted: boolean }

const NONE: ToolsPageAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j"])
const MAX_DESCRIPTION_LINES = 3

const HINTS = "↑↓ select · t trust this project · esc back"

const EXAMPLE = ["{", '  "description": "Count words in a file",', '  "command": ["./wc.sh"],', '  "args": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }', "}"]

export function createToolsPageState(): ToolsPageState {
  return { selected: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

const projectTools = (tools: CustomToolInfo[]) => tools.filter((tool) => tool.source === "project")
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** Handles one raw key. Returns the same state object when nothing changed. */
export function toolsPageKey(state: ToolsPageState, key: string, tools: CustomToolInfo[]): { state: ToolsPageState; action: ToolsPageAction } {
  const selected = clamp(state.selected, tools.length)
  const go = (index: number) => {
    const next = clamp(index, tools.length)
    return next === state.selected ? { state, action: NONE } : { state: { selected: next }, action: NONE }
  }
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (UP.has(key)) return go(selected - 1)
  if (DOWN.has(key)) return go(selected + 1)
  if (key === "t") {
    const project = projectTools(tools)
    if (project.length === 0) return { state, action: NONE }
    return { state, action: { type: "trust", trusted: !project.every((tool) => tool.trusted) } }
  }
  return { state, action: NONE }
}

function stateOf(tool: CustomToolInfo): { label: string; fg: ColorName } {
  if (tool.source === "user") return { label: "user", fg: "success" }
  return tool.trusted ? { label: "trusted", fg: "success" } : { label: "not trusted", fg: "warning" }
}

function row({ tool, selected, width, nameWidth, glyphs }: { tool: CustomToolInfo; selected: boolean; width: number; nameWidth: number; glyphs: Glyphs }): Line {
  const state = stateOf(tool)
  const labelWidth = 11
  const fixed = 2 + 2 + nameWidth + 1
  const commandWidth = Math.max(0, width - fixed - labelWidth - 1)
  const command = commandWidth >= 6 ? shortenMiddle(tool.command.join(" "), commandWidth) : ""
  const line: Line = [
    selected ? { text: `${glyphs.user} `, fg: "primary", bold: true } : { text: "  " },
    { text: "● ", fg: state.fg },
    { text: truncateEnd(tool.name, nameWidth).padEnd(nameWidth), fg: selected ? "primary" : "text", bold: selected },
    { text: " " },
  ]
  if (command) line.push({ text: command.padEnd(commandWidth), fg: "muted" }, { text: " " })
  line.push({ text: state.label.padStart(labelWidth), fg: state.fg })
  return fit(line, width)
}

function detailLines({ tool, width, height }: { tool: CustomToolInfo; width: number; height: number }): Line[] {
  if (height <= 0) return []
  const inner = Math.max(1, width)
  const lines: Line[] = [fit([{ text: truncateEnd(tool.toolName, inner), fg: "text", bold: true }, { text: ` · ${stateOf(tool).label}`, fg: stateOf(tool).fg }], inner)]
  const description = wrap(tool.description.replace(/\s+/g, " ").trim(), inner)
  const shown = description.slice(0, MAX_DESCRIPTION_LINES)
  if (description.length > MAX_DESCRIPTION_LINES) shown[MAX_DESCRIPTION_LINES - 1] = truncateEnd(`${shown[MAX_DESCRIPTION_LINES - 1]}…`, inner)
  for (const text of shown) lines.push(fit([{ text: truncateEnd(text, inner), fg: "body" }], inner))
  lines.push(fit([{ text: `runs  ${truncateEnd(tool.command.join(" "), inner - 6)}`, fg: "muted" }], inner))
  lines.push(fit([{ text: `file  ${truncateEnd(tool.file, inner - 6)}`, fg: "muted", dim: true }], inner))
  if (!tool.trusted) lines.push(...wrap("not trusted: press t to let this project's tools run (they run as commands, after approval)", inner).map((text): Line => fit([{ text, fg: "warning" }], inner)))
  return lines.slice(0, height)
}

const issueLine = (issue: CustomToolsReport["issues"][number], width: number): Line => {
  const prefix = `${issue.file.split("/").pop()}: `
  return clip([{ text: `${prefix}${truncateEnd(issue.message, Math.max(1, width - textWidth(prefix)))}`, fg: "warning" }], width)
}

/** Untrusted project tools are a warning on the right of the title row. */
function statusOf(tools: CustomToolInfo[]): DeckStatus | undefined {
  const untrusted = projectTools(tools).filter((tool) => !tool.trusted).length
  return untrusted > 0 ? { label: `${untrusted} not trusted`, tone: "warn" } : undefined
}

/** Renders exactly `height` lines of at most `width` cells. */
export function renderToolsPage(input: { report: CustomToolsReport; state: ToolsPageState; width: number; height: number; glyphs?: Glyphs }): Line[] {
  const { report, state, width } = input
  const height = Math.max(0, input.height)
  const glyphs = input.glyphs ?? defaultGlyphs()
  const tools = report.tools
  const status = statusOf(tools)
  const inner = Math.max(1, width - 2)
  const room = Math.max(0, height - deckChrome(HINTS, width))
  let summary = ""

  let body: Line[]
  if (tools.length === 0) {
    const lines: Line[] = [
      fit([{ text: "no custom tools · add .mendcode/tools/<name>.json", fg: "muted" }], inner),
      [],
      ...EXAMPLE.map((text): Line => fit([{ text, fg: "code" }], inner)),
    ]
    if (report.issues.length > 0) {
      lines.push([])
      for (const issue of report.issues.slice(0, 2)) lines.push(issueLine(issue, inner))
    }
    body = lines
  } else {
    const selected = clamp(state.selected, tools.length)
    const nameWidth = Math.max(4, Math.min(20, Math.floor(inner / 4), Math.max(...tools.map((t) => textWidth(t.name)))))
    const wide = isWide(width) && height >= 24
    const listWidth = wide ? Math.max(32, Math.min(64, Math.floor(inner * 0.5))) : inner
    const detailWidth = wide ? inner - listWidth - 4 : inner
    const issue = report.issues[0]
    const issueRows = issue ? 2 : 0
    // Stacked: the list gets up to half of the room (the rest is the detail); side by side: all of it.
    const capacity = wide ? room - issueRows : Math.floor((room - issueRows - 1) / 2)
    const count = Math.max(1, Math.min(tools.length, capacity))
    const start = selected < count ? 0 : selected - count + 1
    const shown = tools.slice(start, start + count)
    const list = shown.map((tool, offset) => row({ tool, selected: start + offset === selected, width: listWidth, nameWidth: Math.min(nameWidth, Math.max(4, listWidth - 4)), glyphs }))
    summary = `${plural(tools.length, "tool")}${shown.length < tools.length ? ` · ${start + 1}-${start + shown.length} shown` : ""}`
    const detail = detailLines({ tool: tools[selected]!, width: detailWidth, height: wide ? room : Math.max(3, room - issueRows - list.length - 1) })
    const main = wide ? beside([{ lines: list, width: listWidth }, { lines: detail, width: detailWidth }], 4) : [...list, [], ...detail]
    body = [...(issue ? [issueLine(issue, inner), []] : []), ...main]
  }

  return deck({ page: "Tools", subtitle: "custom tools", summary, ...(status ? { status } : {}), body, hints: HINTS, width, height })
}
