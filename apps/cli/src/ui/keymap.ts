import type { TuiActions } from "@mendcode/extension-api"
import { EDIT_ACTIONS, EDIT_KEYS, type EditAction } from "../view/editor-actions"
import { keyText, preferChord } from "./key-labels"

/**
 * v1's leader chords and function keys (config/keybinds.ts), limited to actions MendCode has. `ctrl+x` arms the
 * leader for 2 s; the next key picks the action. Pure: the app owns the one timer that disarms it.
 *
 * The tables below are the defaults. `keybindings.json` and extension keys (`api.key`) produce a `Bindings` value
 * (see extensions/keybindings.ts); with none of them, `DEFAULT_BINDINGS` behaves exactly as before.
 */
export type KeyAction =
  | `edit.${EditAction}` | "model.previous" | "model.favorite.next" | "model.favorite.previous" | "agent.next" | "agent.previous" | "agent.picker" | "stash.list" | "terminal.suspend" | "scrollbar.toggle" | "username.toggle" | "terminal-title.toggle" | "tips.toggle" | "thinking.toggle" | "sticky-prompt.toggle"
  | "new" | "sessions" | "model" | "theme" | "compact" | "quit" | "agents" | "help" | "usage" | "changes" | "dock" | "model.next" | "effort.next"
  // Actions app.ts already performs from keys; each has a default key that stays bound unless the user unbinds it.
  | "palette" | "tools.expand" | "permission.next" | "view.next" | "queue.send" | "queue.drop" | "queue.flip" | "image.paste" | "scroll.top" | "scroll.bottom" | "scroll.up" | "scroll.down"
  // The prompt editor (docs/editor.md): undo/redo, stash, the external editor and copying the last answer.
  | "edit.undo" | "edit.redo" | "stash.push" | "stash.pop" | "editor.open" | "message.copy" | "drafts.restore"
  // Session history (docs/sessions.md) and the layout: undo/redo of a whole message, the timeline, export, the sidebar and the dock's note.
  | "message.undo" | "message.redo" | "session.timeline" | "session.export" | "sidebar.toggle" | "panel.toggle" | "scratch.edit"
  // The last mermaid diagram of the session, full screen (/diagram).
  | "diagram.open" | "messages.open"
  | "session.history" | "variant.list" | "extensions.open" | "scroll.line-up" | "scroll.line-down" | "scroll.half-up" | "scroll.half-down" | "message.next" | "message.previous" | "message.last-user" | "messages.conceal"
  | "session.child.first" | "session.child.next" | "session.child.previous" | "session.parent"
  // Find in the transcript (ctrl+f): hits highlighted, next/previous, a count, esc closes.
  | "transcript.find"
  // Push-to-talk dictation (docs/voice.md): the first press records, the second transcribes into the prompt.
  | "voice.toggle"
  // One `<details>` block of an assistant message, folded or opened on its own (ctrl+o does all of them).
  | "details.toggle"
  // The code block, table, list, quote or diagram nearest the middle of the screen, put on the clipboard (the click on its `copy` button does the same).
  | "block.copy"
  // Composer recovery (docs/editor.md): reasoning effort one step back, search over earlier prompts, pull a queued prompt back, the shortcut overlay and the Esc-Esc backtrack picker.
  | "effort.previous" | "history.search" | "queue.edit" | "shortcuts.toggle" | "backtrack.open"
  // ↑ and ↓ move inside the prompt and reach its history at the first and last row; these two walk it from any row.
  | "history.previous" | "history.next"
  | "selection.quote"
  // Comments on an answer's passages (docs/editor.md): comment on the selection (or the passage just copied), open the list, walk the answer's units, drop every pending comment.
  | "selection.comment" | "comment.list" | "comment.reply" | "comment.clear"
  // The right panel takes the keyboard (alt+} is the same key, handled by the panel itself).
  | "panel.focus"
  // The open file (docs/file-viewer.md): switch the right slot between the file and the panel, close the file, and open a path from the transcript.
  | "file.switch" | "file.close" | "file.open"

