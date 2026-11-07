import { estimateTokens } from "@mendcode/protocol"
import { posix } from "node:path"
import { parseDiffRows } from "@mendcode/protocol/wire"
import type { Graph, GraphNode } from "@mendcode/codegraph"
import { loc, traverseCalls } from "../../../codegraph/src/query"
import type { PullRequestInfo } from "./pull-request"
import { CODE_FILE_CHARS, codeReadText } from "./read-code"
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

/** `maxBytes`: bound retained output; `count` drains a per-file diff, keeping its full coordinates up to the hard bound. */
export type GitRun = (args: string[], cwd: string, maxBytes?: number, count?: boolean) => Promise<{ code: number; out: string; cut?: true | undefined; bytes?: number; coordinates?: Pick<FileDiff, "right" | "touched"> }>

/** `git` without a shell; output bounded by `maxBytes` when the caller sets it. */
export const gitRun: GitRun = async (args, cwd, maxBytes, count) => {
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
      // Per-file scans retain coordinates from the entire stream, not just the retained excerpt.
      // Only a line's prefix is needed, so even a single enormous source line stays bounded.
      const right = new Set<number>()
      const touched = new Set<number>()
      let prefix = ""
      let nextNew = 0
      let inHunk = false
      const line = () => {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(prefix)
        if (hunk) { nextNew = Number(hunk[1]); inHunk = true }
        else if (inHunk) {
          if (prefix[0] === "+" || prefix[0] === " ") { right.add(nextNew); if (prefix[0] === "+") touched.add(nextNew); nextNew++ }
          else if (prefix[0] === "-") touched.add(nextNew)
        }
        prefix = ""
      }
      const reader = child.stdout.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (count) {
          let at = 0
          while (at < value.length) {
            const end = value.indexOf(10, at)
            const until = end < 0 ? value.length : end
            if (prefix.length < 128) prefix += Buffer.from(value.subarray(at, Math.min(until, at + 128 - prefix.length))).toString("ascii")
            if (end < 0) break
            line(); at = end + 1
          }
        }
        if (size < maxBytes) chunks.push(value.subarray(0, maxBytes - size))
        size += value.length
        if (size > maxBytes) { cut = true; if (!count || size > HARD_DIFF_BYTES) { child.kill(); break } }
      }
      if (count && prefix) line()
      const coordinates = count ? { right, touched: [...touched].sort((a, b) => a - b) } : undefined
      const out = new TextDecoder().decode(Buffer.concat(chunks), { stream: cut })
      if (cut) { const code = await child.exited; return { code: count && size <= HARD_DIFF_BYTES ? code : 0, out, cut: true, bytes: size, ...(coordinates ? { coordinates } : {}) } }
      return { code: await child.exited, out, bytes: size, ...(coordinates ? { coordinates } : {}) }
    } finally { clearTimeout(timer) }
  } catch { return { code: 127, out: "" } }
}

export const CALLER_CAP = 12
export const GRAPH_DEPTH = 2
/** The share of the PR's token budget the context may take; the rest is for the review answer and the verify pass. */
export const CONTEXT_SHARE = 0.5
const MAX_SYMBOLS = 40
/** The most full code diff text retained for the main review; without readers this remains the safety bound. */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024
export const HARD_DIFF_BYTES = 64 * 1024 * 1024
export const MAX_DIFF_FILES = 20_000
/** The most of one data, generated or asset file's diff that is fetched: a sample for readers (with readers off, for the budget cut). */
const SAMPLE_BYTES_READERS = 1_500_000
const SAMPLE_BYTES_PLAIN = 256 * 1024
/** Counting/classification never retains a whole code diff. */
const SCAN_BYTES = 64 * 1024

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
  /** Exact streamed byte count; deferred code carries no diff text until a reader needs it. */
  bytes?: number
  deferred?: boolean
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
  /** Files omitted from the review's diffs without a successful model-reader summary. */
  unread?: string[] | undefined
  /** Set when readers read the changed code (`readers.code: all`): every changed file with its size, so the review pass sees the whole change though it gets only the risk spots' hunks. */
  overview?: string | undefined
}

