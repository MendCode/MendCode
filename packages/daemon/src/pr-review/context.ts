import { estimateTokens } from "@mendcode/protocol"
import { parseDiffRows } from "@mendcode/protocol/wire"
import { loc, traverseCalls, type Graph, type GraphNode } from "@mendcode/codegraph"
import type { PullRequestInfo } from "./pull-request"

/**
 * What a review reads (docs/pr-review.md): the diff of `base...head` and, for every symbol a hunk touches, its callers and callees
 * from the code graph (depth 2, at most 12 each). The graph shows the blast radius a diff hides without a vector index to keep
 * fresh. One call's context stays inside half the call's token bound: a diff larger than that is split into parts of whole files
 * (`parts`, one review call each); within a call, callers and callees are cut first, then the largest files' diffs, and
 * `truncated` says so. The repository itself is never loaded into the prompt; the review child reads files with its own
 * read-only tools.
 */

export type GitRun = (args: string[], cwd: string) => Promise<{ code: number; out: string }>

/** `git` without a shell; output bounded by the caller's process helper. */
export const gitRun: GitRun = async (args, cwd) => {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } })
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      const out = await new Response(child.stdout).text()
      return { code: await child.exited, out }
    } finally { clearTimeout(timer) }
  } catch { return { code: 127, out: "" } }
}

export const CALLER_CAP = 12
export const GRAPH_DEPTH = 2
/** The share of the PR's token budget the context may take; the rest is for the review answer and the verify pass. */
export const CONTEXT_SHARE = 0.5
const MAX_SYMBOLS = 40
const MAX_DIFF_BYTES = 4 * 1024 * 1024

export type FileDiff = {
  path: string
  /** This file's part of the unified diff, from its `diff --git` line. */
  text: string
  /** New-side lines inside the hunks (added and context): the lines GitHub accepts a RIGHT comment on. */
  right: Set<number>
  /** New-side lines the change touched: added lines and where lines were deleted. */
  touched: number[]
  deleted: boolean
}

export type ChangedSymbol = { symbol: string; path: string; line: number; callers: string[]; callees: string[] }

export type ReviewContext = {
  directory: string
  base: string
  head: string
  /** The diff the prompt carries: whole files, or a one-line note for a file cut by the budget. */
  diff: string
  files: FileDiff[]
  changedSymbols: ChangedSymbol[]
  truncated: boolean
  /** Facts for the summary: no code graph, what the budget cut. */
  notes: string[]
  /** The title, description and linked issues the pre-merge checks read; absent when the caller could not read them. */
  pullRequest?: PullRequestInfo
  /** Estimated tokens of `diff` plus the symbol lines. */
  tokens: number
  /**
   * Set only when the whole diff does not fit one call (`budgetTokens * CONTEXT_SHARE`): the diff in parts of whole files, each
   * within that bound, reviewed one call per part (engine.ts). `diff` is then the single-call view with the largest files cut.
   */
  parts?: ReviewPart[] | undefined
}

/** One review call's share of a large diff: whole files (a file larger than a call by itself is a one-line note) and their symbols. */
export type ReviewPart = { files: string[]; diff: string; symbols: ChangedSymbol[]; tokens: number }

/** The most parts one review makes; past it the remaining files' diffs are left out of the last part (the child reads them itself). */
export const MAX_REVIEW_PARTS = 12

/** Splits `git diff` output by file and reads each file's RIGHT-side lines. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = []
  const parts = diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "))
  for (const text of parts) {
    const lines = text.replace(/\n$/, "").split("\n")
    const plus = lines.find((line) => line.startsWith("+++ "))
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]!)
    const target = plus && plus !== "+++ /dev/null" ? plus.slice(4).replace(/^b\//, "") : header?.[2]
    if (!target) continue
    const deleted = plus === "+++ /dev/null"
    const right = new Set<number>()
    const touched: number[] = []
    const first = lines.findIndex((line) => line.startsWith("@@"))
    const rows = first < 0 ? [] : parseDiffRows(lines.slice(first))
    let lastNew = 0
    for (const row of rows) {
      if (row.new !== undefined) { lastNew = row.new; if (!deleted) right.add(row.new) }
      if (row.kind === "add" && row.new !== undefined) touched.push(row.new)
      if (row.kind === "del" && !deleted) touched.push(lastNew + 1)
    }
    files.push({ path: target, text, right, touched: [...new Set(touched)].sort((a, b) => a - b), deleted })
  }
  return files
}

/** The innermost graph symbols that hold a touched line of `file`, each once. */
function touchedNodes(graph: Graph, file: FileDiff): GraphNode[] {
  const nodes = (graph.byPath.get(file.path) ?? []).filter((node) => node.start > 0 && node.end >= node.start)
  const found = new Map<string, GraphNode>()
  for (const line of file.touched) {
    const holding = nodes.filter((node) => node.start <= line && line <= node.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))
    if (holding[0]) found.set(holding[0].id, holding[0])
  }
  return [...found.values()]
}

