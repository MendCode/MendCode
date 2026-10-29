import type { Line } from "../ui/theme"
import { keyName, ACTION_LABEL, type Bindings, type KeyAction } from "../ui/keymap"
import { keyText, preferChord } from "../ui/key-labels"
import { panelGrid } from "./deck"
import { truncateEnd } from "./session-list"

type Entry = readonly [keys: string, what: string]

/** Every key (inline, direct or a leader chord) bound to `action`, as keybindings.json names them, without repeats. */
export function keysOf(bindings: Bindings, action: KeyAction): string[] {
  const names: string[] = []
  const name = (seq: string) => (keyName(seq) ?? JSON.stringify(seq).slice(1, -1)).replace(/^alt\+([A-Z])$/, (_, letter: string) => `alt+shift+${letter.toLowerCase()}`)
  for (const [seq, bound] of bindings.inline) if (bound === action) names.push(name(seq))
  for (const [seq, bound] of bindings.direct) if ("action" in bound && bound.action === action) names.push(name(seq))
  for (const [key, bound] of bindings.leader) if ("action" in bound && bound.action === action) names.push(`${name(bindings.leaderKey)} ${key}`)
  return [...new Set(names)]
}

/** The prompt's shortcuts as they are bound now: what the `?` overlay lists. Unbound actions are left out. */
export function shortcutEntries(bindings: Bindings, options: { multiline: boolean; backtrack: boolean }): Entry[] {
  const entries: Entry[] = [
    ["enter", options.multiline ? "new line" : "send"],
    [keyText(options.multiline ? "alt+enter" : "alt+enter · ctrl+j"), options.multiline ? "send" : "new line"],
    ["/", "commands"],
    ["@", "files and resources"],
    ["!", "shell command"],
    ["↑ ↓", "move; earlier prompts at the ends"],
  ]
  const add = (action: KeyAction, what = ACTION_LABEL[action], extra: string[] = []) => {
    const named = keysOf(bindings, action)
    // Where Option is not known to work the chord comes first: it is the form that does.
    const ordered = preferChord() ? [...named.filter((name) => name.startsWith("ctrl+x ")), ...named.filter((name) => !name.startsWith("ctrl+x "))] : named
    const keys = [...ordered.slice(0, 2), ...extra]
    if (keys.length) entries.push([keyText(keys.join(" · ")), what])
  }
  add("history.previous", "earlier prompt from any row")
  add("history.next", "later prompt")
  add("history.search", "search earlier prompts")
  add("backtrack.open", "edit an earlier prompt and resend", options.backtrack ? ["esc esc"] : [])
  add("queue.edit", "pull a queued prompt back")
  add("queue.send", "send the queued prompt now")
  add("queue.drop", "drop the last queued prompt")
  add("queue.flip", "send once the other way (steer or queue)")
  add("edit.undo", "undo")
  add("edit.redo", "redo")
  add("edit.yank", "yank the last kill")
  add("edit.yank-pop", "yank an older kill")
  add("edit.jump-forward", "jump to a character")
  add("stash.push", "stash the prompt")
  add("stash.pop", "restore the stash")
  add("editor.open", "edit in $EDITOR")
  add("image.paste", "paste an image")
  add("effort.previous", "lower the effort")
  add("effort.next", "raise the effort")
  add("model.next", "next model")
  add("permission.next", "next permission mode")
  add("palette", "command palette")
  add("transcript.find", "find in the transcript")
  return entries
}

const KEY_COLUMN = 21

/** The overlay as a bordered panel of key and meaning pairs, in as many columns as fit; `maxRows` bounds its body. */
export function renderShortcutOverlay(input: { width: number; entries: readonly Entry[]; maxRows: number }): Line[] {
  const { width, entries } = input
  const padded = width >= 70
  const columns = width >= 110 ? 3 : width >= 70 ? 2 : 1
  const body = (room: number): Line[] => {
    const cell = Math.max(KEY_COLUMN + 6, Math.floor(room / columns))
    const perColumn = Math.max(1, Math.min(Math.ceil(entries.length / columns), input.maxRows))
    const shown = perColumn * columns
    const rows: Line[] = []
    for (let row = 0; row < perColumn; row++) {
      const line: Line = []
      for (let column = 0; column < columns; column++) {
        const entry = entries[column * perColumn + row]
        if (!entry) continue
        const keys = truncateEnd(entry[0], KEY_COLUMN - 1).padEnd(KEY_COLUMN)
        const what = truncateEnd(entry[1], Math.max(1, cell - KEY_COLUMN - 1))
        line.push({ text: keys, fg: "primary" }, { text: what.padEnd(Math.max(0, cell - KEY_COLUMN)), fg: "body" })
      }
      rows.push(line)
    }
    if (entries.length > shown) rows.push([{ text: `+${entries.length - shown} more · /help lists every key`, fg: "muted" }])
    return rows
  }
  return panelGrid({ rows: [[{ title: "Shortcuts · any key closes", body }]], width, compact: false, maxColumns: 1, padding: padded })
}