/** Every action a key can run by name, in the order `docs/extensions-tui.md` lists them. */
export const KEY_ACTIONS: readonly KeyAction[] = [
  ...EDIT_ACTIONS.map((name) => `edit.${name}` as const), "model.previous", "model.favorite.next", "model.favorite.previous", "agent.next", "agent.previous", "agent.picker", "stash.list", "terminal.suspend", "scrollbar.toggle", "username.toggle", "terminal-title.toggle", "tips.toggle", "thinking.toggle", "sticky-prompt.toggle",
  "new", "sessions", "model", "theme", "compact", "quit", "agents", "help", "usage", "changes", "dock", "model.next", "effort.next",
  "palette", "tools.expand", "permission.next", "view.next", "queue.send", "queue.drop", "queue.flip", "image.paste", "scroll.top", "scroll.bottom", "scroll.up", "scroll.down",
  "edit.undo", "edit.redo", "stash.push", "stash.pop", "editor.open", "message.copy", "drafts.restore",
  "message.undo", "message.redo", "session.timeline", "session.export", "sidebar.toggle", "panel.toggle", "scratch.edit", "diagram.open", "messages.open",
  "session.history", "variant.list", "extensions.open", "scroll.line-up", "scroll.line-down", "scroll.half-up", "scroll.half-down", "message.next", "message.previous", "message.last-user", "messages.conceal",
  "session.child.first", "session.child.next", "session.child.previous", "session.parent", "transcript.find", "voice.toggle", "details.toggle", "block.copy",
  "effort.previous", "history.search", "queue.edit", "shortcuts.toggle", "backtrack.open", "history.previous", "history.next",
  "selection.quote", "selection.comment", "comment.list", "comment.reply", "comment.clear", "panel.focus", "file.switch", "file.close", "file.open",
]

/**
 * A key action, `command:<name>` (a slash command, built-in or terminal extension), `page:<id>` (an extension page), `modal:<id>`
 * (an extension modal) or `action:<id>` (an extension's named action, `api.action`).
 */
export type BindingAction = KeyAction | `command:${string}` | `page:${string}` | `modal:${string}` | `action:${string}`

export const LEADER_KEY = "\x18"
export const LEADER_TIMEOUT_MS = 2_000

/** `<leader><key>` → action, as in v1 where the action exists here. */
export const LEADER_CHORDS: Readonly<Record<string, KeyAction>> = {
  n: "new",
  l: "sessions",
  m: "model",
  t: "theme",
  c: "compact",
  q: "quit",
  a: "agents",
  U: "usage",
  d: "changes",
  // v1's <leader>e (external editor) and <leader>y (copy message); v1 has no stash key, so p (park) and o (pop) are ours.
  e: "editor.open",
  y: "message.copy",
  p: "stash.push",
  o: "stash.pop",
  // v1's undo/redo chords; z stays an undo alias for existing v2 users.
  z: "message.undo",
  r: "message.redo",
  g: "session.timeline",
  G: "session.history",
  h: "tips.toggle",
  x: "session.export",
  b: "sidebar.toggle",
  B: "panel.toggle",
  s: "scratch.edit",
  // The last diagram of the session, full screen.
  i: "diagram.open",
  // Message Actions: pick a message to copy, revert or fork.
  k: "messages.open",
  "\x1b[B": "session.child.first",
  "\x1bOB": "session.child.first",
  u: "message.undo",
  "/": "transcript.find",
  v: "voice.toggle",
  f: "details.toggle",
  Y: "block.copy",
  // A chord for every default alt key that has no other way in, so a Mac terminal that types a character for Option still has them:
  // w comment (W its list), ? history search, [ ] earlier and later prompt, , . effort, ^ the queued prompt (alt+up), j J jump, ' " yank, } the right panel.
  w: "selection.comment",
  W: "comment.list",
  "?": "history.search",
  "[": "history.previous",
  "]": "history.next",
  ",": "effort.previous",
  ".": "effort.next",
  "^": "queue.edit",
  j: "edit.jump-forward",
  J: "edit.jump-backward",
  "'": "edit.yank",
  "\"": "edit.yank-pop",
  "}": "panel.focus",
  "{": "file.switch",
  // The file viewer: open a path of the transcript, close the open file (a symbol each: the letters are taken).
  ";": "file.open",
  "-": "file.close",
}