/**
 * Reads files for the review pass (readers.ts): the data files triage chose and the code files a large diff's parts cut, each
 * summary naming the paths it covers. run.ts binds it to the reader model, the parallel count and the readers' share of the cap.
 */
export type ContextReaders = (input: { data: TriagedFile[]; cut: FileDiff[]; /** Changed code files for the readers to read (`readers.code: all`). */ code?: FileDiff[] | undefined; load?: ((file: FileDiff) => Promise<FileDiff>) | undefined; /** Estimated tokens of the whole diff, for the readers' share of the cap. */ diffTokens: number }) => Promise<ReaderSummary[]>

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
/**
 * A file's diff without its deletion-only hunks (hunks with removed lines and no added line): they say what went away, which the
 * review reads from the line counts, and they are the cheapest text to leave out. Each file keeps its header and gains one line
 * with the number of deleted lines and where they were. Unchanged when that line would not be shorter than what it replaces, so
 * the prompt can only shrink.
 */
export function withoutDeletionHunks(text: string): string {
  const at = text.search(/^@@ /m)
  if (at < 0) return text
  const head = text.slice(0, at)
  const hunks = text.slice(at).split(/^(?=@@ )/m)
  const dropped: Array<{ start: number; removed: number }> = []
  const kept = hunks.filter((hunk) => {
    const lines = hunk.replace(/\n$/, "").split("\n").slice(1)
    const removed = lines.filter((line) => line.startsWith("-")).length
    if (!removed || lines.some((line) => line.startsWith("+"))) return true
    dropped.push({ start: Number(/^@@ -(\d+)/.exec(hunk)?.[1] ?? 0), removed })
    return false
  })
  if (!dropped.length) return text
  const total = dropped.reduce((sum, hunk) => sum + hunk.removed, 0)
  const where = dropped.slice(0, 6).map((hunk) => hunk.start).join(", ") + (dropped.length > 6 ? ", …" : "")
  const note = `(${total} deleted line${total === 1 ? "" : "s"} in ${dropped.length} hunk${dropped.length === 1 ? "" : "s"} with no added lines, not shown; old lines near ${where})\n`
  const result = head + kept.join("") + note
  return result.length < text.length ? result : text
}

