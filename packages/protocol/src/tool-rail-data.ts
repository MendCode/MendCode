/**
 * The `toolRail` setting (docs/customize.md "Tool rail"): which tool cards hang their body from a thin vertical rule at the left.
 * Data only, so the profile can be checked without loading the client. A comma list of `name:on` or `name:off`; `name` is a tool's name
 * as the card shows it (`read`, `shell`, an MCP tool's `mcp__server__tool`), a prefix ending in `*` (`mcp__*`) or `*` for every tool. The
 * last entry that matches a tool wins; a tool no entry names keeps the rule.
 */

export const TOOL_RAIL_DEFAULT = "read:off,write:off,edit:off,apply_patch:off,notebook_edit:off"
export const TOOL_RAIL_MAX_ENTRIES = 64

export type ToolRailEntry = { pattern: string; on: boolean }

const ENTRY = /^([A-Za-z0-9_.\-]+\*?|\*):(on|off)$/

/** The entries of a `toolRail` text, in order; text that is not an entry is dropped. */
export function parseToolRail(text: string): ToolRailEntry[] {
  return text.split(",").flatMap((part): ToolRailEntry[] => {
    const match = ENTRY.exec(part.trim())
    return match ? [{ pattern: match[1]!, on: match[2] === "on" }] : []
  })
}

/** One-line problems of a `toolRail` value. */
export function toolRailProblems(value: unknown): string[] {
  if (typeof value !== "string") return ["toolRail: expected a comma list of name:on or name:off"]
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean)
  if (parts.length > TOOL_RAIL_MAX_ENTRIES) return [`toolRail: at most ${TOOL_RAIL_MAX_ENTRIES} entries`]
  const bad = parts.find((part) => !ENTRY.test(part))
  return bad ? [`toolRail: "${bad.slice(0, 40)}" is not name:on or name:off (a name may end in * to match a prefix)`] : []
}

/** Whether a tool's card draws the rule. */
export function toolRailShown(entries: readonly ToolRailEntry[], tool: string): boolean {
  let shown = true
  for (const entry of entries) {
    const matches = entry.pattern === "*" || (entry.pattern.endsWith("*") ? tool.startsWith(entry.pattern.slice(0, -1)) : entry.pattern === tool)
    if (matches) shown = entry.on
  }
  return shown
}