/**
 * ctrl+g, the comment key every keyboard has: one control byte, so it needs neither Option sent as Alt (a Mac) nor the keyboard protocol.
 * It always comments; the `commentKey` setting only decides what the other keys of `selection.comment` (alt+q, the `ctrl+x w` chord) do.
 */
export const COMMENT_KEY = "\x07"

/** Keys that act directly (no leader). F2/F3 arrive as SS3 or CSI depending on the terminal. */
export const DIRECT_KEYS: Readonly<Record<string, KeyAction>> = {
  // ctrl+g and alt+q comment on the selection (or the passage just copied); with neither they walk the newest answer. ctrl+g is first: a hint
  // names the first key of an action. What alt+q did before, quoting the selection into the prompt, is `selection.quote`, bindable in
  // keybindings.json and the `commentKey` setting's other value.
  [COMMENT_KEY]: "selection.comment",
  "\x1bq": "selection.comment", "\x1b[113;3u": "selection.comment",
  "\x1bl": "comment.list", "\x1b[108;3u": "comment.list", // alt+l: the pending comments as a list
  "\x1b[12;2~": "model.previous", "\x1b[1;2Q": "model.previous", "\x1a": "terminal.suspend",
  "\x14": "dock", // ctrl+t
  "\x06": "transcript.find", // ctrl+f (the arrow keys still move the prompt cursor)
  "\x1bOQ": "model.next", // F2
  "\x1b[12~": "model.next",
  "\x1bOR": "effort.next", // F3
  "\x1b[13~": "effort.next",
  "\x1b,": "effort.previous", // alt+, and alt+. step the effort down and up (Codex's reasoning shortcuts)
  "\x1b.": "effort.next",
  "\x1br": "history.search", // alt+r: ctrl+r is the draft restore
  "\x1bp": "history.previous", "\x1b[112;3u": "history.previous", // alt+p: an earlier prompt from any row (ctrl+p is the palette)
  "\x1bn": "history.next", "\x1b[110;3u": "history.next", // alt+n
  "\x1b[1;3A": "queue.edit", // alt+up: pull the newest queued prompt back into the prompt
  "\x1b[13;2~": "variant.list",
  "\x1b[1;2R": "variant.list",
  "\x1b\x19": "scroll.line-up",
  "\x1b\x05": "scroll.line-down",
  "\x1b\x15": "scroll.half-up",
  "\x1b\x04": "scroll.half-down",
  "\x1b[121;7u": "scroll.line-up",
  "\x1b[101;7u": "scroll.line-down",
  "\x1b[117;7u": "scroll.half-up",
  "\x1b[100;7u": "scroll.half-down",
  "\x1c": "panel.focus", // ctrl+\: the right panel, or the open file, takes the keyboard (one control byte, next to ctrl+] for the side chat)
  "\x1b}": "panel.focus", // alt+}: the same
  "\x1b{": "file.switch", // alt+{: the right slot shows the open file or the panel
  "\x1bo": "file.open", // alt+o: open a file path of the transcript
  "\x1bx": "file.close", // alt+x: close the open file
  "\x1f": "edit.undo", // ctrl+_ (also ctrl+/ in most terminals): v1's input_undo
  "\x19": "edit.redo", // ctrl+y: v1's input_redo
}

/**
 * Default keys the prompt handles in place, with their own conditions (an empty prompt, a queued message…).
 * The app asks `bindings.inline.get(key)`; unbinding one in keybindings.json removes it from here.
 */