const symbolLine = (symbol: ChangedSymbol) => `${symbol.symbol} (${symbol.path}:${symbol.line})${symbol.callers.length ? `\n  callers: ${symbol.callers.join(", ")}` : ""}${symbol.callees.length ? `\n  callees: ${symbol.callees.join(", ")}` : ""}`
export const symbolsText = (symbols: readonly ChangedSymbol[]) => symbols.map(symbolLine).join("\n")
const tokensOf = (diff: string, symbols: readonly ChangedSymbol[]) => estimateTokens(diff.length) + estimateTokens(symbolsText(symbols).length)
const leftOut = (file: FileDiff, why: string) => `diff --git a/${file.path} b/${file.path}\n(diff of ${file.text.split("\n").length} lines left out by ${why}; read the file yourself)\n`
const keepCalls = (symbols: readonly ChangedSymbol[], keep: number) => symbols.map((symbol) => ({ ...symbol, callers: symbol.callers.slice(0, keep), callees: symbol.callees.slice(0, keep) }))

/**
 * A diff too large for one call, in parts of whole files in diff order (related paths stay together), each within `limit` tokens
 * with its files' symbols. A file's callers and callees are cut (to 3, then none) before its diff; a file that still does not fit
 * a call alone is a one-line note in its part (`cut`). At most `MAX_REVIEW_PARTS`: the files past the last one are notes in it.
 */
export function splitIntoParts({ files, symbols, limit }: { files: readonly FileDiff[]; symbols: readonly ChangedSymbol[]; limit: number }): { parts: ReviewPart[]; cut: string[] } {
  const parts: ReviewPart[] = []
  const cut: string[] = []
  let texts: string[] = []
  let paths: string[] = []
  let held: ChangedSymbol[] = []
  let used = 0
  const flush = () => {
    if (!paths.length) return
    const diff = texts.join("")
    parts.push({ files: paths, diff, symbols: held, tokens: tokensOf(diff, held) })
    texts = []; paths = []; held = []; used = 0
  }
  for (const file of files) {
    let own = symbols.filter((symbol) => symbol.path === file.path)
    let text = file.text
    for (const keep of [3, 0]) if (tokensOf(text, own) > limit) own = keepCalls(own, keep)
    const last = parts.length >= MAX_REVIEW_PARTS - 1
    if (tokensOf(text, own) > limit || (last && paths.length && used + tokensOf(text, own) > limit)) {
      text = leftOut(file, last && tokensOf(text, own) <= limit ? `the review's limit of ${MAX_REVIEW_PARTS} parts` : "the token budget (larger than one review call)")
      cut.push(file.path)
    }
    const cost = tokensOf(text, own)
    if (paths.length && used + cost > limit && !last) flush()
    texts.push(text); paths.push(file.path); held.push(...own); used += cost
  }
  flush()
  return { parts, cut }
}

/**
 * The diff of `base...head` in `directory` and the graph context of what it touches, within `budgetTokens * CONTEXT_SHARE`.
 * `ignore` drops paths the repository config excludes. Without a graph the review proceeds on the diff alone and the notes say so.
 */
