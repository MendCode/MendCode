import type { Line } from "../ui/theme"
import { textWidth } from "./wrap"

/** What an entry of the recall list is: a sent message, a slash command, a shell line, or text left unsent in the prompt. */
export type RecallKind = "sent" | "command" | "shell" | "draft"
/** One entry of the project's recall list (↑/↓ and the search bar); `id` is the daemon's, for deleting it. */
export type RecallEntry = { text: string; kind: RecallKind; id?: number }

/** Text this long, or on several lines, is worth keeping as a draft when the prompt is cleared. */
export const DRAFT_MIN_CHARS = 12
export const worthKeeping = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed.length >= DRAFT_MIN_CHARS || trimmed.includes("\n")
}

/**
 * Reverse search over the project's earlier prompts (alt+r, `/prompt-history`). `matches` indexes `prompts` (newest first);
 * `at` is the shown one; `kinds` and `ids` (same order) say what each entry is and how to delete it. `draft` is what the
 * prompt held before the search (and whether it was in shell mode), put back by Esc. `confirm` is set after a first ctrl+d on the shown entry.
 */
export type PromptSearchState = { query: string; prompts: readonly string[]; matches: number[]; at: number; draft: string; kinds?: readonly RecallKind[]; ids?: readonly (number | undefined)[]; confirm?: boolean; shell?: boolean }

export const PROMPT_SEARCH_MAX_QUERY = 200
/** Prompts searched: the newest of the daemon's list. */
export const PROMPT_SEARCH_PROMPTS = 500

/** Indices of the prompts holding `query`, newest first and without repeats: case-insensitive unless the query has a capital; an empty query lists them all. */
export function searchPrompts(prompts: readonly string[], query: string): number[] {
  const exact = /[A-Z]/.test(query)
  const needle = exact ? query : query.toLowerCase()
  const seen = new Set<string>()
  const out: number[] = []
  prompts.forEach((prompt, index) => {
    if (seen.has(prompt)) return
    if (needle && !(exact ? prompt : prompt.toLowerCase()).includes(needle)) return
    seen.add(prompt)
    out.push(index)
  })
  return out
}

const NARROW = 70

/** The search bar: label and query on the left, the shown entry's kind, the hit count and the key hints on the right. */
export function promptSearchBar(input: { state: PromptSearchState; width: number; margin: number }): { row: Line; cursor: number } {
  const { state, width, margin } = input
  const room = Math.max(1, width - margin * 2)
  const label = "search "
  const shown = state.matches[state.at]
  const kind = shown === undefined ? undefined : state.kinds?.[shown]
  const count = state.matches.length ? `${state.at + 1}/${state.matches.length}` : state.query ? "no matches" : "no earlier prompts"
  const hints = width >= NARROW ? "↑ older · ↓ newer · enter use · ctrl+d delete · esc cancel" : ""
  const fits = (parts: string[]) => label.length + textWidth(state.query) + 2 + textWidth(parts.join("  ")) <= room
  const withKind = kind ? [kind, count] : [count]
  // After a first ctrl+d the question replaces the hints, however narrow the frame.
  const right = state.confirm ? [["ctrl+d again to delete", count], ["ctrl+d again", count], [count]].find(fits) ?? [count] : [[...withKind, hints].filter(Boolean), withKind].find(fits) ?? [count]
  const rightWidth = textWidth(right.join("  "))
  let query = state.query
  while (query && textWidth(query) > Math.max(1, room - label.length - rightWidth - 2)) query = query.slice(1)
  const gap = Math.max(1, room - label.length - textWidth(query) - rightWidth)
  const spans: Line = [
    { text: " ".repeat(margin) },
    { text: label, fg: "heading" },
    { text: query, fg: "text" },
    { text: " ".repeat(gap) },
    ...right.flatMap((part, at): Line => [...(at ? [{ text: "  " }] : []), { text: part, fg: part === "no matches" || part.startsWith("ctrl+d again") ? "warning" : part === count ? "heading" : "muted" }]),
  ]
  return { row: spans, cursor: margin + label.length + textWidth(query) }
}
