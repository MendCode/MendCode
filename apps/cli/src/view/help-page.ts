import type { Line } from "../ui/theme"
import { DEFAULT_BINDINGS, inlineKeyNames, keymapHelp, ACTION_LABEL, type Bindings, type KeyAction } from "../ui/keymap"
import { keyText } from "../ui/key-labels"
import { SLASH_COMMANDS, type SlashCommand } from "./commands"
import { panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { truncateEnd } from "./session-list"

/**
 * The "help" page: keybinds and slash commands as two titled sections, side by side on wide terminals and
 * stacked on narrow ones (the commands are cut first when the height is tight). Two groups do not need tabs.
 * Keys come from the effective bindings (keybindings.json and extensions included); terminal extensions add
 * their commands and an "Extensions" section with what loaded and what failed.
 */

export type HelpExtensions = {
  loaded: ReadonlyArray<{ name: string; detail: string }>
  /** One line each: extensions that failed to load, renderers that were disabled, invalid keybindings. */
  problems: readonly string[]
}

type Row = [key: string, what: string]

/** The keys named for an inline action ("ctrl+o"), or "" when the user unbound them all. */
const keysOf = (bindings: Bindings, action: KeyAction) => keyText(inlineKeyNames(bindings, action).join(" / "))

/** A row for a rebindable action; left out when no key is bound to it. */
function actionRow(bindings: Bindings, action: KeyAction, what = ACTION_LABEL[action]): Row[] {
  const keys = keysOf(bindings, action)
  return keys ? [[keys, what]] : []
}

function pairRow(bindings: Bindings, first: KeyAction, second: KeyAction, tail: string, what: string): Row[] {
  const keys = [keysOf(bindings, first), keysOf(bindings, second), tail].filter(Boolean).join(" / ")
  return keys ? [[keys, what]] : []
}

/** Every key row for `bindings`: the prompt's fixed keys, the rebindable ones by their current keys, then the keymap. */
export function helpKeyRows(bindings: Bindings = DEFAULT_BINDINGS): Row[] {
  return [
    ["enter", "send"],
    [keyText("alt+enter / ctrl+j"), "newline"],
    ["esc esc", "cancel turn"],
    ...actionRow(bindings, "tools.expand"),
    ...pairRow(bindings, "scroll.up", "scroll.down", "wheel", "scroll"),
    ["a / s / d", "approve once / for session / deny (empty prompt)"],
    ["↑ / ↓", "move between rows · previous prompts at the first and last"],
    ...actionRow(bindings, "queue.send"),
    ...actionRow(bindings, "queue.drop"),
    ["tab", "complete /command"],
    ...actionRow(bindings, "permission.next"),
    ...pairRow(bindings, "scroll.top", "scroll.bottom", "", "scroll to the top / bottom (empty prompt)"),
    ["!", "shell mode: run the line as a command (first character)"],
    ["ctrl+c", "clear the prompt · quit when it is empty"],
    ...actionRow(bindings, "palette"),
    ...actionRow(bindings, "image.paste"),
    ...keymapHelp(bindings).map(({ keys, label }): Row => [keys, label]),
  ]
}

const HINTS = "↑↓ scroll · Pg↑↓ page · esc back"

const NAME_WIDTH = 20

export function helpPageWindow(width: number, height: number, extensionRows = 0) {
  const room = Math.max(1, height - 2)
  const extHeight = extensionRows ? Math.min(Math.max(4, room - 10), extensionRows + 4) : 0
  const mainHeight = room - (extHeight ? extHeight + 1 : 0)
  const heights = width < 70 ? [Math.max(3, Math.floor((mainHeight - 1) / 2)), Math.max(3, Math.ceil((mainHeight - 1) / 2))] : [mainHeight]
  return { extHeight, heights, visibleRows: Math.max(1, Math.min(...heights) - 4) }
}

/** A row of name and description; the description is shortened with an ellipsis, never cut mid-word. */
const entry = (name: string, what: string, width: number): Line => [{ text: truncateEnd(name, NAME_WIDTH - 1).padEnd(NAME_WIDTH), fg: "text" }, { text: truncateEnd(what, Math.max(1, width - NAME_WIDTH)), fg: "muted" }]

export function renderHelpPage(input: {
  width: number
  height: number
  bindings?: Bindings
  scroll?: number
  /** The built-in commands to list; all of them when absent. The app passes what the tier lists (`tierListed`). */
  builtin?: readonly SlashCommand[]
  /** Terminal extension commands, listed after the built-in ones. */
  commands?: ReadonlyArray<{ name: string; summary: string }>
  extensions?: HelpExtensions
}): Line[] {
  const { width, height } = input
  const keyRows = helpKeyRows(input.bindings)
  const commandRows = [...(input.builtin ?? SLASH_COMMANDS).map((c): Row => [`/${c.name}`, c.summary]), ...(input.commands ?? []).map((c): Row => [`/${c.name}`, `${c.summary} (extension)`])]
  const scroll = input.scroll ?? 0
  const compact = width < 70
  const extensions = input.extensions
  const extRows: Line[] = extensions ? [...extensions.loaded.map(({ name, detail }) => entry(name, detail, width - 4)), ...extensions.problems.map((text): Line => [{ text, fg: "warning" }])] : []
  const { extHeight, heights } = helpPageWindow(width, height, extRows.length)
  const pane = (title: string, rows: Row[]) => ({ title, scroll, body: (w: number) => rows.map(([name, what]) => entry(name, what, w)) })
  const main = panelGrid({ width, padding: true, compact: false, maxColumns: compact ? 1 : 2, heights, rows: compact ? [[pane("Keys", keyRows)], [pane("Commands", commandRows)]] : [[pane("Keys", keyRows), pane("Commands", commandRows)]] })
  const extra = extHeight ? panelGrid({ width, padding: true, compact: false, heights: [extHeight], rows: [[{ title: "Extensions", body: extRows, scroll }]] }) : []
  return pickerFrame("Help", HINTS, width, height, [...main, ...(extra.length ? [[], ...extra] : [])], `${keyRows.length} keys · ${commandRows.length} commands`)

}
