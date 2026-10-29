import { estimateTokens } from "@mendcode/protocol/wire"
import { ansi } from "./ansi"
import { git } from "./git"
import { repeats } from "./repeats"
import { search } from "./search"
import { tests } from "./tests"
import { tsc } from "./tsc"
import type { FilterInput, OutputFilter } from "./types"

/** The filters in the order they run: colour first, then the command-specific ones, then repeats. Adding one is adding a file here. */
export const OUTPUT_FILTERS: readonly OutputFilter[] = [ansi, tests, git, tsc, search, repeats]
/** Tools whose output is a command's text; everything else (read, grep, edit…) is already shaped by its tool. */
const COMMAND_TOOLS = new Set(["shell", "shell_output"])
/** A filter pays for its one-line header only when it removes at least this many estimated tokens. */
const MIN_SAVED_TOKENS = 60

export type FilteredOutput = { output: string; filter: string; savedTokens: number; before: number; after: number }

/**
 * Runs the filters over a command result. Undefined when nothing applies or the saving would not cover the header the engine adds
 * (`headerChars`). The caller keeps the original text on disk first: a filter result is never the only copy.
 */
export function filterToolOutput(input: FilterInput & { output: string; headerChars?: number }): FilteredOutput | undefined {
  if (!COMMAND_TOOLS.has(input.tool) || input.output.length < 400) return undefined
  let text = input.output
  let best: { id: string; saved: number } | undefined
  for (const filter of OUTPUT_FILTERS) {
    if (!filter.matches(input)) continue
    const next = filter.apply(text)
    const saved = text.length - next.length
    if (saved > 0 && (!best || saved > best.saved)) best = { id: filter.id, saved }
    text = next
  }
  const savedTokens = estimateTokens(input.output.length - text.length - (input.headerChars ?? 0))
  if (!best || savedTokens < MIN_SAVED_TOKENS) return undefined
  return { output: text, filter: best.id, savedTokens, before: input.output.split("\n").length, after: text.split("\n").length }
}

export type { FilterInput, OutputFilter }
