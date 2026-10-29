/**
 * The kitty keyboard protocol (https://sw.kovidgoyal.net/kitty/keyboard-protocol/), asked for on a Mac so that Option+key arrives as a key
 * with the alt modifier instead of the character Option composes (Option+Q is `œ`, and the alt+q binding never fires).
 *
 * The terminal is asked first (`CSI ? u` followed by a primary device attributes request, which every terminal answers): only a terminal
 * that answers the first one is switched, so one that does not know the protocol sees nothing but two queries it ignores. The flags are
 * pushed on a stack (`CSI > flags u`) and popped when the screen is left, which is also what the external editor and Ctrl+Z do.
 *
 * With "report all keys" on, every key arrives as `CSI code ; modifiers ; text u`. `translate` turns those back into the sequences the rest
 * of the app already binds (`a`, `\r`, `\x03`, `\x1bq`), so nothing downstream learns about the protocol. The pure parts are here; the
 * screen owns when they are used.
 */
export const KEYBOARD_QUERY = "\x1b[?u\x1b[c"
/** Disambiguate (1), alternate keys (4), all keys as escape codes (8) and associated text (16). The text keeps `@` typable where Option composes it. */
export const KEYBOARD_FLAGS = 1 | 4 | 8 | 16
export const KEYBOARD_PUSH = `\x1b[>${KEYBOARD_FLAGS}u`
export const KEYBOARD_POP = "\x1b[<u"

export type KeyboardState = "idle" | "asked" | "on" | "refused"

/** Only a Mac has the Option problem, and only `auto` asks: Linux and Windows terminals are never queried. */
export const keyboardWanted = (setting: "auto" | "off", platform: string | undefined) => setting === "auto" && platform === "darwin"

