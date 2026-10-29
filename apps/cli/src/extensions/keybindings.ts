import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { KEYBINDINGS_FILE } from "@mendcode/extension-api"
import type { TuiActions } from "@mendcode/extension-api"
import { actionLabel, createBindings, KEY_ACTIONS, LEADER_KEY, type Bindings, type Bound, type BindingAction, type KeyAction, type KeyOverride } from "../ui/keymap"

/**
 * `<dataDir>/keybindings.json`: `{ "<key>": "<action>" | null }`. Keys are `ctrl+g`, `alt+x`, `f2`, `pgup`…,
 * `leader+g` (the chord after ctrl+x) or a raw sequence; `null` unbinds that key. Pure parsing; the app owns the
 * one read at startup. Startup cost without the file: one `existsSync`.
 */

/** Where a key lives in the keymap. */
export type KeyTarget = { kind: "direct"; seqs: string[]; label: string } | { kind: "leader"; key: string; label: string } | { kind: "leader-key"; seq: string; label: string }
export type KeySpec = { ok: true; target: KeyTarget } | { ok: false; error: string }

const FUNCTION_KEYS: Readonly<Record<string, string[]>> = {
  f1: ["\x1bOP", "\x1b[11~"], f2: ["\x1bOQ", "\x1b[12~"], f3: ["\x1bOR", "\x1b[13~"], f4: ["\x1bOS", "\x1b[14~"],
  f5: ["\x1b[15~"], f6: ["\x1b[17~"], f7: ["\x1b[18~"], f8: ["\x1b[19~"], f9: ["\x1b[20~"], f10: ["\x1b[21~"], f11: ["\x1b[23~"], f12: ["\x1b[24~"],
}
const NAMED: Readonly<Record<string, string[]>> = {
  "shift+f2": ["\x1b[12;2~", "\x1b[1;2Q"],
  up: ["\x1b[A", "\x1bOA"], down: ["\x1b[B", "\x1bOB"], left: ["\x1b[D", "\x1bOD"], right: ["\x1b[C", "\x1bOC"],
  home: ["\x1b[H", "\x1bOH", "\x1b[1~"], end: ["\x1b[F", "\x1bOF", "\x1b[4~"], pgup: ["\x1b[5~"], pgdn: ["\x1b[6~"], insert: ["\x1b[2~"], delete: ["\x1b[3~"],
  "shift+f3": ["\x1b[13;2~", "\x1b[1;2R"],
  "shift+tab": ["\x1b[Z"],
}
/** Punctuation controls: ctrl+\ ctrl+] ctrl+^ ctrl+_ and ctrl+space. */
const CONTROL_PUNCTUATION: Readonly<Record<string, string>> = { "\\": "\x1c", "]": "\x1d", "^": "\x1e", _: "\x1f", space: "\x00" }
/** Keys the prompt cannot give up: quit/clear, leader, submit, newline, completion, erase and cancel. */
const RESERVED = new Map<string, string>([
  ["\x03", "ctrl+c"], [LEADER_KEY, "ctrl+x"], ["\r", "enter"], ["\n", "ctrl+j"], ["\t", "tab"], ["\x7f", "backspace"], ["\b", "backspace"], ["\x1b", "esc"],
])

/**
 * `opt+q` and `option+q` mean `alt+q`: a Mac keyboard has Option, and the hints say so (ui/key-labels.ts). Only a modifier position
 * followed by `+` and a key counts, so no key name changes meaning; the file's canonical name stays `alt`.
 */
const OPTION_MODIFIER = /(^|\+)(?:opt|option)(?=\+.)/gi

