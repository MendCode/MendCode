import { estimateTokens } from "@mendcode/protocol"
import { parseDiffRows } from "@mendcode/protocol/wire"
import { loc, traverseCalls, type Graph, type GraphNode } from "@mendcode/codegraph"
import type { PullRequestInfo } from "./pull-request"
import type { ReaderSummary } from "./readers"
import { diffLines, generatedRules, triageByStat, triageFiles, type TriagedFile, type TriageReason } from "./triage"

/**
 * What a review reads (docs/pr-review.md): the diff of `base...head` and, for every symbol a hunk touches, its callers and callees
 * from the code graph (depth 2, at most 12 each). The graph shows the blast radius a diff hides without a vector index to keep
 * fresh. One call's context stays inside half the call's token bound: a diff larger than that is split into parts of whole files
 * (`parts`, one review call each); within a call, callers and callees are cut first, then the largest files' diffs, and
 * `truncated` says so. The repository itself is never loaded into the prompt; the review child reads files with its own
 * read-only tools.
 */

/** `maxBytes`: stop reading there and kill git; the result is then `cut` and `out` holds the first `maxBytes` bytes (a code of 0). */
export type GitRun = (args: string[], cwd: string, maxBytes?: number) => Promise<{ code: number; out: string; cut?: true | undefined }>

/** `git` without a shell; output bounded by `maxBytes` when the caller sets it. */
export const gitRun: GitRun = async (args, cwd, maxBytes) => {
  try {
    const child = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } })
    const timer = setTimeout(() => child.kill(), 60_000)
    try {
      if (maxBytes === undefined) {
        const out = await new Response(child.stdout).text()
        return { code: await child.exited, out }
      }
      const chunks: Uint8Array[] = []
      let size = 0
      let cut = false
      const reader = child.stdout.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.length
        if (size > maxBytes) { cut = true; child.kill(); break }
      }
      const out = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8")
      if (cut) { await child.exited.catch(() => undefined); return { code: 0, out, cut: true } }
      return { code: await child.exited, out }
    } finally { clearTimeout(timer) }
  } catch { return { code: 127, out: "" } }
}

export const CALLER_CAP = 12
export const GRAPH_DEPTH = 2
/** The share of the PR's token budget the context may take; the rest is for the review answer and the verify pass. */
export const CONTEXT_SHARE = 0.5
const MAX_SYMBOLS = 40
/** The most the reviewable part of a diff may be: data, generated and asset files are set aside first and are not counted. */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024
/** The most of one data, generated or asset file's diff that is fetched: a sample for readers (with readers off, for the budget cut). */
const SAMPLE_BYTES_READERS = 1_500_000
const SAMPLE_BYTES_PLAIN = 256 * 1024
/** Files read in one `git diff` call. */
const FETCH_CHUNK = 100

export type FileDiff = {
  path: string
  /** This file's part of the unified diff, from its `diff --git` line. */
  text: string
  /** New-side lines inside the hunks (added and context): the lines GitHub accepts a RIGHT comment on. */
  right: Set<number>
  /** New-side lines the change touched: added lines and where lines were deleted. */
  touched: number[]
  deleted: boolean
  /** The whole change's size from `git diff --numstat`, set when `text` is only a sample of a data, generated or asset file's diff. */
  size?: { added: number; removed: number } | undefined
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
  /** The cost table measured for a MendCode pull request and the rule the model applies to it (perf.ts `perfPrompt`); absent for other repositories. */
  perf?: string | undefined
  /** Estimated tokens of `diff` plus the symbol lines. */
  tokens: number
  /**
   * Set only when the whole diff does not fit one call (`budgetTokens * CONTEXT_SHARE`): the diff in parts of whole files, each
   * within that bound, reviewed one call per part (engine.ts). `diff` is then the single-call view with the largest files cut.
   */
  parts?: ReviewPart[] | undefined
  /** Set when readers summarized files instead of the review pass reading their diffs (readers.ts): how many. */
  readers?: { files: number } | undefined
  /** Estimated tokens of the diffs readers read instead of the review pass: the cap still grows with them (budget.ts `scaledBudget`). */
  readTokens?: number | undefined
}

