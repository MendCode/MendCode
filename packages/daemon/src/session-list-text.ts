import { homedir } from "node:os"
import { redactSecrets } from "@mendcode/protocol"

/** Longest title a list line shows; `read` or `stats` give the rest. */
export const LIST_TITLE_CHARS = 50
/** Shortest end of an id a list prints, and the shortest one the tools accept as a reference. */
export const MIN_SHORT_ID = 8

/** The shortest end of `id` (at least `min` characters) that no other id of `universe` also ends with; the whole id when none is short enough. */
export function shortSuffix(id: string, universe: readonly string[], min = MIN_SHORT_ID): string {
  if (id.length <= min) return id
  const lower = id.toLowerCase()
  const others = universe.filter((other) => other !== id).map((other) => other.toLowerCase())
  for (let length = min; length < id.length; length++) {
    const suffix = lower.slice(-length)
    if (!others.some((other) => other.endsWith(suffix))) return id.slice(-length)
  }
  return id
}

/** The one session `ref` names as the end of its id, or `ref` itself when it matches none, several, or is too short to be a short id. */
export function expandSuffix(ref: string, universe: readonly string[], min = MIN_SHORT_ID): string {
  if (ref.length < min || universe.includes(ref)) return ref
  const needle = ref.toLowerCase()
  const hits = universe.filter((id) => id.toLowerCase().endsWith(needle))
  return hits.length === 1 ? hits[0]! : ref
}

/** `3m`, `4h`, `2d`, `1y`: how long ago, one unit. */
export function ageText(now: number, at: number): string {
  const minutes = Math.max(1, Math.floor((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`
}

/** The home folder as `~`, so a path costs its own part only. */
export function homeShort(folder: string): string {
  const home = homedir()
  if (folder === home) return "~"
  return home && folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder
}

export const titleText = (title: string | undefined, length = LIST_TITLE_CHARS): string => {
  const flat = redactSecrets(title ?? "").text.replace(/\s+/g, " ").trim()
  if (!flat) return "untitled"
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

export type ListRow = {
  id: string
  /** Shown only when it is not `idle`. */
  state?: string | undefined
  at: number
  /** `null`: the row has no title field at all (a chat that never had one). */
  title?: string | null | undefined
  /** Rows with a folder are grouped under it, once. */
  folder?: string | undefined
  /** A word after the title (`attached`, `readonly`). */
  note?: string | undefined
}

/**
 * Rows for a model: one header, then `id · state · age · title` per row (state only when not idle), grouped by folder with the
 * folder as a heading once and `~` for the home. Groups follow the order the rows come in (newest first).
 */
export function compactList(input: { header: string; now: number; rows: readonly ListRow[] }): string[] {
  const groups = new Map<string, ListRow[]>()
  for (const row of input.rows) groups.set(row.folder ?? "", [...(groups.get(row.folder ?? "") ?? []), row])
  const lines = [input.header]
  for (const [folder, rows] of groups) {
    if (folder) lines.push(homeShort(folder))
    for (const row of rows) {
      const fields = [row.id, ...(row.state && row.state !== "idle" ? [row.state] : []), ageText(input.now, row.at), ...(row.title === null ? [] : [titleText(row.title)]), ...(row.note ? [row.note] : [])]
      lines.push(`${folder ? "  " : ""}${fields.join(" · ")}`)
    }
  }
  return lines
}

/** The header of every session list; the state column is left out of a row whose session is idle. */
export const SESSION_HEADER = "id · [state] · age · title"

/** `peers.list` rows as the compact list; `capped` adds the line that says the maximum was returned. */
export function sessionListLines(input: { sessions: ReadonlyArray<{ sessionId: string; shortId?: string | undefined; title: string; state: string; updatedAt: number; directory?: string | undefined }>; now: number; capped?: boolean; attached?(sessionId: string): boolean }): string[] {
  const lines = compactList({
    header: SESSION_HEADER,
    now: input.now,
    rows: input.sessions.map((session) => ({ id: session.shortId ?? session.sessionId, state: session.state, at: session.updatedAt, title: session.title, folder: session.directory, note: input.attached?.(session.sessionId) ? "attached" : undefined })),
  })
  return input.capped ? [...lines, `showing ${input.sessions.length} (max)`] : lines
}