export const INLINE_KEYS: Readonly<Record<string, KeyAction>> = {
  ...Object.fromEntries(Object.entries(EDIT_KEYS).map(([key, action]) => [key, `edit.${action}` as KeyAction])),
  "\x10": "palette", // ctrl+p
  "\x0f": "tools.expand", // ctrl+o
  "\x1b[Z": "permission.next", // shift+tab
  "\t": "view.next", // tab on an empty prompt (a menu or text keeps tab for completion)
  "\x13": "queue.send", // ctrl+s
  "\x0b": "queue.drop", // ctrl+k
  "\x1b[13;6u": "queue.flip", // ctrl+shift+enter: send this one message the other way (ctrl+enter stays a newline)
  "\x1b[27;6;13~": "queue.flip",
  "\x16": "image.paste", // ctrl+v
  "\x12": "drafts.restore", // ctrl+r: the newest unsent draft of an earlier session comes back
  "\x1b[H": "scroll.top",
  "\x1bOH": "scroll.top",
  "\x1b[1~": "scroll.top",
  "\x1b[F": "scroll.bottom",
  "\x1bOF": "scroll.bottom",
  "\x1b[4~": "scroll.bottom",
  "\x1b[5~": "scroll.up", // pgup
  "\x1b[6~": "scroll.down", // pgdn
  "\x1b[A": "session.parent", "\x1bOA": "session.parent",
  "\x1b[C": "session.child.next", "\x1bOC": "session.child.next",
  "\x1b[D": "session.child.previous", "\x1bOD": "session.child.previous",
}

/** What a key runs: a named action, or a function an extension registered with `api.key`. */
export type Bound = { action: BindingAction } | { run: (actions: TuiActions) => void; owner: string; label: string }

/** An extension key that took over a key something else held: who now holds it, what it replaced and where that came from. Reported in /keymap and /extensions. */
export type KeyOverride = { key: string; owner: string; was: string; source: "built-in" | "keybindings.json" | "extension"; wasAction?: string }

export type Bindings = {
  /** Extension keys that replaced another binding (present only when there are some). */
  overrides?: KeyOverride[]
  disabled: Set<string>
  leaderKey: string
  /** Chord character (lowercase) after the leader. */
  leader: Map<string, Bound>
  /** Raw key sequence → what it runs, acting at once. */
  direct: Map<string, Bound>
  /** Raw key sequence → the prompt's own action, evaluated where the prompt handles it. */
  inline: Map<string, KeyAction>
}

export function createBindings(): Bindings {
  return {
    disabled: new Set(),
    leaderKey: LEADER_KEY,
    leader: new Map(Object.entries(LEADER_CHORDS).map(([key, action]) => [key, { action }])),
    direct: new Map(Object.entries(DIRECT_KEYS).map(([seq, action]) => [seq, { action }])),
    inline: new Map(Object.entries(INLINE_KEYS)),
  }
}

/** Never mutated: `resolveKey` uses it when the caller has no custom bindings. */
export const DEFAULT_BINDINGS: Bindings = createBindings()

export type LeaderState = { armedAt?: number | undefined }

export type KeyResolution =
  /** The key is not a keymap key; handle it as usual. */
  | { kind: "pass" }
  /** The leader was armed (show the hint) or a chord was aborted; nothing else to do. */
  | { kind: "armed" }
  | { kind: "cancelled" }
  | { kind: "action"; action: BindingAction }
  /** A key an extension registered with `api.key`. */
  | { kind: "run"; run: (actions: TuiActions) => void; owner: string }

function resolution(bound: Bound): KeyResolution {
  return "action" in bound ? { kind: "action", action: bound.action } : { kind: "run", run: bound.run, owner: bound.owner }
}

/**
 * Resolves one raw key against the keymap. `state` is updated in place (armed or cleared). A chord key only counts
 * while the leader is armed and not older than LEADER_TIMEOUT_MS; any other key while armed cancels the leader
 * and is swallowed, as in v1.
 */
export function resolveKey(state: LeaderState, key: string, now: number, bindings: Bindings = DEFAULT_BINDINGS): KeyResolution {
  const armed = state.armedAt !== undefined && now - state.armedAt <= LEADER_TIMEOUT_MS
  if (armed) {
    state.armedAt = undefined
    const chord = bindings.leader.get(key) ?? bindings.leader.get(key.toLowerCase())
    return chord ? resolution(chord) : { kind: "cancelled" }
  }
  state.armedAt = undefined
  if (key === bindings.leaderKey) {
    state.armedAt = now
    return { kind: "armed" }
  }
  const direct = bindings.direct.get(key)
  return direct ? resolution(direct) : { kind: "pass" }
}

