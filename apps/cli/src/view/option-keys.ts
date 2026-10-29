import type { Bindings } from "../ui/keymap"
import { keyName } from "../ui/keymap"
import { OPTION_LAYOUTS, type OptionBindingKey, type OptionLayout } from "./option-layouts"

/**
 * On a Mac, Option+key types a character unless the terminal sends Alt: Option+Q arrives as `œ`, not as Esc+q, and the alt+q binding
 * never fires. Terminals that report keys for real (the keyboard protocol, ui/keyboard-protocol.ts) do not have the problem; for the
 * others the only sign is the character itself, and the active keyboard layout decides which character that is.
 *
 * `OPTION_BINDINGS` are the default alt bindings reachable with a letter or a punctuation key, `OPTION_LAYOUTS` (option-layouts.ts) the
 * character each layout types for them. `optionBindingFor` gives the binding a character stands for on a layout; the app runs it only
 * where the binding means something (ui/app/option-keys.ts).
 */
export { OPTION_LAYOUTS, type OptionBindingKey, type OptionLayout }

/** The key each binding is pressed with, and what the terminal would have sent for it as an Alt key. */
export const OPTION_BINDINGS: Readonly<Record<OptionBindingKey, string>> = {
  q: "\x1bq", l: "\x1bl", r: "\x1br", p: "\x1bp", ",": "\x1b,", ".": "\x1b.", "}": "\x1b}", b: "\x1bb", s: "\x1bs", m: "\x1bm",
}

/** The layout the table starts from when the active one is not known. */
export const DEFAULT_OPTION_LAYOUT = "ABC"

const layoutById = new Map<string, OptionLayout>(OPTION_LAYOUTS.map((layout) => [layout.id, layout]))

/** `com.apple.keylayout.ABC` and `ABC` are the same layout. */
export const layoutId = (id: string) => id.replace(/^com\.apple\.keylayout\./, "")

export const knownLayout = (id: string): OptionLayout | undefined => layoutById.get(layoutId(id))

/**
 * The binding a lone character stands for when Option typed it on `layout` (an id; unknown or unset reads as the default layout),
 * or undefined when the layout is not in the table or its Option+key characters are different.
 */
export function optionBindingFor(char: string, layout: string | undefined): OptionBindingKey | undefined {
  const known = layout === undefined ? layoutById.get(DEFAULT_OPTION_LAYOUT) : layoutById.get(layoutId(layout))
  if (!known) return undefined
  return (Object.keys(known.typed) as OptionBindingKey[]).find((key) => known.typed[key] === char)
}

/** Every character any layout types for a binding, with the Esc-prefixed key it stands for: the page that tests the Option key reads it. */
export const OPTION_TYPED: Readonly<Record<string, string>> = Object.fromEntries(
  OPTION_LAYOUTS.flatMap((layout) => (Object.entries(layout.typed) as Array<[OptionBindingKey, string]>).map(([key, char]) => [char, OPTION_BINDINGS[key]] as const)),
)

/** Whether the keymap still binds the key a character stands for (a binding that was removed or moved is not announced or run). */
export function optionKeyFor(char: string, layout: string | undefined, bindings: Bindings): string | undefined {
  const key = optionBindingFor(char, layout)
  const seq = key === undefined ? undefined : OPTION_BINDINGS[key]
  if (!seq || !(bindings.direct.has(seq) || bindings.inline.has(seq))) return undefined
  return keyName(seq)
}

/**
 * True for a key that shows Option sends Alt for the keys that would type a character: Esc and a printable character, or CSI u with the alt
 * modifier of one. Not enough: Option+arrow (CSI 1;3 D keeps the modifier because the key types nothing), Option+Enter and Option+Delete, and
 * the Esc b, Esc f and Esc DEL that Terminal.app and iTerm2 send for Option+Left, Right and Delete by default, with Option still typing œ.
 */
export function showsAltWorks(key: string): boolean {
  const chord = /^\x1b([^\x1b[O])$/u.exec(key)
  if (chord) return chord[1]! > " " && chord[1]! !== "\x7f" && !"bBfF".includes(chord[1]!)
  const csi = /^\x1b\[(\d+)(?::\d*)*;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(key)
  // The modifier field is 1 plus the bits (shift 1, alt 2, ctrl 4, super 8); the lock bits (64, 128) are not part of the key.
  return csi !== null && Number(csi[1]) > 32 && Number(csi[1]) !== 127 && ((Number(csi[2]) - 1) & 2) !== 0
}

/** True for a key the terminal sent as an Alt combination (Esc then the key, or CSI u with the alt modifier): Option is acting as Alt. */
export function isAltSequence(key: string): boolean {
  return /^\x1b[^\x1b[O]$/u.test(key) || /^\x1b\[\d+(?::\d+)*;(?:3|4|7|8)(?::\d+)?u$/.test(key) || /^\x1b\[1;(?:3|4|7|8)[A-Z]$/.test(key)
}
