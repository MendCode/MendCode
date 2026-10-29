import type { Line } from "../ui/theme"
import { actionLabel, createBindings, KEY_ACTIONS, keyName, type Bindings, type Bound } from "../ui/keymap"
import { keyText } from "../ui/key-labels"
import { parseKeySpec } from "../extensions/keybindings"
import { EDIT_KEYS } from "./editor-actions"
import { clip, panelGrid } from "./deck"
import { pickerFrame } from "./picker-frame"
import { wrap } from "./wrap"

/**
 * `/keymap`: every action with its keys, rebound by pressing a key. Pure view helpers: the app owns the file writes.
 */
export type KeymapKey = { name: string; spec: string }
export type KeymapRow = { action: string; label: string; keys: KeymapKey[]; defaults: string[]; readOnly: boolean; conflicts: string[] }
export type KeymapCapture = { how: "set" | "add"; leader: boolean }
export type KeymapReplace = { how: "set" | "add"; spec: string; name: string; action: string; holder: string }
export type KeymapState = { selected: number; query: string; capture?: KeymapCapture | undefined; replace?: KeymapReplace | undefined; message: string; error: boolean; confirmReset: boolean }

export const createKeymapState = (): KeymapState => ({ selected: 0, query: "", message: "", error: false, confirmReset: false })

