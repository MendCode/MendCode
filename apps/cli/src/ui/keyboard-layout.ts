import { readFileSync } from "node:fs"
import path from "node:path"
import { layoutId } from "../view/option-keys"

/** Where macOS keeps the current input source: the HIToolbox preferences of the user. */
export const LAYOUT_PREFERENCES = "Library/Preferences/com.apple.HIToolbox.plist"

const PREFIX = "com.apple.keylayout."
/** A binary plist writes a string of 15 or more characters as `_`, an integer marker (0x10) with the length, then the characters. */
const BINARY_ID = /_\x10([\s\S])com\.apple\.keylayout\./g
const XML_ID = /<string>(com\.apple\.keylayout\.[^<]+)<\/string>/g

/**
 * The keyboard layout in the text of the preferences file (binary or XML), as the id after `com.apple.keylayout.` ("ABC", "Spanish-ISO");
 * undefined when the file names none or several (the file lists names, not ids, for the layouts that are only enabled).
 */
export function layoutFromPreferences(text: string): string | undefined {
  const ids = new Set<string>()
  for (const match of text.matchAll(BINARY_ID)) {
    const start = match.index + 3
    ids.add(text.slice(start, start + match[1]!.charCodeAt(0)))
  }
  for (const match of text.matchAll(XML_ID)) ids.add(match[1]!)
  const found = [...ids].filter((id) => id.startsWith(PREFIX))
  return found.length === 1 ? layoutId(found[0]!) : undefined
}

/** The current layout of the Mac the terminal runs on; read when a lone Option character arrives, so a layout switch is seen at the next key. */
export function currentLayout(home: string | undefined, read: (file: string) => string = (file) => readFileSync(file, "latin1")): string | undefined {
  if (!home) return undefined
  try { return layoutFromPreferences(read(path.join(home, LAYOUT_PREFERENCES))) } catch { return undefined }
}