/**
 * Reads files for the review pass (readers.ts): the data files triage chose and the code files a large diff's parts cut, each
 * summary naming the paths it covers. run.ts binds it to the reader model, the parallel count and the readers' share of the cap.
 */
export type ContextReaders = (input: { data: TriagedFile[]; cut: FileDiff[]; /** Estimated tokens of the whole diff, for the readers' share of the cap. */ diffTokens: number }) => Promise<ReaderSummary[]>

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
    const target = plus && plus !== "+++ /dev/null" ? plus.slice(4).replace(/^b\//, "").replace(/\t$/, "") : header?.[2]
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
const leftOut = (file: FileDiff, why: string, summaries?: ReadonlyMap<string, string>) => `diff --git a/${file.path} b/${file.path}\n(diff of ${file.size ? file.size.added + file.size.removed : file.text.split("\n").length} lines left out by ${why}; read the file yourself)\n${summaries?.get(file.path) ?? ""}`
/** The one-line summary line a reader's summary adds under a file's header; `undefined` when it covers other paths first. */
const summaryLine = (summary: ReaderSummary) => `Reader summary (${summary.by === "local" ? "local scan, no model" : summary.by}, unverified): ${summary.text}\n`

/**
 * What the review pass sees of each file readers read: its header and size, the summary under the first file of its group, and a
 * pointer to that file under the others. Every file stays in `files`, so a finding on one is still in the diff.
 */
export function readerTexts(files: readonly FileDiff[], summaries: readonly ReaderSummary[]): Map<string, string> {
  const texts = new Map<string, string>()
  for (const summary of summaries) {
    summary.paths.forEach((file, index) => {
      const found = files.find((entry) => entry.path === file)
      if (!found) return
      const stats = found.size ?? diffLines(found).stats
      const head = `(+${stats.added.toLocaleString("en-US")} -${stats.removed.toLocaleString("en-US")} lines, not shown${index === 0 ? ": a reader read it" : ", summarized above"})`
      texts.set(file, `diff --git a/${file} b/${file}\n${head}\n${index === 0 ? summaryLine(summary) : ""}`)
    })
  }
  return texts
}
const keepCalls = (symbols: readonly ChangedSymbol[], keep: number) => symbols.map((symbol) => ({ ...symbol, callers: symbol.callers.slice(0, keep), callees: symbol.callees.slice(0, keep) }))

/**
 * A diff too large for one call, in parts of whole files in diff order (related paths stay together), each within `limit` tokens
 * with its files' symbols. A file's callers and callees are cut (to 3, then none) before its diff; a file that still does not fit
 * a call alone is a one-line note in its part (`cut`). At most `MAX_REVIEW_PARTS`: the files past the last one are notes in it.
 */
export function splitIntoParts({ files, symbols, limit, summaries }: { files: readonly FileDiff[]; symbols: readonly ChangedSymbol[]; limit: number; summaries?: ReadonlyMap<string, string> | undefined }): { parts: ReviewPart[]; cut: string[] } {
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
      text = leftOut(file, last && tokensOf(text, own) <= limit ? `the review's limit of ${MAX_REVIEW_PARTS} parts` : "the token budget (larger than one review call)", summaries)
      cut.push(file.path)
    }
    const cost = tokensOf(text, own)
    if (paths.length && used + cost > limit && !last) flush()
    texts.push(text); paths.push(file.path); held.push(...own); used += cost
  }
  flush()
  return { parts, cut }
}

/** Characters of a file's whole diff: its text, or for a sample the text scaled up to the whole change. */
const chars = (file: FileDiff) => file.size ? Math.round(file.text.length * (file.size.added + file.size.removed) / Math.max(1, file.text.split("\n").length)) : file.text.length

type NumstatRow = { path: string; added: number; removed: number; binary: boolean }

