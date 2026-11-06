import type { TextSection } from "./text-page"

export type RepoRow = { directory: string; state: string; role?: string; open: number; publish: string }

/** Shared text-page table, with the full selected directory and the daemon's unabridged report below. */
export function repoSections(rows: readonly RepoRow[], selected: number, text: string): TextSection[] {
  const sections: TextSection[] = []
  if (rows[selected]) sections.push({ heading: "Selected", lines: [rows[selected]!.directory, `${rows[selected]!.state} · role ${rows[selected]!.role ?? "config"} · ${rows[selected]!.open} open · publish ${rows[selected]!.publish}`] })
  for (const ended of [false, true]) {
    const group = rows.filter((row) => row.state.startsWith("ended") === ended)
    if (!group.length) continue
    sections.push({ heading: ended ? "Ended" : "Active", muted: ended, lines: [], table: [
      ["Directory", "State", "Role", "Open", "Publish"],
      ...group.map((row) => [`${rows[selected] === row ? "> " : "  "}${row.directory}`, row.state.startsWith("ended") ? "ended" : row.state, row.role ?? "config", String(row.open), row.publish]),
    ] })
  }
  sections.push({ heading: "Report", lines: text.split("\n") })
  return sections
}
