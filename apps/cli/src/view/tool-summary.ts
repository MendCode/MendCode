/**
 * What a finished reading tool says about itself in one line (`Read README.md · 142 lines`) and how a run of them folds
 * (`Read 5 files · List 2 · Grep 3`). Pure: the tool's text and the numbers it reported in, strings out. Display only; the
 * model still received the whole result.
 */

/** Tools that only look: their finished calls are one line in `balanced` and fold into one row when three or more follow each other. */
export const READ_TOOLS = ["read", "ls", "glob", "grep"] as const
export type ReadTool = (typeof READ_TOOLS)[number]

export const isReadTool = (name: string): name is ReadTool => (READ_TOOLS as readonly string[]).includes(name)

/** What a tool reported when it completed (`item.completed.meta`); any key may be missing (replayed or foreign engines). */
export type ToolCounts = { lines?: number; entries?: number; matches?: number }

export const countsOf = (meta: Readonly<Record<string, unknown>> | undefined): ToolCounts => {
  const pick = (key: string) => (typeof meta?.[key] === "number" ? (meta[key] as number) : undefined)
  const lines = pick("lines")
  const entries = pick("entries")
  const matches = pick("matches")
  return { ...(lines !== undefined ? { lines } : {}), ...(entries !== undefined ? { entries } : {}), ...(matches !== undefined ? { matches } : {}) }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

/** A truncation note a tool appends (`[output truncated: 12 more entries]`), which is not content. */
const NOTE = /^\[output (?:truncated|capped)/

const contentLines = (text: string) => text.split("\n").filter((line) => line.trim().length > 0 && !NOTE.test(line))

/** `(40 of 120 entries; use offset=41 …)` at the end of a directory read. */
const ENTRIES = /\((\d+) of (\d+) entries/

function readSummary(text: string, counts: ToolCounts) {
  if (/^(Image|PDF) read successfully/.test(text)) return text.startsWith("PDF") ? "pdf" : "image"
  const entries = ENTRIES.exec(text)
  if (counts.entries !== undefined || entries) return plural(counts.entries ?? Number(entries![1]), "entry", "entries")
  const numbered = text.split("\n").filter((line) => /^\s*\d+\t/.test(line)).length
  const count = counts.lines ?? (numbered || contentLines(text).length)
  const more = /\[output (?:truncated|capped)/.test(text) ? "+" : ""
  return `${count.toLocaleString("en-US")}${more} ${count === 1 && !more ? "line" : "lines"}`
}

function listSummary(text: string, counts: ToolCounts) {
  if (text.trim() === "(empty)") return "empty"
  const hidden = /\[output truncated: ([\d,]+) more entries\]/.exec(text)
  const shown = counts.entries ?? contentLines(text).length
  return plural(shown + (hidden ? Number(hidden[1]!.replace(/,/g, "")) : 0), "entry", "entries")
}

function globSummary(text: string, counts: ToolCounts) {
  if (/^No files found/.test(text.trim())) return "no files"
  const hidden = /\[output truncated: ([\d,]+) more files\]/.exec(text)
  const shown = counts.matches ?? contentLines(text).length
  return plural(shown + (hidden ? Number(hidden[1]!.replace(/,/g, "")) : 0), "file")
}

/** `path:12:text` rows of grep: how many matches and in how many files. */
function grepSummary(text: string, counts: ToolCounts) {
  if (/^No matches found/.test(text.trim())) return "no matches"
  const files = new Set<string>()
  let matches = 0
  for (const line of text.split("\n")) {
    const hit = /^(.+?):\d+:/.exec(line)
    if (!hit) continue
    matches++
    files.add(hit[1]!)
  }
  if (!matches) return plural(counts.matches ?? contentLines(text).length, "line")
  const more = /\[output truncated: more than/.test(text) ? "+" : ""
  return `${matches.toLocaleString("en-US")}${more} ${matches === 1 && !more ? "match" : "matches"} in ${plural(files.size, "file")}`
}

/** The one-line result of a finished reading tool call; empty when it has nothing to say. */
export function readResult({ name, text, counts }: { name: ReadTool; text: string; counts: ToolCounts }): string {
  const body = text.replace(/\s+$/, "")
  if (!body) return ""
  switch (name) {
    case "read":
      return readSummary(body, counts)
    case "ls":
      return listSummary(body, counts)
    case "glob":
      return globSummary(body, counts)
    case "grep":
      return grepSummary(body, counts)
  }
}

/** What follows the label: the pattern in quotes for grep, the pattern for glob, `.` for a list of the project root. */
export function readDetail({ name, detail, pattern }: { name: ReadTool; detail: string; pattern: string | undefined }): string {
  if (name === "grep") return pattern ? `"${pattern}"` : detail
  if (name === "glob") return pattern ?? detail
  if (name === "ls") return detail || "."
  return detail
}

/**
 * `Read 5 files · List 2 · Grep 3`: the calls of a folded run, in the order the tools are listed above. `spelled` (the full view's
 * `calm` density) says what each count counts: `Read 5 files · List 2 folders · Grep 3 patterns`.
 */
export function foldLabel(names: readonly string[], spelled = false): string {
  const count = (tool: ReadTool) => names.filter((name) => name === tool).length
  const parts = [
    ...(count("read") ? [`Read ${plural(count("read"), "file")}`] : []),
    ...(count("ls") ? [spelled ? `List ${plural(count("ls"), "folder")}` : `List ${count("ls")}`] : []),
    ...(count("glob") ? [spelled ? `Glob ${plural(count("glob"), "pattern")}` : `Glob ${count("glob")}`] : []),
    ...(count("grep") ? [spelled ? `Grep ${plural(count("grep"), "pattern")}` : `Grep ${count("grep")}`] : []),
  ]
  return parts.join(" · ")
}