const KEYS_REPLY = /\x1b\[\?\d+u/g
const DEVICE_REPLY = /\x1b\[\?[\d;]*c/g
/** A reply cut by the chunk boundary. A lone Esc or `Esc [` is a key press and is never held back. */
const PARTIAL = /\x1b\[\?[\d;]*$/

const SHIFT = 1
const ALT = 2
const CTRL = 4
const LOCKS = 64 | 128
const KEYPAD_FIRST = 57399
const KEYPAD = "0123456789./*-+\r="

const CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d*)(?::(\d+))?)?(?:;([\d:]*))?u$/

const codepoint = (code: number) => code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""

/**
 * One `CSI u` key as the sequence a terminal without the protocol would have sent; anything that is not a `CSI u` key comes back as it is.
 * `altBound` says whether an `Esc`-prefixed key is something the app binds: Option+key that composed text (`@` on Option+2 of a Spanish
 * layout) is the binding when it is bound, and the text otherwise.
 */
export function translateKey(seq: string, altBound: (seq: string) => boolean = () => true): string {
  const match = CSI_U.exec(seq)
  if (!match) return seq
  const code = Number(match[1])
  const shifted = match[2] ? Number(match[2]) : undefined
  const base = match[3] ? Number(match[3]) : undefined
  const modifiers = Math.max(0, (match[4] ? Number(match[4]) : 1) - 1) & ~LOCKS
  if (match[5] === "3") return ""
  const text = match[6] ? match[6].split(":").map(Number).map(codepoint).join("") : ""
  const shift = (modifiers & SHIFT) !== 0
  const alt = (modifiers & ALT) !== 0
  const ctrl = (modifiers & CTRL) !== 0
  const other = modifiers & ~(SHIFT | ALT | CTRL)
  // Modifier and lock keys on their own (reported with "all keys"): nothing to type.
  if (code >= 57358 && code <= 57360 || code >= 57441 && code <= 57454) return ""
  if (other) return seq
  if (code >= KEYPAD_FIRST && code < KEYPAD_FIRST + KEYPAD.length) return modifiers & ~SHIFT ? seq : KEYPAD[code - KEYPAD_FIRST]!
  if (code >= 57344) return seq

  // The key a shortcut names is the one on the base layout (flag 4), so a Cyrillic ctrl+c is still ctrl+c.
  const key = codepoint(base ?? code)
  if (!ctrl && !alt) {
    if (code === 13) return shift ? seq : "\r"
    if (code === 9) return shift ? "\x1b[Z" : "\t"
    if (code === 127) return "\x7f"
    if (code === 27) return shift ? seq : "\x1b"
    if (text && !/[\x00-\x1f\x7f]/.test(text)) return text
    if (code === 0) return ""
    if (shift) return shifted !== undefined ? codepoint(shifted) : codepoint(code).toUpperCase()
    return codepoint(code)
  }
  if (shift && ctrl) return seq
  if (ctrl) {
    if (key >= "a" && key <= "z" || key === "@" || key >= "[" && key <= "_") return `${alt ? "\x1b" : ""}${String.fromCharCode(key.charCodeAt(0) & 0x1f)}`
    if (code === 32) return `${alt ? "\x1b" : ""}\x00`
    return seq
  }
  // alt, alone or with shift
  if (code === 127) return "\x1b\x7f"
  if (code === 13 || code === 9 || code === 27 || code === 0) return seq
  const typed = shift ? (shifted !== undefined ? codepoint(shifted) : key.toUpperCase()) : key
  const chord = `\x1b${typed}`
  return text && !altBound(chord) ? text : chord
}

/**
 * The protocol's state for one screen. `write` reaches the terminal; `enabled` is false off macOS, with the setting off or without a tty,
 * and then nothing is ever written.
 */
export function createKeyboardProtocol(options: { write(data: string): void; enabled: boolean }) {
  let enabled = options.enabled
  let state: KeyboardState = "idle"
  let asked = false
  let pending = ""
  const listeners = new Set<(active: boolean) => void>()

  return {
    get state() { return state },
    /** Told when the terminal switches the protocol on (true). The app uses it to name the keys that now work. */
    subscribe(listener: (active: boolean) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    get active() { return state === "on" },
    get enabled() { return enabled },
    /** Asks the terminal; the answer arrives through `consume`. Once per screen entry. */
    ask() {
      if (!enabled || state !== "idle") return
      state = "asked"
      asked = true
      options.write(KEYBOARD_QUERY)
    },
    /** What puts the flags back to what they were (empty when nothing was pushed). The caller writes it; the next `ask` starts again. */
    release(): string {
      const pop = state === "on" ? KEYBOARD_POP : ""
      state = "idle"
      return pop
    },
    /** The alternate screen has a flag stack of its own: inline mode borrows that screen for pages and overlays. */
    alternate(on: boolean): string {
      return state === "on" ? (on ? KEYBOARD_PUSH : KEYBOARD_POP) : ""
    },
    /** Switching it off pops at once; switching it on asks again if the screen is entered. */
    setEnabled(next: boolean, entered: boolean) {
      if (next === enabled) return
      enabled = next
      const pop = next ? "" : this.release()
      if (pop) options.write(pop)
      if (next && entered) this.ask()
    },
    /** Removes the terminal's answers from raw input and acts on them: a keyboard answer switches the protocol on. */
    consume(data: string): string {
      if (!asked) return data
      let rest = pending + data
      pending = ""
      let answered = false
      rest = rest.replace(KEYS_REPLY, () => (answered = true, ""))
      let finished = false
      rest = rest.replace(DEVICE_REPLY, () => (finished = true, ""))
      if (answered && state === "asked") {
        state = "on"
        options.write(KEYBOARD_PUSH)
        for (const listener of listeners) listener(true)
      } else if (finished && state === "asked") state = "refused"
      const partial = PARTIAL.exec(rest)
      if (partial) {
        pending = partial[0]
        rest = rest.slice(0, partial.index)
      }
      return rest
    },
    translate(seq: string, altBound?: (seq: string) => boolean): string {
      return state === "on" ? translateKey(seq, altBound) : seq
    },
  }
}

export type KeyboardProtocol = ReturnType<typeof createKeyboardProtocol>