/** Parses one key of `keybindings.json` or `api.key`. */
export function parseKeySpec(spec: string): KeySpec {
  // A raw sequence: anything holding a control character (the escape of an arrow key, \x07…).
  if (/[\x00-\x1f\x7f]/.test(spec)) {
    const taken = RESERVED.get(spec)
    return taken ? { ok: false, error: `${taken} is reserved` } : { ok: true, target: { kind: "direct", seqs: [spec], label: JSON.stringify(spec).slice(1, -1) } }
  }
  const text = spec.trim().replace(OPTION_MODIFIER, "$1alt")
  if (!text) return { ok: false, error: "empty key" }
  const name = text.toLowerCase()
  const leader = /^leader\+(shift\+)?(.)$/iu.exec(text)
  if (leader) return { ok: true, target: { kind: "leader", key: leader[1] ? leader[2]!.toUpperCase() : leader[2]!.toLowerCase(), label: `ctrl+x ${leader[1] ? "shift+" : ""}${leader[2]!.toLowerCase()}` } }
  if (["enter", "return", "esc", "escape", "tab", "backspace"].includes(name)) return { ok: false, error: `${name} is reserved` }
  const fn = FUNCTION_KEYS[name]
  if (fn) return { ok: true, target: { kind: "direct", seqs: fn, label: name } }
  const named = NAMED[name]
  if (named) return { ok: true, target: { kind: "direct", seqs: named, label: name } }
  const modified = /^(ctrl\+shift|alt\+shift|shift|ctrl|alt)\+(.+)$/.exec(name)
  if (modified) {
    const mod = ({ shift: 2, alt: 3, "alt+shift": 4, ctrl: 5, "ctrl+shift": 6 } as Record<string, number>)[modified[1]!]!
    const key = modified[2]!
    const arrow = ({ up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" } as Record<string, string>)[key]
    const seqs = arrow ? [`\x1b[1;${mod}${arrow}`] : key === "delete" ? [`\x1b[3;${mod}~`] : key === "enter" || key === "return" ? [`\x1b[13;${mod}u`, `\x1b[27;${mod};13~`] : /^[a-z]$/.test(key) && modified[1]!.includes("shift") ? [`\x1b[${key.charCodeAt(0)};${mod}u`, ...(mod === 4 ? [`\x1b${key.toUpperCase()}`] : [])] : undefined
    if (seqs) return { ok: true, target: { kind: "direct", seqs, label: name } }
  }
  const ctrlAlt = /^(?:ctrl\+alt|alt\+ctrl)\+([a-z])$/.exec(name)
  if (ctrlAlt) return { ok: true, target: { kind: "direct", seqs: [`\x1b${String.fromCharCode(ctrlAlt[1]!.charCodeAt(0) - 96)}`, `\x1b[${ctrlAlt[1]!.charCodeAt(0)};7u`], label: name } }
  const ctrl = /^ctrl\+(.+)$/.exec(name)
  if (ctrl) {
    const seq = /^[a-z]$/.test(ctrl[1]!) ? String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96) : CONTROL_PUNCTUATION[ctrl[1]!]
    if (!seq) return { ok: false, error: `unknown key "${spec}"` }
    return RESERVED.has(seq) ? { ok: false, error: `${name} is reserved` } : { ok: true, target: { kind: "direct", seqs: [seq], label: name } }
  }
  const alt = /^alt\+(.)$/iu.exec(text)
  if (alt && alt[1]! > " ") return { ok: true, target: { kind: "direct", seqs: [`\x1b${alt[1]}`], label: `alt+${alt[1]}` } }
  return { ok: false, error: `unknown key "${spec}"` }
}

const COMMAND_NAME = /^[a-z0-9][a-z0-9:_-]*$/i
const PAGE_ID = /^[\w.:-]+$/

/** An action name of `keybindings.json`: a built-in action, `command:<name>`, `page:<id>`, `modal:<id>` or `action:<id>`; undefined when it is none. */
export function parseAction(value: string): BindingAction | undefined {
  if ((KEY_ACTIONS as readonly string[]).includes(value)) return value as KeyAction
  if (value.startsWith("command:") && COMMAND_NAME.test(value.slice(8))) return value as BindingAction
  for (const prefix of ["page:", "modal:", "action:"]) if (value.startsWith(prefix) && PAGE_ID.test(value.slice(prefix.length))) return value as BindingAction
  return undefined
}

/** One valid line of the file: where the key is and what it does (`null`: unbound). */
export type KeybindingEntry = { spec: string; target: KeyTarget; action: BindingAction | null }
export type KeybindingFile = { entries: KeybindingEntry[]; problems: string[] }

/** Parses the file's text; invalid keys and actions are reported and skipped, the rest still applies. */
export function parseKeybindings(text: string): KeybindingFile {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { entries: [], problems: [`${KEYBINDINGS_FILE}: not valid JSON`] }
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { entries: [], problems: [`${KEYBINDINGS_FILE}: expected an object of "key": "action"`] }
  const entries: KeybindingEntry[] = []
  const problems: string[] = []
  for (const [spec, value] of Object.entries(json)) {
    if (spec === "leader") {
      const parsed = typeof value === "string" ? parseKeySpec(value) : undefined
      if (value === "ctrl+x") entries.push({ spec, target: { kind: "leader-key", seq: LEADER_KEY, label: value }, action: null })
      else if (parsed?.ok && parsed.target.kind === "direct" && parsed.target.seqs.length === 1) entries.push({ spec, target: { kind: "leader-key", seq: parsed.target.seqs[0]!, label: String(value) }, action: null })
      else problems.push(`${KEYBINDINGS_FILE}: leader must name one terminal key`)
      continue
    }
    const configKeys: Record<string, string> = { tab: "\t", "ctrl+j": "\n", backspace: "\x7f", "ctrl+h": "\b", "ctrl+x": LEADER_KEY }
    const parsed: KeySpec = configKeys[spec] ? { ok: true, target: { kind: "direct", seqs: [configKeys[spec]!], label: spec } } : parseKeySpec(spec)
    if (!parsed.ok) {
      problems.push(`${KEYBINDINGS_FILE}: ${parsed.error}`)
      continue
    }
    if (value === null) {
      entries.push({ spec, target: parsed.target, action: null })
      continue
    }
    const action = typeof value === "string" ? parseAction(value) : undefined
    if (!action) problems.push(`${KEYBINDINGS_FILE}: unknown action ${JSON.stringify(value)} for ${spec}`)
    else entries.push({ spec, target: parsed.target, action })
  }
  return { entries, problems }
}

/** Reads `<dataDir>/keybindings.json` when it exists; no file is no entries and no problems. */
export function readKeybindings(dataDir: string): KeybindingFile {
  const file = path.join(dataDir, KEYBINDINGS_FILE)
  if (!existsSync(file)) return { entries: [], problems: [] }
  try {
    return parseKeybindings(readFileSync(file, "utf8"))
  } catch (error) {
    return { entries: [], problems: [`${KEYBINDINGS_FILE}: ${error instanceof Error ? error.message : "cannot read"}`] }
  }
}

/**
 * Changes `<dataDir>/keybindings.json` for the keymap editor: the file's own JSON object is edited and written back whole
 * (temp file, then rename), so entries the editor does not know stay as they are. A file that is not an object is left alone.
 */
export function editKeybindingsFile(dataDir: string, edit: (entries: Record<string, string | null>) => void): { ok: true } | { ok: false; error: string } {
  const file = path.join(dataDir, KEYBINDINGS_FILE)
  const temp = `${file}.${process.pid}.tmp`
  try {
    let entries: Record<string, string | null> = {}
    if (existsSync(file)) {
      const json: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, error: `${KEYBINDINGS_FILE} is not an object of "key": "action"; fix it by hand first` }
      entries = json as Record<string, string | null>
    }
    edit(entries)
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`)
    renameSync(temp, file)
    return { ok: true }
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Nothing left to clean up.
    }
    return { ok: false, error: error instanceof SyntaxError ? `${KEYBINDINGS_FILE} is not valid JSON; fix it by hand first` : error instanceof Error ? error.message : "cannot write keybindings" }
  }
}

export type ExtensionKey ={ spec: string; run: (actions: TuiActions) => void; owner: string }

/**
 * The effective bindings: the defaults, then the file, then extension keys (which win). A key that is set or
 * unset leaves every table, so `ctrl+o: "dock"` replaces the default meaning of ctrl+o and `null` frees it.
 */
export function buildBindings(input: { file?: readonly KeybindingEntry[]; extensions?: readonly ExtensionKey[] }): { bindings: Bindings; problems: string[] } {
  const bindings = createBindings()
  const problems: string[] = []
  const free = (target: KeyTarget) => {
    if (target.kind === "leader-key") { bindings.leaderKey = target.seq; bindings.direct.delete(target.seq); bindings.inline.delete(target.seq); return }
    if (target.kind === "leader") bindings.leader.delete(target.key)
    else
      for (const seq of target.seqs) {
        bindings.disabled.add(seq)
        bindings.direct.delete(seq)
        bindings.inline.delete(seq)
      }
  }
  const set = (target: KeyTarget, bound: Parameters<Bindings["direct"]["set"]>[1]) => {
    free(target)
    if (target.kind === "leader-key") return
    if (target.kind === "leader") bindings.leader.set(target.key, bound)
    else for (const seq of target.seqs) { bindings.disabled.delete(seq); bindings.direct.set(seq, bound) }
  }
  const fromFile = new Set<string>()
  const idsOf = (target: KeyTarget) => target.kind === "leader" ? [`leader:${target.key}`] : target.kind === "direct" ? target.seqs : []
  /** What holds the key now, before an extension takes it. */
  const holders = (target: KeyTarget) => {
    const held = new Map<string, { was: string; source: KeyOverride["source"]; wasAction?: string; owner?: string }>()
    const note = (bound: Bound | KeyAction | undefined, id: string) => {
      if (bound === undefined) return
      if (typeof bound === "string") held.set(`a:${bound}`, { was: actionLabel(bound) ?? bound, source: "built-in", wasAction: bound })
      else if ("action" in bound) held.set(`a:${bound.action}`, { was: actionLabel(bound.action) ?? bound.action, source: fromFile.has(id) ? "keybindings.json" : "built-in", wasAction: bound.action })
      else held.set(`e:${bound.owner}`, { was: `${bound.owner} key`, source: "extension", owner: bound.owner })
    }
    if (target.kind === "leader") note(bindings.leader.get(target.key), `leader:${target.key}`)
    else if (target.kind === "direct") for (const seq of target.seqs) {
      note(bindings.direct.get(seq), seq)
      note(bindings.inline.get(seq), seq)
    }
    return [...held.values()]
  }
  for (const entry of input.file ?? []) {
    for (const id of idsOf(entry.target)) fromFile.add(id)
    if (entry.action === null) free(entry.target)
    else set(entry.target, { action: entry.action })
  }
  const overrides: KeyOverride[] = []
  for (const key of input.extensions ?? []) {
    const parsed = parseKeySpec(key.spec)
    if (!parsed.ok) {
      problems.push(`${key.owner}: key ${parsed.error}`)
      continue
    }
    for (const held of holders(parsed.target)) {
      if (held.source === "extension") {
        if (held.owner !== key.owner) problems.push(`${held.owner}: key ${parsed.target.label} is also bound by ${key.owner}, which loads later and wins`)
      } else overrides.push({ key: parsed.target.label, owner: key.owner, was: held.was, source: held.source, ...(held.wasAction ? { wasAction: held.wasAction } : {}) })
    }
    set(parsed.target, { run: key.run, owner: key.owner, label: parsed.target.label })
  }
  if (overrides.length) bindings.overrides = overrides
  return { bindings, problems }
}