export async function buildReviewContext({ directory, base, head, budgetTokens, graph, git = gitRun, ignore = () => false }: { directory: string; base: string; head: string; budgetTokens: number; graph?: Graph | undefined; git?: GitRun; ignore?: (path: string) => boolean }): Promise<ReviewContext> {
  for (const ref of [base, head]) if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(ref) || ref.includes("..")) throw new Error(`[PR_REVIEW]: invalid ref ${JSON.stringify(ref.slice(0, 80))}`)
  const result = await git(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", `${base}...${head}`, "--"], directory)
  if (result.code !== 0) throw new Error(`[PR_REVIEW]: git diff ${base}...${head} failed in ${directory}`)
  if (result.out.length > MAX_DIFF_BYTES) throw new Error(`[PR_REVIEW]: the diff is larger than ${MAX_DIFF_BYTES / 1024 / 1024} MiB`)
  const files = parseUnifiedDiff(result.out).filter((file) => !ignore(file.path))
  const notes: string[] = []
  let symbols: ChangedSymbol[] = []
  if (!graph) notes.push("No code graph index: reviewed from the diff alone.")
  else {
    const describe = (node: GraphNode) => `${node.label} (${loc(node)})`
    for (const file of files) for (const node of touchedNodes(graph, file)) {
      if (symbols.length >= MAX_SYMBOLS) break
      const callers = traverseCalls({ graph, start: node, direction: "in", depth: GRAPH_DEPTH, cap: CALLER_CAP })
      const callees = traverseCalls({ graph, start: node, direction: "out", depth: GRAPH_DEPTH, cap: CALLER_CAP })
      symbols.push({ symbol: node.label, path: node.path, line: node.start, callers: [...callers.rows.map((row) => describe(row.node)), ...(callers.more ? [`${callers.more} more`] : [])], callees: [...callees.rows.map((row) => describe(row.node)), ...(callees.more ? [`${callees.more} more`] : [])] })
    }
  }
  const limit = Math.max(1_000, Math.floor(budgetTokens * CONTEXT_SHARE))
  const whole = tokensOf(files.map((file) => file.text).join(""), symbols)
  const single = singleView({ files, symbols, limit })
  // Callers and callees are cut first; a diff that still does not fit one call is reviewed in parts of whole files rather than
  // with the largest diffs left out.
  const split = single.cut.length && files.length > 1 ? splitIntoParts({ files, symbols, limit }) : undefined
  const parts = split && split.parts.length > 1 ? split.parts : undefined
  if (!parts) {
    notes.push(...single.notes)
    return { directory, base, head, diff: single.diff, files, changedSymbols: single.symbols, truncated: single.truncated, notes, tokens: tokensOf(single.diff, single.symbols) }
  }
  const cut = split!.cut
  notes.push(`The diff (about ${whole.toLocaleString("en-US")} tokens) is larger than one review call (${limit.toLocaleString("en-US")}), so it was reviewed in ${parts.length} parts of whole files.`)
  if (cut.length) notes.push(`The diffs of ${cut.length} file${cut.length === 1 ? "" : "s"} did not fit a part and were left out: ${cut.slice(0, 8).join(", ")}${cut.length > 8 ? ", …" : ""}.`)
  return { directory, base, head, diff: single.diff, files, changedSymbols: single.symbols, truncated: true, notes, tokens: tokensOf(single.diff, single.symbols), parts }
}

/** The diff as one call carries it within `limit`: callers and callees cut first (they are context), then the largest files' diffs. */
function singleView({ files, symbols: all, limit }: { files: readonly FileDiff[]; symbols: ChangedSymbol[]; limit: number }): { diff: string; symbols: ChangedSymbol[]; truncated: boolean; notes: string[]; cut: string[] } {
  const notes: string[] = []
  const cut: string[] = []
  let symbols = all
  const shown = files.map((file) => ({ file, text: file.text }))
  const diffOf = () => shown.map((entry) => entry.text).join("")
  let truncated = false
  for (const keep of [3, 0]) {
    if (tokensOf(diffOf(), symbols) <= limit) break
    symbols = keepCalls(symbols, keep)
    if (!truncated) notes.push("Callers and callees were cut to fit the token budget.")
    truncated = true
  }
  if (tokensOf(diffOf(), symbols) > limit) {
    for (const entry of [...shown].sort((a, b) => b.text.length - a.text.length)) {
      if (tokensOf(diffOf(), symbols) <= limit) break
      entry.text = leftOut(entry.file, "the token budget")
      cut.push(entry.file.path)
    }
    truncated = true
    notes.push(`The token budget left out the diffs of ${cut.length} file${cut.length === 1 ? "" : "s"}: ${cut.slice(0, 8).join(", ")}${cut.length > 8 ? ", …" : ""}.`)
  }
  return { diff: diffOf(), symbols, truncated, notes, cut }
}
