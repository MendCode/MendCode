import type { ColorName, Glyphs, Line } from "../ui/theme"
import { panelGrid } from "./deck"
import type { Detected, ModelGroupInfo, ModelOption, UnavailableSource } from "./onboarding-detect"
import { textWidth } from "./wrap"

/**
 * The Model choice's list inside `/setup`: every model found, grouped by who runs it (MendCode's own engine: the ChatGPT
 * subscription and each keyed provider; then the Claude Code, Codex, pi and ACP harnesses), what was found but lists no model
 * yet, and the `/connect` rows that add one. Space on the Model row opens it; Enter on a model picks it and comes back, Enter
 * on a sign-in row runs that `/connect` and comes back to the list, checked again. Nothing is saved until the page's final Enter.
 */
export type ModelPicker = { /** The focused row: a model id, or `connect:<target>`; a recheck that drops it falls back to the first model. */ focus?: string }

/** A sign-in row the list offers: `/connect <target>`, the provider list when the target is empty; `source` is what it would add. */
export type ModelConnect = { target: string; label: string; source: "chatgpt" | "api" }

type ListRow =
  | { kind: "section"; text: string }
  | { kind: "group"; group: ModelGroupInfo; count: number }
  | { kind: "model"; option: ModelOption }
  | { kind: "connect"; connect: ModelConnect; /** Why it is offered, when that source lists nothing yet. */ reason?: string }
  | { kind: "missing"; missing: UnavailableSource }

const SECTIONS = [
  { native: true, text: "MendCode's own engine · signs in itself" },
  { native: false, text: "External harnesses · their own login" },
] as const

const connectKey = (target: string) => `connect:${target}`
const rowKey = (row: ListRow) => row.kind === "model" ? row.option.id : row.kind === "connect" ? connectKey(row.connect.target) : undefined

/** The sign-in rows for what MendCode's engine still lacks: the ChatGPT login when it is missing, and always a way to add a key. */
export function modelConnects(detected: Detected | undefined, signIn: ReadonlyArray<{ id: string; target: string }>): ModelConnect[] {
  const chatgpt = detected?.items.find((item) => item.id === "chatgpt")
  return signIn.flatMap((row): ModelConnect[] => row.id === "chatgpt"
    ? chatgpt && !chatgpt.ok ? [{ target: row.target, label: "Sign in to ChatGPT · /connect chatgpt", source: "chatgpt" }] : []
    : [{ target: row.target, label: "Add an API-key provider · /connect", source: "api" }])
}

/** The list, in order: each section's groups with their models, then what is missing there, then (MendCode's engine) its sign-in rows. */
function listRows(detected: Detected | undefined, connects: readonly ModelConnect[]): ListRow[] {
  const rows: ListRow[] = []
  for (const section of SECTIONS) {
    const groups = (detected?.groups ?? []).filter((group) => group.native === section.native)
    const missing = (detected?.unavailable ?? []).filter((entry) => entry.native === section.native)
    const signIn = section.native ? connects : []
    if (!groups.length && !missing.length && !signIn.length) continue
    rows.push({ kind: "section", text: section.text })
    for (const group of groups) {
      const options = (detected?.options ?? []).filter((option) => option.group === group.key)
      rows.push({ kind: "group", group, count: options.length })
      for (const option of options) rows.push({ kind: "model", option })
    }
    // A source a sign-in row adds is said on that row, not twice.
    for (const entry of missing) if (!signIn.some((connect) => connect.source === entry.source)) rows.push({ kind: "missing", missing: entry })
    for (const connect of signIn) {
      const reason = missing.find((entry) => entry.source === connect.source)?.reason.split(" · ")[0]
      rows.push({ kind: "connect", connect, ...(reason ? { reason } : {}) })
    }
  }
  return rows
}