const LANGUAGE_FAMILY: Record<string, string> = { ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", h: "c", hpp: "c", cc: "c", cpp: "c", c: "c", kts: "kt" }
/** Extensions of data, markup and docs: never the repository's main language, whatever their size. */
const NOT_CODE = new Set(["json", "jsonl", "csv", "tsv", "lock", "md", "mdx", "txt", "yaml", "yml", "toml", "svg", "snap", "map", "xml", "html", "css", "ipynb", "log", "sql"])
const extOf = (file: string) => /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase()
const familyOf = (file: string) => { const ext = extOf(file); return ext ? LANGUAGE_FAMILY[ext] ?? ext : undefined }
const codeFamilyOf = (file: string) => { const ext = extOf(file); return ext && !NOT_CODE.has(ext) ? LANGUAGE_FAMILY[ext] ?? ext : undefined }

/**
 * The repository's main language as a file-extension family: the one most files of the code graph have, else the one most of the
 * diff's text is in. Undefined when neither names one.
 */
export function mainLanguage({ graph, files }: { graph?: Graph | undefined; files: readonly FileDiff[] }): string | undefined {
  const counts = new Map<string, number>()
  if (graph) for (const file of graph.byPath.keys()) { const family = codeFamilyOf(file); if (family) counts.set(family, (counts.get(family) ?? 0) + 1) }
  if (!counts.size) for (const file of files) { const family = codeFamilyOf(file.path); if (family) counts.set(family, (counts.get(family) ?? 0) + file.text.length) }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
}

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
    // A code file a reader could not read stays as it is: the review pass gets its whole diff.
    if (summary.by === "raw") continue
    // A code file a model read: its summary, risk spots and the hunks of those, in place of the whole diff.
    if (summary.code) {
      for (const read of summary.code) { const found = files.find((entry) => entry.path === read.path); if (found) texts.set(read.path, codeReadText(found, read, summary.by)) }
      continue
    }
    summary.paths.forEach((file, index) => {
      const found = files.find((entry) => entry.path === file)
      if (!found) return
      const stats = found.size ?? diffLines(found).stats
      const head = `(+${stats.added.toLocaleString("en-US")} -${stats.removed.toLocaleString("en-US")} lines, not shown${summary.by === "not read" ? ": not read" : index === 0 ? ": a reader read it" : ", summarized above"})`
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
const chars = (file: FileDiff) => file.bytes ?? (file.size ? Math.round(file.text.length * (file.size.added + file.size.removed) / Math.max(1, file.text.split("\n").length)) : file.text.length)

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
 * fetched as a sample for readers. Code fitting the bound is fetched in batches; larger code is counted through a bounded stream,
 * then the highest-risk files are fetched whole up to MAX_DIFF_BYTES. The rest has metadata only and a per-file loader.
 */
async function fetchDiff({ directory, base, head, git, ignore, readers, attributes, graph, mainBytes }: { directory: string; base: string; head: string; git: GitRun; ignore: (path: string) => boolean; readers: boolean; attributes: string | undefined; graph?: Graph | undefined; mainBytes?: number | undefined }): Promise<{ files: FileDiff[]; triage: { code: FileDiff[]; data: TriagedFile[] }; load?: (file: FileDiff) => Promise<FileDiff> }> {
  const range = `${base}...${head}`
  const failed = () => new Error(`[PR_REVIEW]: git diff ${range} failed in ${directory}`)
  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", range, "--"]
  const stat = await git(["diff", "--no-renames", "--numstat", "-z", range, "--"], directory, MAX_DIFF_BYTES)
  if (stat.code !== 0) throw failed()
  const bound = readers ? HARD_DIFF_BYTES : MAX_DIFF_BYTES
  const tooLarge = (bytes: number, count: number, data: number) => new Error(`[PR_REVIEW]: the reviewable part of the diff is ${MiB(bytes)} MiB in ${count} files, more than the ${MiB(bound)} MiB a review reads (${readers ? `${data} data, generated or asset files set aside for readers and not counted` : "readers are off, so data files are not set aside"}; at most ${MAX_DIFF_FILES.toLocaleString("en-US")} files); split the pull request or mark generated files in .gitattributes`)
  if (stat.cut) throw tooLarge(bound + 1, MAX_DIFF_FILES + 1, 0)
  const rows = parseNumstat(stat.out)
  if (!rows) {
    const whole = await git(diffArgs, directory, MAX_DIFF_BYTES)
    if (whole.code !== 0) throw failed()
    if (whole.cut || Buffer.byteLength(whole.out) > MAX_DIFF_BYTES) throw new Error(`[PR_REVIEW]: the diff is larger than ${MAX_DIFF_BYTES / 1024 / 1024} MiB`)
    const files = parseUnifiedDiff(whole.out).filter((file) => !ignore(file.path))
    return { files, triage: readers ? triageFiles(files, attributes) : { code: files, data: [] } }
  }
  const listed = rows.filter((row) => !ignore(row.path))
  if (listed.length > MAX_DIFF_FILES) throw tooLarge(0, listed.length, 0)
  const rules = generatedRules(attributes)
  const named = new Map<string, TriageReason>()
  for (const row of listed) { const reason = triageByStat(row, rules); if (reason) named.set(row.path, reason) }
  const sampleBytes = readers ? SAMPLE_BYTES_READERS : SAMPLE_BYTES_PLAIN
  const literal = (path: string) => `:(literal)${path}`
  const sized = new Map(listed.map((row) => [row.path, row]))
  /** One file's diff, up to `maxBytes`: a cut one ends at its last whole line and carries the whole change's size. */
  const one = async (row: NumstatRow, maxBytes: number, count = false): Promise<{ file: FileDiff | undefined; bytes: number }> => {
    const done = await git(diffArgs.concat(literal(row.path)), directory, maxBytes, count)
    if (done.code !== 0) throw failed()
    const text = done.cut ? done.out.slice(0, done.out.lastIndexOf("\n") + 1) : done.out
    const file = parseUnifiedDiff(text)[0]
    if (file && done.coordinates && !file.deleted) Object.assign(file, done.coordinates)
    if (file && done.cut) file.size = { added: row.added, removed: row.removed }
    return { file, bytes: done.bytes ?? Buffer.byteLength(done.out) }
  }
  const found = new Map<string, FileDiff>()
  const aside = listed.filter((row) => named.has(row.path))
  for (let at = 0; at < aside.length; at += 4) {
    await Promise.all(aside.slice(at, at + 4).map(async (row) => { const { file } = await one(row, sampleBytes); if (file) found.set(row.path, file) }))
  }
  const rest = listed.filter((row) => !named.has(row.path))
  // The common case needs only numstat and one diff per hundred paths, never a per-file scan.
  // Probe actual bytes (numstat counts lines, not bytes), retaining no more than the main bound.
  {
    const batched: FileDiff[] = []
    let bytes = 0
    let fits = true
    for (let at = 0; at < rest.length; at += 100) {
      const done = await git(diffArgs.concat(rest.slice(at, at + 100).map((row) => literal(row.path))), directory, MAX_DIFF_BYTES - bytes)
      if (done.code !== 0) throw failed()
      bytes += done.bytes ?? Buffer.byteLength(done.out)
      if (done.cut || bytes > MAX_DIFF_BYTES) { fits = false; break }
      batched.push(...parseUnifiedDiff(done.out))
    }
    if (fits) {
      for (const file of batched) found.set(file.path, file)
      const files = listed.flatMap((row) => found.get(row.path) ?? [])
      if (!readers) return { files, triage: { code: files, data: [] } }
      // Set-aside files keep what their full numstat row named them: a bounded sample can hold too few lines to be named again.
      const scanned = triageFiles(files.filter((file) => !named.has(file.path)), attributes)
      const data = [
        ...files.flatMap((file) => { const row = sized.get(file.path)!, reason = named.get(file.path); return reason ? [{ file, reason, stats: { ...diffLines(file).stats, added: row.added, removed: row.removed } }] : [] }),
        ...scanned.data,
      ]
      // Diff order, by a position table: a many-file review must not search the list on every comparison.
      const position = new Map(files.map((file, index) => [file, index]))
      data.sort((a, b) => position.get(a.file)! - position.get(b.file)!)
      return { files, triage: { code: scanned.code, data } }
    }
  }
  let bytes = 0
  const imported = new Map<string, Set<string>>()
  for (const row of rest) {
    const scanned = await one(row, SCAN_BYTES, true)
    const file = scanned.file
    if (!file) continue
    const data = readers ? triageFiles([file], attributes).data[0] : undefined
    if (data) { named.set(row.path, data.reason); found.set(row.path, file); continue }
    bytes += scanned.bytes
    if (bytes > bound) throw tooLarge(bytes, rest.length, named.size)
    // Relative imports from changed files still provide a useful risk signal without an index.
    for (const match of [...file.text.matchAll(/(?:from\s*|import\s*\(|require\s*\()["'](\.[^"']+)["']/g)].slice(0, MAX_SYMBOLS)) {
      const target = posix.normalize(posix.join(posix.dirname(row.path), match[1]!)).replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "")
      const sources = imported.get(target) ?? new Set<string>(); sources.add(row.path); imported.set(target, sources)
    }
    found.set(row.path, { ...file, text: "", size: { added: row.added, removed: row.removed }, bytes: scanned.bytes, deferred: true })
  }
  let files = listed.flatMap((row) => found.get(row.path) ?? [])
  const withStats = (entry: TriagedFile): TriagedFile => { const row = sized.get(entry.file.path); return row && entry.file.size ? { ...entry, stats: { ...entry.stats, added: row.added, removed: row.removed } } : entry }
  const data = [
    ...listed.filter((row) => named.has(row.path)).flatMap((row) => { const file = found.get(row.path); return file ? [withStats({ file, reason: named.get(row.path)!, stats: { ...diffLines(file).stats, added: row.added, removed: row.removed } })] : [] }),
  ].sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file))
  const reviewable = files.filter((file) => !named.has(file.path))
  const changed = new Set(listed.map((row) => row.path))
  const lowRisk = (file: FileDiff) => /(^|\/)(tests?|__tests__|docs?|examples?)\/|\.(test|spec)\.|\.(md|mdx|txt)$/i.test(file.path)
  const fanIn = (file: FileDiff) => new Set([...(graph?.importers.get(file.path) ?? []).filter((path) => changed.has(path)), ...(imported.get(file.path.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "")) ?? [])]).size
  const fanIns = new Map(reviewable.map((file) => [file.path, fanIn(file)]))
  const ranked = [...reviewable].sort((a, b) => Number(lowRisk(a)) - Number(lowRisk(b)) || fanIns.get(b.path)! - fanIns.get(a.path)! || (b.size!.added + b.size!.removed) - (a.size!.added + a.size!.removed) || a.path.localeCompare(b.path))
  let held = 0
  const holdBound = bytes > MAX_DIFF_BYTES ? Math.min(MAX_DIFF_BYTES, mainBytes ?? MAX_DIFF_BYTES) : MAX_DIFF_BYTES
  for (const file of ranked) {
    if (held + file.bytes! > holdBound) continue
    const full = await one(sized.get(file.path)!, MAX_DIFF_BYTES)
    if (!full.file) throw failed()
    held += full.bytes
    Object.assign(file, full.file, { deferred: false, size: undefined })
  }
  if (bytes > MAX_DIFF_BYTES) files = [...ranked, ...data.map((entry) => entry.file)]
  const load = async (file: FileDiff) => {
    if (!file.deferred) return file
    const loaded = (await one(sized.get(file.path)!, SCAN_BYTES)).file
    if (!loaded) throw failed()
    // Loading a bounded excerpt must never replace the full scan's line coordinates.
    return loaded
  }
  return { files, triage: { code: reviewable, data }, load }
}

/**
 * The diff of `base...head` in `directory` and the graph context of what it touches, within `budgetTokens * CONTEXT_SHARE`.
 * `ignore` drops paths the repository config excludes. Without a graph the review proceeds on the diff alone and the notes say so.
 */
export async function buildReviewContext({ directory, base, head, budgetTokens, graph, git = gitRun, ignore = () => false, readers, attributes, compress = true, mainBytes, readCode = false }: { directory: string; base: string; head: string; budgetTokens: number; compress?: boolean; /** The readers read every changed code file and the review pass gets summaries and risk-spot hunks (`readers.code: all`). */ readCode?: boolean; graph?: Graph | undefined; git?: GitRun; ignore?: (path: string) => boolean; readers?: ContextReaders | undefined; attributes?: string | undefined; mainBytes?: number | undefined }): Promise<ReviewContext> {
  for (const ref of [base, head]) if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,199}$/.test(ref) || ref.includes("..")) throw new Error(`[PR_REVIEW]: invalid ref ${JSON.stringify(ref.slice(0, 80))}`)
  const fetched = await fetchDiff({ directory, base, head, git, ignore, readers: !!readers, attributes, graph, mainBytes })
  const files = fetched.files
  // Data and generated files go to readers (when the run has them): the review pass gets their summaries in place of their diffs.
  const triage = readers ? fetched.triage : { code: files, data: [] }
  const diffTokens = estimateTokens(files.reduce((sum, file) => sum + chars(file), 0))
  const overflow = triage.code.filter((file) => file.deferred)
  // Code the readers read: files with lines on the new side whose diff a cheap model can hold; the rest go to the review pass whole.
  const readable = readers && readCode ? triage.code.filter((file) => !file.deferred && !file.deleted && file.right.size > 0 && file.text.length <= CODE_FILE_CHARS) : []
  const read = readers && (triage.data.length || overflow.length || readable.length) ? await readers({ data: triage.data, cut: overflow, ...(readable.length ? { code: readable } : {}), load: fetched.load, diffTokens }) : []
  for (const file of overflow) if (!read.some((summary) => summary.paths.includes(file.path))) read.push({ id: "unread", paths: [file.path], text: "not read: no reader summary available", by: "not read" })
  const placeholders = readerTexts(files, read)
  const shownFiles = files.map((file) => placeholders.has(file.path) ? { ...file, text: placeholders.get(file.path)! } : compress ? { ...file, text: withoutDeletionHunks(file.text) } : file)
  const main = compress ? mainLanguage({ graph, files }) : undefined
  // A code file a reader read still counts for the cap by what the review pass is spared: its whole diff less what it was shown.
  const readCodePaths = new Set(read.flatMap((summary) => summary.code?.map((entry) => entry.path) ?? []))
  const readTokens = [...triage.data.map((entry) => entry.file), ...overflow].filter((file) => placeholders.has(file.path)).reduce((sum, file) => sum + estimateTokens(chars(file)), 0)
    + files.filter((file) => readCodePaths.has(file.path)).reduce((sum, file) => sum + Math.max(0, estimateTokens(chars(file)) - estimateTokens(placeholders.get(file.path)!.length)), 0)
  const notes: string[] = []
  if (overflow.length) notes.push(`The review pass kept higher-risk code within ${MiB(MAX_DIFF_BYTES)} MiB (source before tests/docs, imports by changed files, then changed lines). Not read in full by the review pass: ${overflow.map((file) => file.path).join(", ")}.`)
  const unread = read.filter((summary) => summary.by === "not read").flatMap((summary) => summary.paths)
  if (unread.length) notes.push(`Not read: ${unread.join(", ")}. The readers' share was unavailable, spent, or the reader failed; these files have no model review.`)
  let symbols: ChangedSymbol[] = []
  if (!graph) notes.push("No code graph index: reviewed from the diff alone.")
  else {
    const describe = (node: GraphNode) => `${node.label} (${loc(node)})`
    // Callers of what changed are the graph's context for the review pass; a file a reader read still has them (its hunks are all the pass sees).
    for (const file of files) for (const node of placeholders.has(file.path) && !readCodePaths.has(file.path) ? [] : touchedNodes(graph, file)) {
      if (symbols.length >= MAX_SYMBOLS) break
      const callers = traverseCalls({ graph, start: node, direction: "in", depth: GRAPH_DEPTH, cap: CALLER_CAP })
      const callees = traverseCalls({ graph, start: node, direction: "out", depth: GRAPH_DEPTH, cap: CALLER_CAP })
      symbols.push({ symbol: node.label, path: node.path, line: node.start, callers: [...callers.rows.map((row) => describe(row.node)), ...(callers.more ? [`${callers.more} more`] : [])], callees: [...callees.rows.map((row) => describe(row.node)), ...(callees.more ? [`${callees.more} more`] : [])] })
    }
  }
  const limit = Math.max(1_000, Math.floor(budgetTokens * CONTEXT_SHARE))
  const whole = tokensOf(shownFiles.map((file) => file.text).join(""), symbols)
  const layout = (extra?: ReadonlyMap<string, string>) => {
    const summaries = new Map([...placeholders, ...(extra ?? [])])
    const single = singleView({ files: shownFiles, symbols, limit, summaries, main })
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
  const cutUnread = cutRead.filter((summary) => summary.by === "not read").flatMap((summary) => summary.paths)
  if (cutUnread.length) notes.push(`Not read: ${cutUnread.join(", ")}. The readers' share was unavailable, spent, or the reader failed.`)
  if (cutRead.length) laid = layout(new Map(cutRead.flatMap((summary) => summary.paths.map((file) => [file, summaryLine(summary)] as const))))
  const readCount = new Set([...read, ...cutRead].filter((summary) => summary.by !== "raw").flatMap((summary) => summary.paths)).size
  const overview = readCodePaths.size ? `${files.slice(0, 300).map((file) => { const stats = file.size ?? diffLines(file).stats; return `${file.path} (+${stats.added} -${stats.removed})` }).join("\n")}${files.length > 300 ? `\n… and ${files.length - 300} more files` : ""}` : undefined
  const { single, parts, cut } = laid
  const summaries = [...read, ...cutRead]
  const covered = new Set(summaries.filter((summary) => summary.by !== "not read" && summary.by !== "local" && summary.by !== "raw").flatMap((summary) => summary.paths))
  const notRead = [...new Set([...unread, ...cutUnread, ...[...overflow.map((file) => file.path), ...cut].filter((path) => !covered.has(path))])]
  const extra = { ...(readCount ? { readers: { files: readCount } } : {}), ...(overview ? { overview } : {}), ...(readTokens ? { readTokens } : {}), ...(notRead.length ? { unread: notRead } : {}) }
  if (!parts) {
    notes.push(...single.notes)
    return { directory, base, head, diff: single.diff, files, changedSymbols: single.symbols, truncated: single.truncated || !!overflow.length, notes, tokens: tokensOf(single.diff, single.symbols), ...extra }
  }
  notes.push(`The diff (about ${whole.toLocaleString("en-US")} tokens) is larger than one review call (${limit.toLocaleString("en-US")}), so it was reviewed in ${parts.length} parts of whole files.`)
  if (cut.length) notes.push(`The diffs of ${cut.length} file${cut.length === 1 ? "" : "s"} did not fit a part and were left out${cutRead.length ? " (readers summarized them)" : ""}: ${cut.slice(0, 8).join(", ")}${cut.length > 8 ? ", …" : ""}.`)
  return { directory, base, head, diff: single.diff, files, changedSymbols: single.symbols, truncated: true, notes, tokens: tokensOf(single.diff, single.symbols), parts, ...extra }
}

/** The diff as one call carries it within `limit`: callers and callees cut first (they are context), then the largest files' diffs. */
function singleView({ files, symbols: all, limit, summaries, main }: { files: readonly FileDiff[]; symbols: ChangedSymbol[]; limit: number; summaries?: ReadonlyMap<string, string> | undefined; main?: string | undefined }): { diff: string; symbols: ChangedSymbol[]; truncated: boolean; notes: string[]; cut: string[] } {
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
    // Files outside the main language go first, the largest of each kind first.
    const outside = (path: string) => main !== undefined && familyOf(path) !== main
    for (const entry of [...shown].sort((a, b) => Number(outside(b.file.path)) - Number(outside(a.file.path)) || b.text.length - a.text.length)) {
      if (tokensOf(diffOf(), symbols) <= limit) break
      entry.text = leftOut(entry.file, "the token budget", summaries)
      cut.push(entry.file.path)
    }
    truncated = true
    notes.push(`The token budget left out the diffs of ${cut.length} file${cut.length === 1 ? "" : "s"}: ${cut.slice(0, 8).join(", ")}${cut.length > 8 ? ", …" : ""}.`)
  }
  return { diff: diffOf(), symbols, truncated, notes, cut }
}
