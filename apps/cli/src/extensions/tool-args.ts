/** A tool call's arguments as renderers see them: bounded, deep-frozen and read-only. */
export type ToolArgs = Readonly<Record<string, unknown>>

/** Bounds on what a renderer is handed; the daemon already caps the JSON at 4000 characters. */
const MAX_DEPTH = 6
const MAX_ITEMS = 100
const MAX_STRING = 2000

function bounded(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? Object.freeze([]) : Object.freeze({})
  if (Array.isArray(value)) return Object.freeze(value.slice(0, MAX_ITEMS).map((item) => bounded(item, depth + 1)))
  return Object.freeze(Object.fromEntries(Object.entries(value).slice(0, MAX_ITEMS).map(([key, item]) => [key, bounded(item, depth + 1)])))
}

/**
 * The call's JSON arguments, parsed once: an object with every level frozen, strings and lists cut to their bounds.
 * Undefined when the JSON is not an object or was cut by the daemon (it no longer parses), so a renderer never sees half of it.
 */
export function toolArgs(json: string | undefined): ToolArgs | undefined {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (bounded(parsed, 0) as ToolArgs) : undefined
  } catch {
    return undefined
  }
}

/** How specific a `renderTool` name is for `tool`: exact beats any pattern, a longer `prefix*` beats a shorter one; -1 does not match. */
export function toolMatch(pattern: string, tool: string): number {
  if (pattern === tool) return Number.MAX_SAFE_INTEGER
  if (!pattern.endsWith("*")) return -1
  const prefix = pattern.slice(0, -1)
  return tool.startsWith(prefix) ? prefix.length : -1
}