/** `git diff --numstat -z` output (no renames), or undefined when it is not that. */
export function parseNumstat(out: string): NumstatRow[] | undefined {
  const rows: NumstatRow[] = []
  for (const record of out.split("\0")) {
    if (!record) continue
    const match = /^(\d+|-)\t(\d+|-)\t([^\n]+)$/.exec(record)
    if (!match) return undefined
    const binary = match[1] === "-"
    rows.push({ path: match[3]!, added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary })
  }
  return rows
}

const MiB = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

/**
 * The files of `base...head` with their diffs, without ever holding a data file's whole diff. `git diff --numstat` lists the files
 * and their sizes first; what triage names from that alone (a lockfile, an asset, a data format, what the base marks generated) is
 * fetched as a sample for readers, and only the rest is fetched whole, in a few calls. The safety bound (`MAX_DIFF_BYTES`) is on
 * that reviewable rest. A git that does not answer `--numstat` (a test double) falls back to the one whole diff.
 */
async function fetchDiff({ directory, base, head, git, ignore, readers, attributes }: { directory: string; base: string; head: string; git: GitRun; ignore: (path: string) => boolean; readers: boolean; attributes: string | undefined }): Promise<{ files: FileDiff[]; triage: { code: FileDiff[]; data: TriagedFile[] } }> {
  const range = `${base}...${head}`
  const failed = () => new Error(`[PR_REVIEW]: git diff ${range} failed in ${directory}`)
  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", range, "--"]
  const stat = await git(["diff", "--no-renames", "--numstat", "-z", range, "--"], directory)
  if (stat.code !== 0) throw failed()
  const rows = parseNumstat(stat.out)
  if (!rows) {
    const whole = await git(diffArgs, directory)
    if (whole.code !== 0) throw failed()
    if (whole.out.length > MAX_DIFF_BYTES) throw new Error(`[PR_REVIEW]: the diff is larger than ${MAX_DIFF_BYTES / 1024 / 1024} MiB`)
    const files = parseUnifiedDiff(whole.out).filter((file) => !ignore(file.path))
    return { files, triage: readers ? triageFiles(files, attributes) : { code: files, data: [] } }
  }
  const listed = rows.filter((row) => !ignore(row.path))
  const rules = generatedRules(attributes)
  const named = new Map<string, TriageReason>()
  for (const row of listed) { const reason = triageByStat(row, rules); if (reason) named.set(row.path, reason) }
  const sampleBytes = readers ? SAMPLE_BYTES_READERS : SAMPLE_BYTES_PLAIN
  const literal = (path: string) => `:(literal)${path}`
  const sized = new Map(listed.map((row) => [row.path, row]))
  /** One file's diff, up to `maxBytes`: a cut one ends at its last whole line and carries the whole change's size. */
  const one = async (row: NumstatRow, maxBytes: number): Promise<{ file: FileDiff | undefined; cut: boolean }> => {
    const done = await git(diffArgs.concat(literal(row.path)), directory, maxBytes)
    if (done.code !== 0) throw failed()
    const text = done.cut ? done.out.slice(0, done.out.lastIndexOf("\n") + 1) : done.out
    const file = parseUnifiedDiff(text)[0]
    if (file && done.cut) file.size = { added: row.added, removed: row.removed }
    return { file, cut: done.cut === true }
  }
  const found = new Map<string, FileDiff>()
  const oversized = new Set<string>()
  const aside = listed.filter((row) => named.has(row.path))
  for (let at = 0; at < aside.length; at += 4) {
    await Promise.all(aside.slice(at, at + 4).map(async (row) => { const { file } = await one(row, sampleBytes); if (file) found.set(row.path, file) }))
  }
  const rest = listed.filter((row) => !named.has(row.path))
  for (let at = 0; at < rest.length; at += FETCH_CHUNK) {
    const chunk = rest.slice(at, at + FETCH_CHUNK)
    const done = await git(diffArgs.concat(chunk.map((row) => literal(row.path))), directory, MAX_DIFF_BYTES + 1)
    if (done.code !== 0) throw failed()
    if (!done.cut && done.out.length <= MAX_DIFF_BYTES) { for (const file of parseUnifiedDiff(done.out)) if (sized.has(file.path)) found.set(file.path, file); continue }
    // These files together are large: each is read on its own, so the data among them is a sample and the rest counts toward the bound.
    for (const row of chunk) {
      const { file, cut } = await one(row, MAX_DIFF_BYTES + 1)
      if (!file) continue
      found.set(row.path, file)
      if (cut) oversized.add(row.path)
    }
  }
  const files = listed.flatMap((row) => found.get(row.path) ?? [])
  const withStats = (entry: TriagedFile): TriagedFile => { const row = sized.get(entry.file.path); return row && entry.file.size ? { ...entry, stats: { ...entry.stats, added: row.added, removed: row.removed } } : entry }
  const restFiles = rest.flatMap((row) => found.get(row.path) ?? [])
  const triaged = readers ? triageFiles(restFiles, attributes) : { code: restFiles, data: [] }
  const data = [
    ...aside.flatMap((row) => { const file = found.get(row.path); return file ? [withStats({ file, reason: named.get(row.path)!, stats: { ...diffLines(file).stats, added: row.added, removed: row.removed } })] : [] }),
    ...triaged.data.map(withStats),
  ].sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file))
  const reviewable = triaged.code
  const dataPaths = new Set(data.map((entry) => entry.file.path))
  const bytes = reviewable.reduce((sum, file) => sum + file.text.length, 0)
  const tooBig = [...oversized].filter((path) => !dataPaths.has(path))
  if (bytes > MAX_DIFF_BYTES || tooBig.length) {
    const set = readers ? `${data.length} data, generated or asset file${data.length === 1 ? "" : "s"} set aside for readers and not counted` : "readers are off, so data files are not set aside"
    throw new Error(`[PR_REVIEW]: the reviewable part of the diff is ${tooBig.length ? `larger than ${MiB(MAX_DIFF_BYTES)} MiB in ${tooBig.slice(0, 3).join(", ")} alone` : `${MiB(bytes)} MiB in ${reviewable.length} file${reviewable.length === 1 ? "" : "s"}`}, more than the ${MiB(MAX_DIFF_BYTES)} MiB a review reads (${set}); split the pull request or mark generated files in .gitattributes`)
  }
  return { files, triage: { code: reviewable, data } }
}