/** The focused row's key: the one kept when it is still listed, else the chosen model, else the first row Enter acts on. */
function focusOf(rows: readonly ListRow[], picker: ModelPicker, chosen: string | undefined): string | undefined {
  const keys = rows.map(rowKey).filter((key): key is string => key !== undefined)
  if (picker.focus && keys.includes(picker.focus)) return picker.focus
  if (chosen && keys.includes(chosen)) return chosen
  return rows.find((row) => row.kind === "model") ? rowKey(rows.find((row) => row.kind === "model")!) : keys[0]
}

export const openModelPicker = (chosen: string | undefined): ModelPicker => (chosen ? { focus: chosen } : {})

const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j", "\t"])

export type ModelPickerResult =
  | { picker: ModelPicker; action?: undefined }
  /** Closed: `model` is the pick (Enter on a model), absent when Esc left it unchanged. */
  | { picker: undefined; model?: string }
  | { picker: ModelPicker; action: { type: "connect"; target: string } | { type: "recheck" } }

/** One key in the list. Nothing here writes: a pick only changes the page's Model value. */
export function modelPickerKey(input: { picker: ModelPicker; key: string; detected: Detected | undefined; connects: readonly ModelConnect[]; chosen: string | undefined }): ModelPickerResult {
  const { picker, key } = input
  const rows = listRows(input.detected, input.connects)
  const keys = rows.map(rowKey).filter((entry): entry is string => entry !== undefined)
  const focus = focusOf(rows, picker, input.chosen)
  const at = focus ? keys.indexOf(focus) : -1
  if (key === "\x1b") return { picker: undefined }
  if (key === "r") return { picker, action: { type: "recheck" } }
  if (!keys.length) return { picker }
  if (UP.has(key)) return { picker: { focus: keys[Math.max(0, at - 1)]! } }
  if (DOWN.has(key)) return { picker: { focus: keys[Math.min(keys.length - 1, at + 1)]! } }
  if (key === "g") return { picker: { focus: keys[0]! } }
  if (key === "G") return { picker: { focus: keys[keys.length - 1]! } }
  if (key === "\r" || key === " ") {
    const row = rows.find((entry) => rowKey(entry) === focus)
    if (row?.kind === "model") return { picker: undefined, model: row.option.id }
    if (row?.kind === "connect" && key === "\r") return { picker: { focus: focus! }, action: { type: "connect", target: row.connect.target } }
  }
  return { picker }
}

/** The focused row of the list, for the page's key hints. */
export function modelPickerFocus(input: { picker: ModelPicker; detected: Detected | undefined; connects: readonly ModelConnect[]; chosen: string | undefined }): "model" | "connect" | undefined {
  const rows = listRows(input.detected, input.connects)
  const focus = focusOf(rows, input.picker, input.chosen)
  const row = rows.find((entry) => rowKey(entry) === focus)
  return row?.kind === "model" || row?.kind === "connect" ? row.kind : undefined
}

/** `recommended`, `current` or nothing, beside a model's name. */
const tagOf = (option: ModelOption) => option.current ? "current" : option.recommended ? "recommended" : ""

function rowLines(row: ListRow, input: { width: number; focus: string | undefined; chosen: string | undefined; glyphs: Glyphs; nameWidth: number }): Line[] {
  const { width, glyphs } = input
  if (row.kind === "section") return [[{ text: row.text, fg: "muted", bold: true }]]
  if (row.kind === "group") {
    const head = `${row.group.title}  ${row.count}`
    const room = width - 2 - textWidth(head) - 3
    return [[{ text: "  " }, { text: row.group.title, fg: "text", bold: true }, { text: `  ${row.count}`, fg: "muted" }, ...(room >= 12 ? [{ text: ` · ${row.group.line.length > room ? `${row.group.line.slice(0, room - 1)}…` : row.group.line}`, fg: "muted" as ColorName }] : [])]]
  }
  if (row.kind === "missing") return [[{ text: "  · ", fg: "muted" }, { text: row.missing.title, fg: "muted" }, { text: `  ${row.missing.reason}`, fg: "muted" }]]
  const on = rowKey(row) === input.focus
  const mark = { text: on ? `  ${glyphs.user} ` : "    ", fg: "primary" as ColorName }
  if (row.kind === "connect") return [[mark, { text: "+ ", fg: on ? "primary" : "muted" }, { text: row.connect.label, fg: on ? "text" : "muted", bold: on }, ...(row.reason ? [{ text: `  ${row.reason}`, fg: "muted" as ColorName }] : [])]]
  const picked = row.option.id === input.chosen
  const name = row.option.name.length > input.nameWidth ? `${row.option.name.slice(0, input.nameWidth - 1)}…` : row.option.name.padEnd(input.nameWidth)
  const tag = tagOf(row.option)
  return [[mark, { text: picked ? "✓ " : "  ", fg: "success" }, { text: name, fg: on || picked ? "text" : "muted", bold: on }, ...(tag ? [{ text: `  ${tag}`, fg: "muted" as ColorName }] : [])]]
}

