/** A large paste kept out of the prompt: the prompt holds `label`, the message gets `text` in its place. */
export type PendingPaste = { label: string; text: string }

/**
 * The label for a paste of `chars` characters, as Codex names it: `[Pasted Content 4210 chars]`, then `[Pasted Content 4210 chars #2]`…
 * while an earlier paste of the same size still has its label in the prompt.
 */
export function pasteLabel(chars: number, pending: readonly PendingPaste[]): string {
  const base = `[Pasted Content ${chars} chars`
  let highest = 0
  for (const paste of pending) {
    if (paste.label === `${base}]`) highest = Math.max(highest, 1)
    const suffix = paste.label.startsWith(`${base} #`) ? Number(paste.label.slice(base.length + 2, -1)) : NaN
    if (Number.isInteger(suffix)) highest = Math.max(highest, suffix)
  }
  return highest ? `${base} #${highest + 1}]` : `${base}]`
}

/** The pastes whose label is still in `text`: a label the user deleted or edited took its paste with it. */
export function livePastes(pending: readonly PendingPaste[], text: string): PendingPaste[] {
  return pending.filter((paste) => text.includes(paste.label))
}

/** `text` with each paste's label replaced by the pasted text (its first occurrence; the label is unique while it is pending). */
export function expandPastes(text: string, pending: readonly PendingPaste[]): string {
  let expanded = text
  for (const paste of pending) {
    const at = expanded.indexOf(paste.label)
    if (at >= 0) expanded = expanded.slice(0, at) + paste.text + expanded.slice(at + paste.label.length)
  }
  return expanded
}