const MODIFIERS: Readonly<Record<string, string>> = { "2": "shift", "3": "alt", "4": "alt+shift", "5": "ctrl", "6": "ctrl+shift", "7": "ctrl+alt" }
/** A key as people say it: the names `keyName` knows, plus the xterm encodings the editor's defaults use (alt+enter, shift+home…). */
function nameOf(seq: string): string {
  if (seq === "\x1b\r") return "alt+enter"
  const other = /^\x1b\[27;([2-7]);(\d+)~$/.exec(seq)
  if (other) return `${MODIFIERS[other[1]!]}+${other[2] === "13" ? "enter" : String.fromCharCode(Number(other[2]))}`
  const edge = /^\x1b\[([14]);([2-7])~$/.exec(seq)
  if (edge) return `${MODIFIERS[edge[2]!]}+${edge[1] === "1" ? "home" : "end"}`
  return keyName(seq) ?? JSON.stringify(seq).slice(1, -1)
}
const leaderName = (bindings: Bindings, key: string) => `${nameOf(bindings.leaderKey)} ${key}`
const leaderSpec = (key: string) => (key === key.toLowerCase() ? `leader+${key}` : `leader+shift+${key.toLowerCase()}`)

function boundAction(bound: Bound): string {
  return "action" in bound ? bound.action : `extension:${bound.owner}`
}

/** The keys of every action in a keymap, a key once even when a terminal sends it several ways (home, f2). */
function keysByAction(bindings: Bindings): Map<string, KeymapKey[]> {
  const out = new Map<string, KeymapKey[]>()
  const add = (action: string, key: KeymapKey) => {
    const list = out.get(action) ?? []
    if (!list.some((item) => item.name === key.name)) list.push(key)
    out.set(action, list)
  }
  for (const [key, bound] of bindings.leader) add(boundAction(bound), { name: leaderName(bindings, key), spec: leaderSpec(key) })
  const raw = (seq: string): KeymapKey => {
    const name = keyName(seq)
    return { name: nameOf(seq), spec: name && parseKeySpec(name).ok ? name : seq }
  }
  for (const [seq, bound] of bindings.direct) add(boundAction(bound), "label" in bound ? { name: bound.label, spec: seq } : raw(seq))
  for (const [seq, action] of bindings.inline) add(action, raw(seq))
  // Arrows, Home and End move the cursor while the prompt has text and only otherwise scroll or switch sessions: the editing action keeps them.
  for (const [seq, edit] of Object.entries(EDIT_KEYS)) {
    const held = bindings.inline.get(seq)
    if (!bindings.disabled.has(seq) && !bindings.direct.has(seq) && held !== undefined && held !== `edit.${edit}` && /^(session|scroll)\./.test(held)) add(`edit.${edit}`, raw(seq))
  }
  return out
}

/** Keys that two actions both hold: the direct table wins over the prompt's own, so the second never runs. */
function shadowed(bindings: Bindings): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const note = (action: string, text: string) => out.set(action, [...(out.get(action) ?? []), text])
  for (const [seq, bound] of bindings.direct) {
    const inline = bindings.inline.get(seq)
    if (inline && "action" in bound && bound.action !== inline) {
      note(boundAction(bound), `${nameOf(seq)} also bound to ${actionLabel(inline)}, which it hides`)
      note(inline, `${nameOf(seq)} is taken by ${actionLabel(bound.action)}`)
    }
  }
  return out
}

/** One row per action: the built-in ones in the order `/help` lists them, then `command:` and `page:` bindings and extension keys. */
export function keymapRows(bindings: Bindings): KeymapRow[] {
  const current = keysByAction(bindings)
  const defaults = keysByAction(createBindings())
  const clashes = shadowed(bindings)
  const actions = [...new Set<string>([...KEY_ACTIONS, ...current.keys()])]
  // An extension key that took over a built-in or user key: named on both rows, with who won.
  const overridden = (action: string) => (bindings.overrides ?? []).flatMap((entry) => {
    if (action === `extension:${entry.owner}`) return [`${entry.key} replaced ${entry.was}${entry.source === "keybindings.json" ? " (your keybindings.json)" : ""}`]
    return entry.wasAction === action ? [`${entry.key} is taken by extension ${entry.owner}`] : []
  })
  return actions.map((action) => ({
    action,
    label: action.startsWith("extension:") ? `extension ${action.slice(10)}` : actionLabel(action as never) ?? action,
    keys: current.get(action) ?? [],
    defaults: (defaults.get(action) ?? []).map((key) => key.name),
    readOnly: action.startsWith("extension:"),
    conflicts: [...(clashes.get(action) ?? []), ...overridden(action)],
  }))
}

export function filterKeymapRows(rows: readonly KeymapRow[], query: string): KeymapRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length === 0 ? [...rows] : rows.filter((row) => {
    const names = row.keys.map((key) => key.name).join(" ")
    // Typing `alt` or the platform's word (`opt`) both find the row.
    const haystack = `${row.action} ${row.label} ${names} ${keyText(names)}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** A pressed key as the file spells it, or why it cannot be bound. */
export function specFromKey(seq: string): { ok: true; spec: string; name: string } | { ok: false; error: string } {
  const name = keyName(seq)
  if (!name) return { ok: false, error: "that key has no name: use ctrl, alt or a function key" }
  const parsed = parseKeySpec(name)
  return parsed.ok ? { ok: true, spec: name, name } : { ok: false, error: parsed.error }
}

/** The chord after the leader as the file spells it; only a single visible character counts. */
export function chordFromKey(bindings: Bindings, seq: string): { ok: true; spec: string; name: string } | { ok: false; error: string } {
  if ([...seq].length !== 1 || seq <= " " || seq === "\x7f") return { ok: false, error: "a chord is the leader and one letter, digit or symbol" }
  return { ok: true, spec: leaderSpec(seq), name: leaderName(bindings, seq) }
}

/** What already holds `spec` besides `action`, as a label; undefined when the key is free. */
export function keyHolder(bindings: Bindings, spec: string, action: string): string | undefined {
  const parsed = parseKeySpec(spec)
  if (!parsed.ok) return undefined
  const { target } = parsed
  const held = (bound: Bound | string | undefined) => {
    if (bound === undefined) return undefined
    const name = typeof bound === "string" ? bound : boundAction(bound)
    return name === action ? undefined : name.startsWith("extension:") ? `extension ${name.slice(10)}` : actionLabel(name as never) ?? name
  }
  if (target.kind === "leader") return held(bindings.leader.get(target.key))
  if (target.kind === "leader-key") return undefined
  for (const seq of target.seqs) {
    const label = held(bindings.direct.get(seq)) ?? held(bindings.inline.get(seq))
    if (label) return label
  }
  return undefined
}

/** The file entries to drop to bring an action back to its defaults: its own and any that took one of its default keys. */
export function resetEntries(input: { entries: Readonly<Record<string, string | null>>; action: string }): string[] {
  const defaults = createBindings()
  const seqs = new Set<string>()
  const chords = new Set<string>()
  for (const [seq, bound] of defaults.direct) if ("action" in bound && bound.action === input.action) seqs.add(seq)
  for (const [seq, action] of defaults.inline) if (action === input.action) seqs.add(seq)
  for (const [key, bound] of defaults.leader) if ("action" in bound && bound.action === input.action) chords.add(key)
  return Object.entries(input.entries).filter(([spec, value]) => {
    if (value === input.action) return true
    const parsed = parseKeySpec(spec)
    if (!parsed.ok) return false
    if (parsed.target.kind === "leader") return chords.has(parsed.target.key)
    return parsed.target.kind === "direct" && parsed.target.seqs.some((seq) => seqs.has(seq))
  }).map(([spec]) => spec)
}

export function renderKeymapPage(input: { rows: readonly KeymapRow[]; state: KeymapState; file: string | undefined; problems: readonly string[]; width: number; height: number }): Line[] {
  const { state, width, height } = input
  const rows = filterKeymapRows(input.rows, state.query)
  const selected = rows[Math.min(state.selected, rows.length - 1)]
  const lines = (text: string, w: number, fg: "text" | "muted" | "warning" | "error" | "success" = "text"): Line[] => wrap(text, w).map((row) => [{ text: row, fg }])
  const list = (w: number): Line[] => {
    if (rows.length === 0) return [[{ text: "No action matches", fg: "muted" }]]
    const label = Math.max(12, Math.min(34, Math.floor(w * 0.5)))
    return rows.map((row, index): Line => clip([
      { text: index === state.selected ? "› " : "  ", fg: "primary" },
      { text: row.conflicts.length ? "! " : "  ", fg: "warning" },
      { text: `${row.label.slice(0, label).padEnd(label)}  `, fg: index === state.selected ? "primary" : "text" },
      { text: row.keys.length ? keyText(row.keys.map((key) => key.name).join(", ")) : "unbound", fg: row.keys.length ? "heading" : "muted" },
    ], w))
  }
  const prompt = (w: number): Line[] => {
    if (state.replace) return [...lines(`${keyText(state.replace.name)} is bound to ${state.replace.holder}.`, w, "warning"), ...lines("enter replaces it · esc cancels", w, "muted")]
    if (state.capture) return [...lines(state.capture.leader ? "ctrl+x pressed: now the chord key" : `Press the key for ${selected?.label ?? "this action"}`, w, "warning"), ...lines(state.capture.leader ? "esc cancels" : "ctrl+x then a letter makes a chord · esc cancels", w, "muted")]
    return []
  }
  const detail = (w: number): Line[] => {
    if (!selected) return []
    return [
      [{ text: selected.label, fg: "heading", bold: true }],
      [{ text: selected.action, fg: "muted" }],
      [],
      ...lines(`Keys: ${selected.keys.length ? keyText(selected.keys.map((key) => key.name).join(", ")) : "unbound"}`, w),
      ...lines(`Default: ${selected.defaults.length ? keyText(selected.defaults.join(", ")) : "none"}`, w, "muted"),
      ...selected.conflicts.flatMap((text) => lines(`! ${keyText(text)}`, w, "warning")),
      ...(selected.readOnly ? [[], ...lines("Set by an extension: change it there.", w, "muted")] : []),
      ...(prompt(w).length ? [[], ...prompt(w)] : []),
      ...(state.message ? [[], ...lines(keyText(state.message), w, state.error ? "error" : "success")] : []),
      ...(input.problems.length ? [[], ...input.problems.flatMap((text) => lines(text, w, "error"))] : []),
    ]
  }
  const compact = width < 70
  const panels = [
    { title: "Actions", active: !state.capture && !state.replace, scroll: Math.max(0, state.selected - Math.max(1, height - 10)), weight: 3, body: list },
    ...(compact ? [] : [{ title: "Binding", active: !!state.capture || !!state.replace, scroll: 0, weight: 2, body: detail }]),
  ]
  const hints = state.capture || state.replace ? "esc cancel" : "↑↓ select · enter set key · ctrl-a add key · ctrl-d unbind · ctrl-r reset · ctrl-g reset all · esc back"
  const summary = state.confirmReset ? "ctrl-g again resets every binding in keybindings.json" : `${rows.length} actions${state.query ? ` matching "${state.query}"` : " · type to filter"}${compact && state.message ? ` · ${keyText(state.message)}` : ""}${compact && prompt(width).length ? ` · ${state.replace ? `${keyText(state.replace.name)} taken: enter replaces` : "press the key"}` : ""}${input.file ? ` · ${input.file}` : ""}`
  return pickerFrame("Keymap", hints, width, height, panelGrid({ width, padding: true, compact, maxColumns: compact ? 1 : 2, heights: [height - 2], rows: [panels] }), summary)
}
