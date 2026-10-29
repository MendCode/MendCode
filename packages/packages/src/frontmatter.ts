/**
 * One frontmatter reader for skills, commands and agents. Real YAML (`Bun.YAML`), so block scalars (`description: |`),
 * quoted and multi-line values, lists and nested maps work as they do in Claude Code, Codex and pi files. Keys are
 * lowercased for lookup; the original spelling is kept in `keys` so unknown fields can be reported by name.
 * A frontmatter that is not valid YAML (an unquoted `description: use: this`) falls back to `key: value` lines and is
 * flagged `lenient`, so one sloppy file does not lose its body.
 */
export type ParsedFrontmatter = {
  data: Record<string, unknown>
  /** The fields as written, in file order. */
  keys: string[]
  body: string
  lenient?: boolean
  /** Why the frontmatter could not be read at all (the whole text is then the body). */
  problem?: string
}

export const MAX_FRONTMATTER_CHARS = 32_000
const FENCE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

function lines(source: string) {
  const data: Record<string, unknown> = {}
  const keys: string[] = []
  for (const line of source.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!pair) continue
    keys.push(pair[1]!)
    data[pair[1]!.toLowerCase()] = pair[2]!.trim().replace(/^(['"])(.*)\1$/, "$2")
  }
  return { data, keys }
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FENCE.exec(text)
  if (!match) return { data: {}, keys: [], body: text }
  const body = text.slice(match[0].length)
  const source = match[1] ?? ""
  if (source.length > MAX_FRONTMATTER_CHARS) return { data: {}, keys: [], body: text, problem: `frontmatter is larger than ${MAX_FRONTMATTER_CHARS} characters` }
  if (!source.trim()) return { data: {}, keys: [], body }
  try {
    const raw: unknown = Bun.YAML.parse(source)
    if (raw === null || raw === undefined) return { data: {}, keys: [], body }
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected a mapping")
    const data: Record<string, unknown> = {}
    const keys: string[] = []
    for (const [key, value] of Object.entries(raw)) {
      keys.push(key)
      data[key.toLowerCase()] = value
    }
    return { data, keys, body }
  } catch {
    const fallback = lines(source)
    return { ...fallback, body, lenient: true }
  }
}

/** A scalar as text: strings trimmed, numbers and booleans spelled out, anything structured is not text. */
export function frontmatterText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

/**
 * `argument-hint: [pr-number]` is a YAML list to a parser but a hint to the person who wrote it: a list is printed
 * back in brackets, so `[pr-number]` and `[a, b]` read as written.
 */
export function frontmatterHint(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map((entry) => frontmatterText(entry) ?? "").filter(Boolean).join(", ")}]`
  return frontmatterText(value)
}

export function frontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (text === "true") return true
    if (text === "false") return false
  }
  return undefined
}

/**
 * A tool list as another tool writes it: a YAML list, `Read, Grep`, or the Agent Skills space-delimited form
 * (`Bash(git add:*) Read`). Separators inside parentheses stay part of the entry.
 */
export function frontmatterList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((entry) => frontmatterText(entry)).filter((entry): entry is string => entry !== undefined)
  const text = frontmatterText(value)
  if (text === undefined) return undefined
  const out: string[] = []
  let current = ""
  let depth = 0
  for (const char of text) {
    if (char === "(") depth++
    if (char === ")") depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === "," || /\s/.test(char))) {
      if (current) out.push(current)
      current = ""
    } else current += char
  }
  if (current) out.push(current)
  return out
}

/** One line for a catalog: whitespace (including block-scalar newlines) collapsed, cut with an ellipsis. */
export function oneLine(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