export const ACTION_LABEL: Readonly<Record<KeyAction, string>> = {
  "selection.quote": "quote the selection into the prompt",
  "selection.comment": "comment on the selection (or walk the newest answer)",
  "comment.list": "the pending comments: list, edit, reorder",
  "comment.reply": "reply mode: walk the newest answer's passages",
  "comment.clear": "drop every pending comment",
  "panel.focus": "focus the right panel or the open file (esc gives the keyboard back)",
  "file.switch": "show the open file or the right panel in the right slot",
  "file.close": "close the open file",
  "file.open": "open the file path in the selection, or in the item in view (a list when there are several)",
  ...Object.fromEntries(EDIT_ACTIONS.map((name) => [`edit.${name}`, `prompt ${name.replaceAll("-", " ")}`])) as Record<`edit.${EditAction}`, string>,
  "model.previous": "previous recent model", "model.favorite.next": "next favorite model", "model.favorite.previous": "previous favorite model", "agent.next": "next primary agent", "agent.previous": "previous primary agent", "agent.picker": "primary agent picker", "stash.list": "prompt stash", "terminal.suspend": "suspend terminal", "scrollbar.toggle": "toggle scrollbar", "username.toggle": "toggle username", "terminal-title.toggle": "toggle window title", "tips.toggle": "toggle home tips", "thinking.toggle": "toggle thinking", "sticky-prompt.toggle": "toggle pinned prompt",
  new: "new session",
  sessions: "sessions",
  model: "model",
  theme: "themes",
  compact: "compact",
  quit: "quit",
  agents: "agents",
  help: "help",
  usage: "usage",
  changes: "changes",
  dock: "session widgets",
  "model.next": "next model",
  "effort.next": "next effort",
  palette: "command palette",
  "tools.expand": "expand tool output",
  "permission.next": "permissions: ask · edits · full · plan",
  "view.next": "view: minimal · balanced · full (empty prompt)",
  "queue.send": "send first queued now (or continue a held queue)",
  "queue.drop": "drop last queued (empty prompt)",
  "queue.flip": "send this message the other way: steer a running turn, or queue when the policy steers",
  "image.paste": "paste an image from the clipboard",
  "scroll.top": "scroll to the top (empty prompt)",
  "scroll.bottom": "scroll to the bottom (empty prompt)",
  "scroll.up": "scroll up",
  "scroll.down": "scroll down",
  "edit.undo": "undo prompt edit",
  "edit.redo": "redo prompt edit",
  "stash.push": "stash the prompt",
  "stash.pop": "restore the last stash",
  "editor.open": "edit the prompt in $EDITOR",
  "message.copy": "copy the last answer",
  "drafts.restore": "restore the newest unsent draft",
  "message.undo": "undo the last message",
  "message.redo": "redo the undone message",
  "session.timeline": "timeline",
  "session.export": "export the session",
  "sidebar.toggle": "toggle the sidebar",
  "panel.toggle": "toggle the right panel",
  "scratch.edit": "edit the scratch note",
  "diagram.open": "open the last diagram full screen",
  "messages.open": "open message actions",
  "session.history": "complete session history",
  "variant.list": "select variant",
  "extensions.open": "extension manager",
  "scroll.line-up": "scroll one line up",
  "scroll.line-down": "scroll one line down",
  "scroll.half-up": "scroll half a page up",
  "scroll.half-down": "scroll half a page down",
  "message.next": "next message",
  "message.previous": "previous message",
  "message.last-user": "last user message",
  "messages.conceal": "toggle Markdown concealment",
  "session.child.first": "open first child session",
  "session.child.next": "next child session",
  "session.child.previous": "previous child session",
  "session.parent": "open parent session",
  "transcript.find": "find in the transcript",
  "voice.toggle": "dictate: record, then transcribe",
  "details.toggle": "fold or open the <details> block in view",
  "block.copy": "copy the code block, table, list, quote or diagram in view",
  "effort.previous": "previous effort",
  "history.search": "search earlier prompts",
  "queue.edit": "pull the newest queued prompt back to edit",
  "shortcuts.toggle": "shortcut overlay",
  "backtrack.open": "edit an earlier prompt and resend",
  "history.previous": "earlier prompt, from any row",
  "history.next": "later prompt, or the text being typed",
}

