import type { ALT_LABELS } from "../view/tui-profile"

/**
 * The one place key hints are written for the user. Key names everywhere else (`keyName`, `keybindings.json`, docs, extensions) keep the
 * canonical `alt`; a Mac keyboard has no Alt, so what is displayed says Option there. `keyText` rewrites the `alt+` tokens of a hint,
 * so every formatter (footer, slash menu, /help, /keymap, toasts, tutorial) calls it with the text it is about to draw.
 *
 * Like the theme, the choice is module state: the app sets it from the profile's `altLabel` and the platform (`configureKeyLabels`);
 * without it hints stay canonical, so a test or a script never depends on the host OS.
 */
export type AltLabel = (typeof ALT_LABELS)[number]
/** What replaces `alt`: `opt` and `⌥` for a Mac, `alt` as it is. */
export type AltWord = "alt" | "opt" | "⌥"
/** `altWorks`: Option is known to send Alt in this session (an Alt key arrived, or the terminal reports keys for real). Unknown is false. */
export type KeyLabelState = { setting: AltLabel; platform: string | undefined; altWorks: boolean }

const INITIAL: KeyLabelState = { setting: "auto", platform: undefined, altWorks: false }
let current: KeyLabelState = INITIAL

/** True for the platform whose keyboards have Option instead of Alt (`process.platform` of macOS). */
export const isMac = (platform: string | undefined) => platform === "darwin"

/** The word a setting and a platform give: `auto` follows the platform, the explicit values win on any OS. */
export function altWord(setting: AltLabel, platform: string | undefined): AltWord {
  if (setting === "alt") return "alt"
  if (setting === "opt") return "opt"
  if (setting === "symbol") return "⌥"
  return isMac(platform) ? "opt" : "alt"
}

/**
 * Sets what hints say. A key that is present replaces the old value, even with `undefined` (a new app with no platform goes back to
 * canonical hints); a key that is absent keeps it (a profile change does not touch the platform).
 */
export function configureKeyLabels(next: { setting?: AltLabel; platform?: string | undefined; altWorks?: boolean }) {
  current = { setting: next.setting ?? current.setting, platform: "platform" in next ? next.platform : current.platform, altWorks: next.altWorks ?? current.altWorks }
}

/**
 * True on a Mac where nothing has shown yet that Option sends Alt: a hint with room for one key then names the `ctrl+x` chord of an action,
 * which works in every terminal. Never true off macOS, so those hints are the Alt keys they always were, and not when the user chose how
 * Alt is written (`altLabel` other than `auto`): that is a request to see the Alt keys.
 */
export const preferChord = () => isMac(current.platform) && !current.altWorks && current.setting === "auto"

export const keyLabelState = (): KeyLabelState => current
export const restoreKeyLabels = (state: KeyLabelState) => { current = state }
export const resetKeyLabels = () => { current = INITIAL }
export const currentAltWord = (): AltWord => altWord(current.setting, current.platform)

const ALT_TOKEN = /(?<![\w-])(Alt|alt)\+/g

/**
 * `alt+q` as the user reads it: `opt+q`, or `⌥q` for the symbol (the symbol drops the plus: `ctrl+⌥x`). A hint of several keys
 * ("alt+enter · ctrl+j") is rewritten whole; text without an `alt+` token comes back unchanged, and so does every hint with `alt`.
 */
export function keyText(text: string): string {
  const word = currentAltWord()
  if (word === "alt" || !text.includes("lt+")) return text
  return text.replace(ALT_TOKEN, (_, token: string) => word === "⌥" ? "⌥" : token === "Alt" ? "Opt+" : "opt+")
}

/** The same for a list of key names (`inlineKeyNames`). */
export const keyTexts = (names: readonly string[]): string[] => names.map(keyText)
