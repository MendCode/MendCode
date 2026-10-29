import type { ColorName, Glyphs, Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { focusedWindow } from "./appearance-layout"
import type { ImportChoice, ImportRow } from "./onboarding-detect"
import { wrap } from "./wrap"

/**
 * The Import choice inside `/setup`: what is selected, the in-page picker that edits it, and the rows that draw it. The
 * selection is a list of `setupImportKey`s; nothing is written until the page's final Enter, and the daemon is asked
 * for exactly those keys. Default: nothing.
 */
export type ImportPicker = { cursor: number; /** The selection being edited; it replaces the kept one only on Enter. */ draft: readonly string[] }

const TOOL_LABEL: Readonly<Record<ImportChoice["tool"], string>> = { "claude-code": "Claude Code", codex: "Codex" }
export const importToolName = (tool: ImportChoice["tool"]) => TOOL_LABEL[tool]

/** The kept selection reduced to what the row still offers (a recheck may drop an item). */
export const validSelection = (row: ImportRow | undefined, selected: readonly string[]): string[] => {
  const keys = new Set(row?.choices.map((choice) => choice.key) ?? [])
  return selected.filter((key) => keys.has(key))
}

/** `nothing`, `all 13 MCP servers` or `5 of 13`: the value the Import row shows. */
export function importValue(row: ImportRow | undefined, selected: readonly string[]): string {
  const count = validSelection(row, selected).length
  if (!row || count === 0) return "nothing"
  return count === row.choices.length ? `all ${row.counts}` : `${count} of ${row.choices.length}`
}

/** What the final Enter does about Import, as it ends the action line: `imports nothing`, `imports 5 of 13`. */
export const importSummary = (row: ImportRow | undefined, selected: readonly string[]) => `imports ${importValue(row, selected)}`

/** Left and right on the row itself: nothing to everything and back, for people who do not want a list. */
export const toggleAll = (row: ImportRow | undefined, selected: readonly string[]): string[] => {
  const all = row?.choices.map((choice) => choice.key) ?? []
  return validSelection(row, selected).length < all.length ? all : []
}

export const openPicker = (row: ImportRow | undefined, selected: readonly string[]): ImportPicker => ({ cursor: 0, draft: validSelection(row, selected) })

const UP = new Set(["\x1b[A", "\x1bOA", "\x10", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "\x0e", "j", "\t"])

/** One key in the picker: `picker` is what stays open (undefined closes it), `commit` the new kept selection (only on Enter). */
export function pickerKey(picker: ImportPicker, key: string, row: ImportRow | undefined): { picker: ImportPicker | undefined; commit?: string[] } {
  const choices = row?.choices ?? []
  if (key === "\x1b") return { picker: undefined }
  if (key === "\r") return { picker: undefined, commit: validSelection(row, picker.draft) }
  if (UP.has(key)) return { picker: { ...picker, cursor: Math.max(0, picker.cursor - 1) } }
  if (DOWN.has(key)) return { picker: { ...picker, cursor: Math.min(Math.max(0, choices.length - 1), picker.cursor + 1) } }
  if (key === "g") return { picker: { ...picker, cursor: 0 } }
  if (key === "G") return { picker: { ...picker, cursor: Math.max(0, choices.length - 1) } }
  if (key === "a") return { picker: { ...picker, draft: choices.map((choice) => choice.key) } }
  if (key === "n") return { picker: { ...picker, draft: [] } }
  if (key === " ") {
    const choice = choices[picker.cursor]
    if (!choice) return { picker }
    const draft = picker.draft.includes(choice.key) ? picker.draft.filter((entry) => entry !== choice.key) : [...picker.draft, choice.key]
    return { picker: { ...picker, draft } }
  }
  return { picker }
}

/** What one item is called in the list: `name`, plus its kind when it is not an MCP server. */
const nameOf = (choice: ImportChoice) => choice.kind === "mcp" ? choice.name : `${choice.name} (command)`
const sourceOf = (choice: ImportChoice) => `${TOOL_LABEL[choice.tool]}${choice.scope === "project" ? " · project" : ""}`

const factLines = (label: string, entries: readonly string[], width: number): Line[] => {
  if (!entries.length) return []
  const text = `${label}: ${entries.map((entry) => entry.replace(/\s*\(read where they are\)/, "").replace(/\s*\(([^)]*)\)$/, "")).join("; ")}`
  return wrap(text, Math.max(10, width - 2)).slice(0, 2).map((row): Line => [{ text: ` ${row}`, fg: "muted" }])
}

/** The picker's rows: one line per item, a window around the cursor, two muted lines of facts under it. */
export function importPickerLines({ row, picker, width, height, glyphs }: { row: ImportRow; picker: ImportPicker; width: number; height: number; glyphs: Glyphs }): Line[] {
  const facts = [...factLines("Read where it is", row.inPlace, width), ...factLines("Never imported", row.notImported, width)]
  const room = Math.max(1, height - (facts.length ? facts.length + 1 : 0))
  const nameWidth = Math.min(30, Math.max(8, ...row.choices.map((choice) => nameOf(choice).length)))
  const sourceWidth = Math.max(...row.choices.map((choice) => sourceOf(choice).length))
  const chosen = new Set(picker.draft)
  const lines: Line[] = row.choices.map((choice, index): Line => {
    const on = index === picker.cursor
    const checked = chosen.has(choice.key)
    const name = nameOf(choice)
    const shown = name.length > nameWidth ? `${name.slice(0, nameWidth - 1)}…` : name.padEnd(nameWidth)
    const tone: ColorName = on ? "text" : "muted"
    return [
      { text: on ? `${glyphs.user} ` : "  ", fg: "primary" },
      { text: checked ? "[x] " : "[ ] ", fg: checked ? "success" : "muted" },
      { text: shown, fg: checked || on ? "text" : "muted", bold: on },
      { text: `  ${sourceOf(choice).padEnd(sourceWidth)}`, fg: tone },
      ...(choice.reason ? [{ text: `  ${choice.reason}`, fg: "muted" as ColorName }] : []),
    ]
  })
  const more = lines.length > room
  const window = more ? focusedWindow(lines, picker.cursor, room - 1) : lines
  const above = more ? Math.max(0, Math.min(picker.cursor - (room - 1) + 2, lines.length - (room - 1))) : 0
  const below = more ? lines.length - above - window.length : 0
  const out: Line[] = [...window]
  if (more) out.push([{ text: `  ${above ? `${above} above` : ""}${above && below ? " · " : ""}${below ? `${below} below` : ""}`, fg: "muted", dim: true }])
  while (out.length < Math.min(room, lines.length + (more ? 1 : 0))) out.push([])
  return facts.length ? [...out, [], ...facts] : out
}

/** The picker as the whole body of the setup page: one panel titled with the count, rows inside, no preview beside it. */
export function renderImportPicker({ row, picker, width, height, glyphs }: { row: ImportRow; picker: ImportPicker; width: number; height: number; glyphs: Glyphs }): Line[] {
  const inner = Math.max(1, height - 2)
  const body = importPickerLines({ row, picker, width, height: inner, glyphs })
  const count = `Import · ${picker.draft.length} of ${row.choices.length} selected`
  return panelGrid({ width, compact: true, maxColumns: 1, padding: false, gap: 0, rows: [[{ title: width >= 70 ? `${count} · nothing is copied until you start chatting` : count, body }]], heights: [Math.min(height, body.length + 2)] })
}

/** Screen-reader mode: one sentence per item, in the same order. */
export function importPickerText(row: ImportRow, picker: ImportPicker): string[] {
  const chosen = new Set(picker.draft)
  return [
    `Import list, ${picker.draft.length} of ${row.choices.length} selected. Space toggles, a selects all, n none, Enter keeps the selection, Escape goes back without changing it.`,
    ...row.choices.map((choice, index) => `${index === picker.cursor ? "Focused. " : ""}${nameOf(choice)}, ${sourceOf(choice)}, ${chosen.has(choice.key) ? "selected" : "not selected"}${choice.reason ? `, ${choice.reason}` : ""}.`),
  ]
}
