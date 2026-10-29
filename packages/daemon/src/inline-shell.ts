import { randomBytes } from "node:crypto"

/** What the engine needs to run: the marker in the prompt text and the shell command (arguments already bound as quoted words) behind it. */
export type InlineShell = { marker: string; command: string }

const MARKER = /\[\[inline-shell:[0-9a-f]{32}\]\]/g
const MAX_HELD = 256

/**
 * Inline shell fragments of custom commands (`!`cmd``) waiting for their turn. The daemon puts a marker in the prompt and keeps the
 * command here; the native engine runs it as an ordinary `shell` tool call (permission mode, rules, approval, sandbox) and swaps
 * the marker for the output. A marker typed by anyone else is not in the table and stays plain text.
 */
export function createInlineShellTable() {
  const held = new Map<string, string>()
  return {
    hold(command: string): string {
      const marker = `[[inline-shell:${randomBytes(16).toString("hex")}]]`
      held.set(marker, command)
      if (held.size > MAX_HELD) held.delete(held.keys().next().value!)
      return marker
    },
    /** The held commands whose markers appear in `text`, in order of appearance. */
    find(text: string): InlineShell[] {
      const found: InlineShell[] = []
      for (const marker of text.match(MARKER) ?? []) {
        const command = held.get(marker)
        if (command !== undefined && !found.some((entry) => entry.marker === marker)) found.push({ marker, command })
      }
      return found
    },
  }
}
