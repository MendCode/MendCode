/**
 * Model messages open with one of a few fixed spellings (`{"role":"user","content":`, ...). A stored message that
 * starts with one keeps a single control character in its place; JSON never starts with one, so the two forms cannot be
 * confused and a row written without it reads unchanged. Lossless: the prefix is restored byte for byte.
 */
const PREFIXES = [
  '{"role":"assistant","content":"","toolCalls":[{"id":',
  '{"role":"assistant","content":',
  '{"role":"user","content":',
  '{"role":"tool","toolCallId":',
] as const
const FIRST = 1

export function abbreviateMessage(text: string): string {
  for (let i = 0; i < PREFIXES.length; i++) if (text.startsWith(PREFIXES[i]!)) return String.fromCharCode(FIRST + i) + text.slice(PREFIXES[i]!.length)
  return text
}

export function expandMessage(text: string): string {
  const prefix = PREFIXES[text.charCodeAt(0) - FIRST]
  return prefix === undefined ? text : prefix + text.slice(1)
}
