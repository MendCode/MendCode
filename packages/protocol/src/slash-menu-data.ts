/** Data-only contract shared by the terminal profile and extension renderers. */
export const SLASH_LAYOUTS = ["tabs", "groups", "columns", "flat"] as const
export type SlashLayout = (typeof SLASH_LAYOUTS)[number]
export const SLASH_GROUPS = ["recent", "session", "context", "code", "agents", "setup", "look", "more"] as const
export type SlashGroupId = (typeof SLASH_GROUPS)[number]
export type SlashGroup = { id: SlashGroupId; label: string }
/** `aliases` are the user's own extra names for the command (`/d` for `/changes`): lowercase words, at most `SLASH_ALIASES_PER_COMMAND` each. */
export type SlashPreference = { name: string; group?: SlashGroupId; hidden?: boolean; pinned?: boolean; order?: number; aliases?: string[] }
export const SLASH_ALIASES_PER_COMMAND = 8

const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === "object" && !Array.isArray(raw)
const name = (raw: unknown) => typeof raw === "string" && /^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(raw)
const aliasWord = (raw: unknown) => typeof raw === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(raw)
export function slashProfileProblems(key: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > (key === "slashGroups" ? 8 : 512)) return [`${key}: invalid list`]
  const seen = new Set<string>()
  const names = new Set(key === "slashGroups" ? [] : raw.flatMap((entry) => object(entry) && typeof entry.name === "string" ? [entry.name] : []))
  const aliases = new Set<string>()
  for (const entry of raw) {
    if (!object(entry)) return [`${key}: invalid entry`]
    const id = key === "slashGroups" ? entry.id : entry.name
    if (typeof id !== "string" || seen.has(id)) return [`${key}: duplicate or invalid name`]
    seen.add(id)
    if (key === "slashCommands" && entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases) || entry.aliases.length > SLASH_ALIASES_PER_COMMAND || entry.aliases.some((alias) => !aliasWord(alias))) return [`slashCommands: aliases of ${id} are up to ${SLASH_ALIASES_PER_COMMAND} lowercase words (letters, digits, - and _)`]
      for (const alias of entry.aliases as string[]) {
        // An alias that is a command's own name, or that two commands share, would chain or collide: refused where the name is read, not at run time.
        if (names.has(alias) || aliases.has(alias)) return [`slashCommands: alias ${alias} is used twice or is also a command name`]
        aliases.add(alias)
      }
    }
    if (key === "slashGroups") {
      if (!SLASH_GROUPS.includes(id as SlashGroupId) || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 24 || /[\x00-\x1f\x7f-\x9f]/.test(entry.label) || Object.keys(entry).some((key) => !["id", "label"].includes(key))) return ["slashGroups: invalid group"]
    } else if (!name(id) || entry.group !== undefined && (!SLASH_GROUPS.includes(entry.group as SlashGroupId) || entry.group === "recent") || ["hidden", "pinned"].some((key) => entry[key] !== undefined && typeof entry[key] !== "boolean") || entry.order !== undefined && (!Number.isInteger(entry.order) || Number(entry.order) < 0 || Number(entry.order) > 10000) || Object.keys(entry).some((key) => !["name", "group", "hidden", "pinned", "order", "aliases"].includes(key))) return ["slashCommands: invalid preference"]
  }
  return []
}
