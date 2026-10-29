/**
 * The one precedence report: for every surface of MendCode that layers can fill (skills, commands, agents, tools, hooks, MCP servers,
 * themes, view slots, panel widgets, keybindings, workflows, recipes, contracts, prompt files, profile keys), which layer's entry is
 * the effective one and which entries it overrides. The daemon builds claims from the files of every layer, the terminal from what
 * is registered in it; both resolve them here, so `/packages`, `/doctor` and the tests read one answer.
 *
 * Data and pure functions only (no zod), shared with the thin client. Rules this encodes, one per surface, are the loaders' own:
 * a later layer replaces an earlier one of the same name; hooks from every layer run together; the last layer's prompt file wins
 * as a whole. Precedence itself is owned by the loaders, not by this module: a test compares every file-derived surface with them.
 */

export const PRECEDENCE_SURFACES = ["profile", "skills", "commands", "agents", "tools", "hooks", "mcp", "themes", "views", "widgets", "keybindings", "workflows", "recipes", "contracts", "promptFiles", "pages"] as const
export type PrecedenceSurface = (typeof PRECEDENCE_SURFACES)[number]

/** `override`: one entry per name is effective. `merge`: every entry is effective (hooks from all layers run). */
export const PRECEDENCE_MODE: Readonly<Record<PrecedenceSurface, "override" | "merge">> = {
  profile: "override", skills: "override", commands: "override", agents: "override", tools: "override", hooks: "merge", mcp: "override", themes: "override",
  views: "override", widgets: "override", keybindings: "override", workflows: "override", recipes: "override", contracts: "override", promptFiles: "override", pages: "override",
}

export const PRECEDENCE_LABELS: Readonly<Record<PrecedenceSurface, string>> = {
  profile: "Profile keys", skills: "Skills", commands: "Slash commands", agents: "Agents", tools: "Custom tools", hooks: "Shell hooks", mcp: "MCP servers", themes: "Themes",
  views: "View slots", widgets: "Panel widgets", keybindings: "Keybindings", workflows: "Workflows", recipes: "Recipes", contracts: "Contracts", promptFiles: "Prompt files", pages: "Pages",
}

/** One layer's entry for one name. `rank` orders layers, lowest precedence first; `layer` is how it is shown ("user", "package user:retro", "project"). */
export type PrecedenceClaim = { surface: PrecedenceSurface; name: string; layer: string; rank: number; note?: string; /** Present but not applied (a project's code without project trust): never effective, never overrides. */ inactive?: boolean }
export type PrecedenceEntry = { layer: string; note?: string }
export type PrecedenceRow = { surface: PrecedenceSurface; name: string; effective: PrecedenceEntry[]; overridden: PrecedenceEntry[]; inactive: PrecedenceEntry[] }

const entry = (claim: PrecedenceClaim): PrecedenceEntry => ({ layer: claim.layer, ...(claim.note ? { note: claim.note } : {}) })

/** Groups claims by surface and name. The highest rank is effective (every one, for a `merge` surface); the rest are overridden. Rows come out in surface order, then name. */
export function resolvePrecedence(claims: readonly PrecedenceClaim[]): PrecedenceRow[] {
  const groups = new Map<string, PrecedenceClaim[]>()
  for (const claim of claims) {
    const key = `${claim.surface}\u0000${claim.name}`
    const list = groups.get(key)
    if (list) list.push(claim)
    else groups.set(key, [claim])
  }
  const rows: PrecedenceRow[] = []
  for (const list of groups.values()) {
    const ordered = list.filter((claim) => !claim.inactive).sort((a, b) => a.rank - b.rank)
    const inactive = list.filter((claim) => claim.inactive).sort((a, b) => b.rank - a.rank).map(entry)
    const first = list[0]!
    if (ordered.length === 0) rows.push({ surface: first.surface, name: first.name, effective: [], overridden: [], inactive })
    else if (PRECEDENCE_MODE[first.surface] === "merge") rows.push({ surface: first.surface, name: first.name, effective: ordered.map(entry), overridden: [], inactive })
    else rows.push({ surface: first.surface, name: first.name, effective: [entry(ordered.at(-1)!)], overridden: ordered.slice(0, -1).reverse().map(entry), inactive })
  }
  const order = new Map(PRECEDENCE_SURFACES.map((surface, index) => [surface, index]))
  return rows.sort((a, b) => order.get(a.surface)! - order.get(b.surface)! || a.name.localeCompare(b.name))
}

/** The rows where a choice was made: something is overridden, or something is waiting for trust. */
export const conflictRows = (rows: readonly PrecedenceRow[]): PrecedenceRow[] => rows.filter((row) => row.overridden.length > 0 || row.inactive.length > 0)

const where = (item: PrecedenceEntry) => `${item.layer}${item.note ? ` (${item.note})` : ""}`

/** Short lines for a text page: `name: effective, overrides a, b`. With `onlyConflicts`, only the rows where something is overridden. */
export function describePrecedence(rows: readonly PrecedenceRow[], options: { onlyConflicts?: boolean } = {}): Array<{ surface: PrecedenceSurface; heading: string; lines: string[] }> {
  const out: Array<{ surface: PrecedenceSurface; heading: string; lines: string[] }> = []
  for (const surface of PRECEDENCE_SURFACES) {
    const own = rows.filter((row) => row.surface === surface && (!options.onlyConflicts || row.overridden.length > 0 || row.inactive.length > 0))
    if (!own.length) continue
    out.push({
      surface,
      heading: PRECEDENCE_LABELS[surface],
      lines: own.map((row) => `- ${row.name}: ${row.effective.length ? row.effective.map(where).join(" + ") : "nothing applies"}${row.overridden.length ? ` · overrides ${row.overridden.map(where).join(", ")}` : ""}${row.inactive.length ? ` · not applied: ${row.inactive.map(where).join(", ")}` : ""}`),
    })
  }
  return out
}

/** What the daemon returns for `system.query precedence`: the file-derived claims, resolved; the terminal adds its own and resolves again. */
export type PrecedenceFacts = { claims: PrecedenceClaim[]; layers: string[]; truncated: boolean }