/** Label of any binding action: built-ins by name, `command:`, `page:`, `modal:` and `action:` by what they open or run. */
export function actionLabel(action: BindingAction): string {
  if (action.startsWith("command:")) return `/${action.slice("command:".length)}`
  if (action.startsWith("page:")) return `page ${action.slice("page:".length)}`
  if (action.startsWith("modal:")) return `modal ${action.slice("modal:".length)}`
  if (action.startsWith("action:")) return `action ${action.slice("action:".length)}`
  return ACTION_LABEL[action as KeyAction]
}

const NAMED_KEYS: ReadonlyArray<readonly [seq: string, name: string]> = [
  ["\x1b[Z", "shift+tab"], ["\x1b[A", "up"], ["\x1bOA", "up"], ["\x1b[B", "down"], ["\x1bOB", "down"], ["\x1b[C", "right"], ["\x1bOC", "right"], ["\x1b[D", "left"], ["\x1bOD", "left"],
  ["\x1b[H", "home"], ["\x1bOH", "home"], ["\x1b[1~", "home"], ["\x1b[F", "end"], ["\x1bOF", "end"], ["\x1b[4~", "end"], ["\x1b[5~", "pgup"], ["\x1b[6~", "pgdn"],
  ["\x1b[2~", "insert"], ["\x1b[3~", "delete"], ["\x1bOP", "f1"], ["\x1b[11~", "f1"], ["\x1bOQ", "f2"], ["\x1b[12~", "f2"], ["\x1bOR", "f3"], ["\x1b[13~", "f3"], ["\x1bOS", "f4"], ["\x1b[14~", "f4"],
  ["\x1b[15~", "f5"], ["\x1b[17~", "f6"], ["\x1b[18~", "f7"], ["\x1b[19~", "f8"], ["\x1b[20~", "f9"], ["\x1b[21~", "f10"], ["\x1b[23~", "f11"], ["\x1b[24~", "f12"],
  ["\r", "enter"], ["\n", "ctrl+j"], ["\t", "tab"], ["\x7f", "backspace"], ["\b", "backspace"], ["\x1b", "esc"], [" ", "space"],
]

