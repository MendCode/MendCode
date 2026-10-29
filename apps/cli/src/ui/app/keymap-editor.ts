import { editKeybindingsFile } from "../../extensions/keybindings"
import { chordFromKey, createKeymapState, filterKeymapRows, keyHolder, keymapRows, resetEntries, specFromKey } from "../lazy-pages"
import type { KeymapRow } from "../../view/keymap-page"
import type { AppContext } from "./context"

const LEADER = "\x18"
const PAGE_JUMP = 10

/** `/keymap`: the page that lists every action with its keys and writes `keybindings.json` when one is rebound. */
export function createKeymapEditor(ctx: AppContext, actions: { loadPage(): Promise<void>; reloadKeybindings(): void }) {
  const { input, state, requestFrame } = ctx

  async function openKeymap() {
    await actions.loadPage()
    state.keymapState = createKeymapState()
    state.page = "keymap"
    requestFrame()
  }

  const visible = () => filterKeymapRows(keymapRows(state.bindings), state.keymapState?.query ?? "")

  /** Edits the file, rebuilds the live keys from it and reports the outcome on the page. */
  function write(edit: (entries: Record<string, string | null>) => void, done: string) {
    const s = state.keymapState!
    s.error = true
    if (!input.dataDir || input.remote) {
      s.message = "keybindings.json is not available in this session"
      return
    }
    const result = editKeybindingsFile(input.dataDir, edit)
    if (!result.ok) {
      s.message = result.error
      return
    }
    actions.reloadKeybindings()
    s.error = false
    s.message = done
  }

  function bind(input: { row: KeymapRow; spec: string; name: string; how: "set" | "add" }) {
    const { row, spec, name, how } = input
    write((entries) => {
      // Setting replaces the action's keys; adding keeps them.
      if (how === "set") for (const key of row.keys) if (key.spec !== spec) entries[key.spec] = null
      entries[spec] = row.action
    }, `${row.label}: ${name}`)
  }

  function capture(key: string, row: KeymapRow) {
    const s = state.keymapState!
    const pending = s.capture!
    s.capture = undefined
    s.error = true
    if (key === "\x1b") return void (s.message = "cancelled")
    if (key === "\x03") return void (s.message = "ctrl+c is reserved")
    if (key === LEADER && !pending.leader) {
      s.capture = { ...pending, leader: true }
      return
    }
    const picked = pending.leader ? chordFromKey(state.bindings, key) : specFromKey(key)
    if (!picked.ok) return void (s.message = picked.error)
    const holder = keyHolder(state.bindings, picked.spec, row.action)
    if (holder) {
      s.replace = { how: pending.how, spec: picked.spec, name: picked.name, action: row.action, holder }
      return
    }
    bind({ row, spec: picked.spec, name: picked.name, how: pending.how })
  }

  async function keymapKey(key: string) {
    const s = state.keymapState ??= createKeymapState()
    const rows = visible()
    const row = rows[Math.min(s.selected, rows.length - 1)]
    const wasConfirming = s.confirmReset
    s.confirmReset = false
    if (s.capture && row) capture(key, row)
    else if (s.replace) {
      const pending = s.replace
      s.replace = undefined
      const target = rows.find((item) => item.action === pending.action)
      if (key === "\r" && target) bind({ row: target, spec: pending.spec, name: pending.name, how: pending.how })
      else (s.message = "cancelled", s.error = true)
    } else if (key === "\x1b[A" || key === "\x1bOA") s.selected = Math.max(0, s.selected - 1)
    else if (key === "\x1b[B" || key === "\x1bOB") s.selected = Math.min(Math.max(0, rows.length - 1), s.selected + 1)
    else if (key === "\x1b[5~") s.selected = Math.max(0, s.selected - PAGE_JUMP)
    else if (key === "\x1b[6~") s.selected = Math.min(Math.max(0, rows.length - 1), s.selected + PAGE_JUMP)
    else if (key === "\x1b[H") s.selected = 0
    else if (key === "\x1b[F") s.selected = Math.max(0, rows.length - 1)
    else if (key === "\x1b") {
      if (s.query) (s.query = "", s.selected = 0)
      else state.page = "chat"
    } else if (key === "\x07") {
      if (wasConfirming) write((entries) => { for (const spec of Object.keys(entries)) delete entries[spec] }, "every binding is back to its default")
      else (s.confirmReset = true, s.message = "")
    } else if (key === "\x15") (s.query = "", s.selected = 0)
    else if (key === "\x7f" || key === "\b") (s.query = [...s.query].slice(0, -1).join(""), s.selected = 0)
    else if (row && (key === "\r" || key === "\x01")) {
      if (row.readOnly) (s.message = "set by an extension: change it there", s.error = true)
      else (s.capture = { how: key === "\r" ? "set" : "add", leader: false }, s.message = "")
    } else if (row && key === "\x04") {
      if (row.keys.length === 0) (s.message = "nothing to unbind", s.error = true)
      else write((entries) => { for (const item of row.keys) entries[item.spec] = null }, `${row.label}: unbound`)
    } else if (row && key === "\x12") {
      const dropped = new Set<string>()
      write((entries) => { for (const spec of resetEntries({ entries, action: row.action })) (dropped.add(spec), delete entries[spec]) }, `${row.label}: back to its defaults`)
      if (!s.error && dropped.size === 0) (s.message = `${row.label}: already on its defaults`, s.error = false)
    } else if ([...key].length === 1 && key >= " " && key !== "\x7f") (s.query += key, s.selected = 0, s.message = "")
    s.selected = Math.min(s.selected, Math.max(0, visible().length - 1))
    requestFrame()
  }

  return { openKeymap, keymapKey }
}
