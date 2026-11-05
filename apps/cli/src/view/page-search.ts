import type { Line } from "../ui/theme"
import { truncateEnd } from "./wrap"

/**
 * The `/` filter of a page, shared so every page searches the same way: `/` opens it, typed keys edit the query, Backspace deletes,
 * Esc closes it (the query cleared), Enter keeps the query and closes the box. A page holds a `PageSearch`, passes keys to
 * `pageSearchKey` first, filters its own items with `searchMatches`, and draws `pageSearchRow` where its box goes.
 */
export type PageSearch = { open: boolean; query: string }
export type PageSearchResult = { search: PageSearch; event: "none" | "changed" | "closed" | "submitted" }

export const closedSearch = (): PageSearch => ({ open: false, query: "" })

/** Undefined when the key is not the search's (the page handles it); otherwise the next search and what happened. */
export function pageSearchKey(search: PageSearch | undefined, key: string): PageSearchResult | undefined {
  if (!search?.open) return key === "/" ? { search: { open: true, query: "" }, event: "changed" } : undefined
  if (key === "\x1b") return { search: closedSearch(), event: "closed" }
  if (key === "\r") return { search: { open: false, query: search.query }, event: "submitted" }
  if (key === "\x7f" || key === "\b") return { search: { ...search, query: search.query.slice(0, -1) }, event: "changed" }
  if (/^[^\x00-\x1f\x7f-\x9f]+$/u.test(key)) return { search: { ...search, query: (search.query + key).slice(0, 80) }, event: "changed" }
  // Arrows and the other keys move in the filtered list while the box is open.
  return undefined
}

/** Whether every word of `query` is in one of `fields` (any case); an empty query matches everything. */
export function searchMatches(query: string, fields: readonly string[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = fields.join(" ").toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * The box row: `/ query_` with the match count, or the kept query once the box is closed; nothing without a query. It fits `width`:
 * the count goes before the query is cut. The keys belong in the page's own hint row.
 */
export function pageSearchRow(search: PageSearch | undefined, matches: number, width: number): Line | undefined {
  if (!search || (!search.open && !search.query)) return undefined
  const query = `${search.query}${search.open ? "_" : ""}`
  const count = `  ${matches} match${matches === 1 ? "" : "es"}`
  const room = Math.max(1, width - 2)
  const shown = query.length + count.length <= room ? count : ""
  return [{ text: "/ ", fg: "primary" }, { text: truncateEnd(query, room - shown.length), fg: "text" }, ...(shown ? [{ text: shown, fg: "muted" as const }] : [])]
}