/** The list as the whole body of the setup page: one panel titled with the count, a window around the focus, no preview beside it. */
export function renderModelPicker(input: { picker: ModelPicker; detected: Detected | undefined; connects: readonly ModelConnect[]; chosen: string | undefined; width: number; height: number; glyphs: Glyphs }): Line[] {
  const { width, height } = input
  const rows = listRows(input.detected, input.connects)
  const focus = focusOf(rows, input.picker, input.chosen)
  const nameWidth = Math.min(32, Math.max(8, ...(input.detected?.options ?? []).map((option) => textWidth(option.name))))
  const lines = rows.flatMap((row) => rowLines(row, { width, focus, chosen: input.chosen, glyphs: input.glyphs, nameWidth }))
  const focusLine = Math.max(0, rows.findIndex((row) => rowKey(row) === focus))
  const room = Math.max(1, height - 2)
  const more = lines.length > room
  const window = more ? Math.max(1, room - 1) : room
  const start = more ? Math.max(0, Math.min(focusLine - Math.floor(window / 2), lines.length - window)) : 0
  const shown = lines.slice(start, start + window)
  const below = lines.length - start - shown.length
  const body: Line[] = more ? [...shown, [{ text: `  ${start ? `${start} above` : ""}${start && below ? " · " : ""}${below ? `${below} below` : ""}`, fg: "muted", dim: true }]] : shown
  const count = input.detected?.options.length ?? 0
  const title = `Model · ${count} ${count === 1 ? "model" : "models"} found`
  return panelGrid({ width, compact: true, maxColumns: 1, padding: false, gap: 0, rows: [[{ title: width >= 70 ? `${title} · nothing is saved until you start chatting` : title, body }]], heights: [Math.min(height, body.length + 2)] })
}

/** Screen-reader mode: one sentence per row, in the same order. */
export function modelPickerText(input: { picker: ModelPicker; detected: Detected | undefined; connects: readonly ModelConnect[]; chosen: string | undefined }): string[] {
  const rows = listRows(input.detected, input.connects)
  const focus = focusOf(rows, input.picker, input.chosen)
  const count = input.detected?.options.length ?? 0
  return [
    `Model list, ${count} ${count === 1 ? "model" : "models"} found. Up and down move, Enter picks a model or runs a sign-in, r checks again, Escape goes back without changing it.`,
    ...rows.map((row) => {
      const focused = rowKey(row) === focus ? "Focused. " : ""
      if (row.kind === "section") return `${row.text}.`
      if (row.kind === "group") return `${row.group.title}, ${row.count} ${row.count === 1 ? "model" : "models"}: ${row.group.line}.`
      if (row.kind === "missing") return `Not available: ${row.missing.title}, ${row.missing.reason}.`
      if (row.kind === "connect") return `${focused}${row.connect.label}${row.reason ? `, ${row.reason}` : ""}.`
      const tag = tagOf(row.option)
      return `${focused}${row.option.name}${row.option.id === input.chosen ? ", chosen" : ""}${tag ? `, ${tag}` : ""}.`
    }),
  ]
}