/** The name of a raw key as `keybindings.json` and `help` write it ("ctrl+o", "f2", "alt+x", "pgup"); undefined when it has none. */
export function keyName(seq: string): string | undefined {
  const modifier = (number: string) => ({ "2": "shift", "3": "alt", "4": "alt+shift", "5": "ctrl", "6": "ctrl+shift", "7": "ctrl+alt" } as Record<string, string>)[number]
  const arrow = /^\x1b\[1;([2-7])([ABCDHF])$/.exec(seq)
  if (arrow) return `${modifier(arrow[1]!)}+${({ A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" } as Record<string, string>)[arrow[2]!]}`
  const letter = /^\x1b\[(\d+);([2-7])u$/.exec(seq)
  if (letter) return `${modifier(letter[2]!)}+${letter[1] === "13" ? "enter" : String.fromCharCode(Number(letter[1]))}`
  const tilde = /^\x1b\[(3|12);([2-7])~$/.exec(seq)
  if (tilde) return `${modifier(tilde[2]!)}+${tilde[1] === "3" ? "delete" : "f2"}`
  if (seq === "\x1b[1;2Q") return "shift+f2"
  if (/^\x1b[\x01-\x1a]$/.test(seq)) return `ctrl+alt+${String.fromCharCode(seq.charCodeAt(1) + 96)}`
  const modified = /^\x1b\[(\d+);7u$/.exec(seq)
  if (modified) return `ctrl+alt+${String.fromCharCode(Number(modified[1]))}`
  if (seq === "\x1b[13;2~" || seq === "\x1b[1;2R") return "shift+f3"
  const named = NAMED_KEYS.find(([raw]) => raw === seq)
  if (named) return named[1]
  if (seq.length === 1 && seq >= "\x01" && seq <= "\x1a") return `ctrl+${String.fromCharCode(seq.charCodeAt(0) + 96)}`
  const punctuation: Readonly<Record<string, string>> = { "\x00": "ctrl+space", "\x1c": "ctrl+\\", "\x1d": "ctrl+]", "\x1e": "ctrl+^", "\x1f": "ctrl+_" }
  if (punctuation[seq]) return punctuation[seq]
  if (seq.length === 2 && seq[0] === "\x1b" && seq[1]! > " " && seq[1]! !== "\x7f") return `alt+${seq[1]}`
  return undefined
}

function describe(key: string) {
  return keyName(key) ?? (/^[\x21-\x7e]$/.test(key) ? key : JSON.stringify(key).slice(1, -1))
}

function boundLabel(bound: Bound) {
  return "action" in bound ? actionLabel(bound.action) : `extension ${bound.owner}`
}

/** `ctrl+x n  new session`… for /help and the leader hint, in a stable order; `bindings` are the effective ones. */
export function keymapHelp(bindings: Bindings = DEFAULT_BINDINGS): Array<{ keys: string; label: string }> {
  const chords = new Map<string, { keys: string; label: string }>()
  for (const [key, bound] of bindings.leader) {
    const row = { keys: `${describe(bindings.leaderKey)} ${describe(key)}`, label: boundLabel(bound) }
    chords.set(`${row.keys}\0${row.label}`, row)
  }
  // F2 arrives as two sequences: one row per distinct name and meaning.
  const direct = new Map<string, { keys: string; label: string }>()
  for (const [seq, bound] of bindings.direct) direct.set(`${describe(seq)}\0${boundLabel(bound)}`, { keys: keyText("label" in bound ? bound.label : describe(seq)), label: boundLabel(bound) })
  return [...chords.values(), ...direct.values()]
}

/** The one-line hint shown while the leader is armed. */
export function leaderHint(bindings: Bindings = DEFAULT_BINDINGS): string {
  return keyText(`${describe(bindings.leaderKey)} · ${[...new Set([...bindings.leader].map(([key, bound]) => `${describe(key)} ${boundLabel(bound)}`))].join(" · ")}`)
}

/** The chords bound to an action, as written in a hint: `ctrl+x w`. */
export function chordNames(bindings: Bindings, action: BindingAction): string[] {
  const names: string[] = []
  for (const [key, bound] of bindings.leader) if ("action" in bound && bound.action === action) names.push(`${describe(bindings.leaderKey)} ${describe(key)}`)
  return names
}

/**
 * The key a hint with room for one name shows for `action`, given the Alt key `alt` that was found for it. On a Mac whose Option is not
 * known to send Alt in this session (no Alt key has arrived and the terminal gave no real key reports) the chord is shown instead, because
 * it works everywhere; once Option is known to work, and on every other OS, the Alt key is shown as before.
 */
export function hintKey(bindings: Bindings, action: BindingAction, alt: string | undefined): string | undefined {
  if (alt === undefined || !preferChord() || !/(^|\+)alt\+/.test(alt)) return alt
  return chordNames(bindings, action)[0] ?? alt
}

/**
 * The key a hint names for `action`, as bound now and as the user reads it: the first key of its binding (a rebound action shows the new
 * key, an unbound one nothing), the `ctrl+x` chord where a Mac has not shown Option to work (`hintKey`), and `opt`/`⌥` for `alt` (`keyText`).
 * Undefined when the action has no key, so a hint leaves the key out instead of naming one that does nothing.
 */
export function actionHint(bindings: Bindings, action: KeyAction): string | undefined {
  const name = inlineKeyNames(bindings, action)[0] ?? chordNames(bindings, action)[0]
  const shown = name === undefined ? undefined : hintKey(bindings, action, name)
  return shown === undefined ? undefined : keyText(shown)
}

/** Key names bound to an inline action, without duplicates ("home" once for its three encodings), for the help rows. Canonical (`alt+q`): wrap what is drawn in `keyText`. */
export function inlineKeyNames(bindings: Bindings, action: KeyAction): string[] {
  const names: string[] = []
  for (const [seq, bound] of bindings.inline) if (bound === action) names.push(describe(seq))
  for (const [seq, bound] of bindings.direct) if ("action" in bound && bound.action === action) names.push(describe(seq))
  return [...new Set(names)]
}