/**
 * The diff of `base...head` in `directory` and the graph context of what it touches, within `budgetTokens * CONTEXT_SHARE`.
 * `ignore` drops paths the repository config excludes. Without a graph the review proceeds on the diff alone and the notes say so.
 */
export async function buildReviewContext({ directory, base, head, budgetTokens, graph, git = gitRun, ignore = () => false, readers, attributes }: { directory: string; base: string; head: string; budgetTokens: number; graph?: Graph | undefined; git?: GitRun; ignore?: (path: string) => boolean; readers?: ContextReaders | undefined; attributes?: string | undefined }): Promise<ReviewContext> {
  for (const ref of [base, head]) if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(ref) || ref.includes("..")) throw new Error(`[PR_REVIEW]: invalid ref ${JSON.stringify(ref.slice(0, 80))}`)
  const fetched = await fetchDiff({ directory, base, head, git, ignore, readers: !!readers, attributes })
  const files = fetched.files
  // Data and generated files go to readers (when the run has them): the review pass gets their summaries in place of their diffs.
  const triage = readers ? fetched.triage : { code: files, data: [] }
  const diffTokens = estimateTokens(files.reduce((sum, file) => sum + chars(file), 0))
  const read = triage.data.length ? await readers!({ data: triage.data, cut: [], diffTokens }) : []
  const placeholders = readerTexts(files, read)
  const shownFiles = files.map((file) => placeholders.has(file.path) ? { ...file, text: placeholders.get(file.path)! } : file)
  const readTokens = triage.data.filter((entry) => placeholders.has(entry.file.path)).reduce((sum, entry) => sum + estimateTokens(chars(entry.file)), 0)
  const notes: string[] = []
  let symbols: ChangedSymbol[] = []
  if (!graph) notes.push("No code graph index: reviewed from the diff alone.")
  else {
    const describe = (node: GraphNode) => `${node.label} (${loc(node)})`
    for (const file of files) for (const node of placeholders.has(file.path) ? [] : touchedNodes(graph, file)) {
      if (symbols.length >= MAX_SYMBOLS) break
      const callers = traverseCalls({ graph, start: node, direction: "in", depth: GRAPH_DEPTH, cap: CALLER_CAP })
      const callees = traverseCalls({ graph, start: node, direction: "out", depth: GRAPH_DEPTH, cap: CALLER_CAP })
      symbols.push({ symbol: node.label, path: node.path, line: node.start, callers: [...callers.rows.map((row) => describe(row.node)), ...(callers.more ? [`${callers.more} more`] : [])], callees: [...callees.rows.map((row) => describe(row.node)), ...(callees.more ? [`${callees.more} more`] : [])] })
    }
  }
  const limit = Math.max(1_000, Math.floor(budgetTokens * CONTEXT_SHARE))
  const whole = tokensOf(shownFiles.map((file) => file.text).join(""), symbols)
  const layout = (summaries?: ReadonlyMap<string, string>) => {
    const single = singleView({ files: shownFiles, symbols, limit, summaries })
    // Callers and callees are cut first; a diff that still does not fit one call is reviewed in parts of whole files rather than
    // with the largest diffs left out.
    const split = single.cut.length && shownFiles.length > 1 ? splitIntoParts({ files: shownFiles, symbols, limit, summaries }) : undefined
    const parts = split && split.parts.length > 1 ? split.parts : undefined
    return { single, parts, cut: parts ? split!.cut : single.cut }
  }
  let laid = layout()
  // Code files a large diff could not fit are read by readers too, so the review pass gets what they hold instead of only their names.
  const cutFiles = readers ? laid.cut.flatMap((file) => { const found = files.find((entry) => entry.path === file); return found && !placeholders.has(file) ? [found] : [] }) : []
  const cutRead = cutFiles.length ? await readers!({ data: [], cut: cutFiles, diffTokens }) : []
  if (cutRead.length) laid = layout(new Map(cutRead.flatMap((summary) => summary.paths.map((file) => [file, summaryLine(summary)] as const))))
  const readCount = new Set([...read, ...cutRead].flatMap((summary) => summary.paths)).size
  const extra = { ...(readCount ? { readers: { files: readCount } } : {}), ...(readTokens ? { readTokens } : {}) }
  const { single, parts, cut } = laid
  if (!parts) {
    notes.push(...single.notes)
    return { directory, base, head, diff: single.diff, files, changedSymbols: single.symbols, truncated: single.truncated, notes, tokens: tokensOf(single.diff, single.symbols), ...extra }
  }
  notes.push(`The diff (about ${whole.toLocaleString("en-US")} tokens) is larger than one review call (${limit.toLocaleString("en-US")}), so it was reviewed in ${parts.length} parts of whole files.`)
  if (cut.length) notes.push(`The diffs of ${cut.length} file${cut.length === 1 ? "" : "s"} did not fit a part and were left out${cutRead.length ? " (readers summarized them)" : ""}: ${cut.slice(0, 8).join(", ")}${cut.length > 8 ? ", …" : ""}.`)
  return { directory, base, head, diff: single.diff, files, changedSymbols: single.symbols, truncated: true, notes, tokens: tokensOf(single.diff, single.symbols), parts, ...extra }
}

/** The diff as one call carries it within `limit`: callers and callees cut first (they are context), then the largest files' diffs. */
function singleView({ files, symbols: all, limit, summaries }: { files: readonly FileDiff[]; symbols: ChangedSymbol[]; limit: number; summaries?: ReadonlyMap<string, string> | undefined }): { diff: string; symbols: ChangedSymbol[]; truncated: boolean; notes: string[]; cut: string[] } {
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
      entry.text = leftOut(entry.file, "the token budget", summaries)
      cut.push(entry.file.path)
    }
    truncated = true
    notes.push(`The token budget left out the diffs of ${cut.length} file${cut.length === 1 ? "" : "s"}: ${cut.slice(0, 8).join(", ")}${cut.length > 8 ? ", …" : ""}.`)
  }
  return { diff: diffOf(), symbols, truncated, notes, cut }
}
