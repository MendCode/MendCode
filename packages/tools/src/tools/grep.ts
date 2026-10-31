import { spawn } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { z } from "zod"
import { defineTool, type ToolContext, type ToolResult } from "../tool"
import {
  cancelled,
  displayPath,
  errorMessage,
  fail,
  isSkippedSegment,
  looksBinary,
  missingPathMessage,
  resolvePath,
  succeed,
  truncateText,
} from "../util"

const MAX_MATCHES = 500
const MAX_LINE_CHARS = 1000
const MAX_FILE_BYTES = 2_000_000

/** Set to "1" to force the pure-TypeScript walker even when `rg` is installed (used by tests). */
export const GREP_FALLBACK_ENV = "MENDCODE_GREP_FALLBACK"

type Search = { pattern: string; base: string; include: string | undefined; ignoreCase: boolean; context: number }
/** `lines` is the rendered output; `matches` counts matching lines only, not context lines or `--` separators. */
type Found = { lines: string[]; matches: number; capped: boolean }

const MAX_CONTEXT = 5
const GROUP_SEPARATOR = "--"
/**
 * With context, rg runs with `--null`: `path\0line:text` for a match, `path\0line-text` for a context line. The NUL tells the two
 * apart whatever the path contains; the output then takes rg's usual `path:line:text` / `path-line-text` shape.
 */
const NULL_LINE = /^([^\0]*)\0(\d+)([:-])/

/**
 * True when a group that repeats (`+`, `*`, `{n,}`) holds a repetition of its own, as `(a+)+` or `(\w*,)*`: a JavaScript regex
 * can backtrack exponentially on such a pattern, and the walker runs it on the daemon's thread, where nothing can stop it.
 */
export function nestedRepetition(pattern: string): boolean {
  const groups: boolean[] = []
  let inner = false
  let inClass = false
  const repeatsAt = (at: number) => pattern[at] === "+" || pattern[at] === "*" || (pattern[at] === "{" && /^\{\d*,\}/.test(pattern.slice(at)))
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "\\") { i++; continue }
    if (inClass) { if (char === "]") inClass = false; continue }
    if (char === "[") { inClass = true; continue }
    if (char === "(") { groups.push(inner); inner = false; continue }
    if (char === ")") {
      const held: boolean = inner
      inner = groups.pop() ?? false
      if (held && repeatsAt(i + 1)) return true
      inner ||= held
      continue
    }
    if (repeatsAt(i)) inner = true
  }
  return false
}

const clip = (text: string) => (text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text)

function searchWithRg({ search, context, rg }: { search: Search; context: ToolContext; rg: string }): Promise<Found | string> {
  const args = ["--line-number", "--with-filename", "--no-heading", "--color", "never"]
  if (search.ignoreCase) args.push("-i")
  if (search.context > 0) args.push("-C", String(search.context), "--null")
  if (search.include) args.push("--glob", search.include)
  args.push("--glob", "!node_modules", "--glob", "!.git")
  args.push("-e", search.pattern, "--", search.base)
  return new Promise((resolve) => {
    const child = spawn(rg, args, { cwd: context.cwd, stdio: ["ignore", "pipe", "pipe"] })
    const lines: string[] = []
    let matches = 0
    let pending = ""
    let stderr = ""
    let capped = false
    let settled = false
    const prefix = `${context.cwd}${sep}`
    const finish = (value: Found | string) => {
      if (settled) return
      settled = true
      context.signal.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const push = (raw: string) => {
      if (raw === "" || capped) return
      if (search.context > 0 && raw === GROUP_SEPARATOR) {
        if (lines.length > 0 && lines[lines.length - 1] !== GROUP_SEPARATOR) lines.push(raw)
        return
      }
      const parsed = search.context > 0 ? NULL_LINE.exec(raw) : null
      const isMatch = search.context === 0 || parsed?.[3] === ":"
      if (isMatch && matches >= MAX_MATCHES) {
        capped = true
        child.kill("SIGTERM")
        return
      }
      if (isMatch) matches++
      const line = parsed ? `${parsed[1]}${parsed[3]}${parsed[2]}${parsed[3]}${raw.slice(parsed[0].length)}` : raw
      lines.push(clip(line.startsWith(prefix) ? line.slice(prefix.length) : line))
    }
    const onAbort = () => {
      child.kill("SIGKILL")
      finish("cancelled")
    }
    context.signal.addEventListener("abort", onAbort, { once: true })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      pending += chunk
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      for (const part of parts) push(part)
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2000) stderr += chunk
    })
    child.on("error", (error) => finish(`cannot run rg: ${errorMessage(error)}`))
    child.on("close", (code) => {
      push(pending)
      if (lines[lines.length - 1] === GROUP_SEPARATOR) lines.pop()
      if (capped || code === 0 || code === 1) return finish({ lines, matches, capped })
      finish(stderr.trim().split("\n")[0] || `rg exited with code ${code}`)
    })
  })
}

async function searchWithWalker({ search, context }: { search: Search; context: ToolContext }): Promise<Found | string> {
  let regex: RegExp
  try {
    regex = new RegExp(search.pattern, search.ignoreCase ? "i" : "")
  } catch (error) {
    return `invalid regex: ${errorMessage(error)}`
  }
  if (nestedRepetition(search.pattern)) return "this pattern repeats a group that repeats inside (as (a+)+), which the built-in search (rg is not installed) could run on for minutes; drop the outer repetition or install ripgrep"
  const includeGlob = search.include ? new Bun.Glob(search.include) : undefined
  const includeHasSlash = search.include?.includes("/") ?? false
  const lines: string[] = []
  let matches = 0
  let capped = false

  const included = (file: string) => {
    if (!includeGlob) return true
    const rel = relative(search.base, file).split(sep).join("/")
    return includeGlob.match(includeHasSlash ? rel : (rel.split("/").pop() ?? rel))
  }

  const scanFile = async (file: string) => {
    if (!included(file)) return
    const info = await stat(file).catch(() => undefined)
    if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return
    if (await looksBinary(file).catch(() => true)) return
    const text = await Bun.file(file).text()
    const shown = displayPath({ cwd: context.cwd, path: file })
    const rows = text.split("\n")
    // A final newline ends the last line; it does not start an empty one (rg neither matches nor shows it as context).
    if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop()
    const hits: number[] = []
    for (let index = 0; index < rows.length; index++) {
      if (!regex.test(rows[index] as string)) continue
      if (matches >= MAX_MATCHES) {
        capped = true
        break
      }
      matches++
      hits.push(index)
    }
    if (search.context === 0) {
      for (const index of hits) lines.push(`${shown}:${index + 1}:${clip(rows[index] as string)}`)
      return
    }
    // The shape of rg -C: matching lines with `:`, context lines with `-`, `--` between groups that do not touch.
    const wanted = new Set(hits)
    let last = -2
    for (const index of hits) {
      const from = Math.max(0, last + 1, index - search.context)
      const to = Math.min(rows.length - 1, index + search.context)
      if (from > to) continue
      if (from > last + 1 && lines.length > 0) lines.push(GROUP_SEPARATOR)
      for (let row = from; row <= to; row++) {
        const marker = wanted.has(row) ? ":" : "-"
        lines.push(`${shown}${marker}${row + 1}${marker}${clip(rows[row] as string)}`)
      }
      last = to
    }
  }

  const walk = async (dir: string): Promise<void> => {
    if (context.signal.aborted || capped) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (context.signal.aborted || capped) return
      if (isSkippedSegment(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) await scanFile(full)
    }
  }

  const info = await stat(search.base)
  if (info.isDirectory()) await walk(search.base)
  else await scanFile(search.base)
  if (context.signal.aborted) return "cancelled"
  return { lines, matches, capped }
}

export default defineTool({
  name: "grep",
  description:
    "Regex search of file contents: path:line:text, at most 500 matches, lines cut at 1000 characters. Skips node_modules, .git and binary files.",
  permission: "read",
  args: z.object({
    pattern: z.string().min(1).describe("Regular expression"),
    path: z.string().optional().describe("File or directory to search (default: project root)"),
    include: z.string().optional().describe("File name glob, e.g. *.ts"),
    ignoreCase: z.boolean().optional().describe("Case-insensitive match"),
    // Lines before and after each match, as rg -C; the name says it, and every described key costs each request.
    context: z.number().int().min(0).max(MAX_CONTEXT).optional(),
  }),
  async execute({ pattern, path, include, ignoreCase, context: around }, context): Promise<ToolResult> {
    const title = `Grep ${pattern}`
    if (context.signal.aborted) return cancelled(title)
    const base = path ? resolvePath({ cwd: context.cwd, path }) : context.cwd
    const missing = await missingPathMessage({ cwd: context.cwd, path: base })
    if (missing) return fail({ title, message: missing })
    const search: Search = { pattern, base, include, ignoreCase: ignoreCase ?? false, context: around ?? 0 }
    try {
      const rg = process.env[GREP_FALLBACK_ENV] === "1" ? null : Bun.which("rg")
      const found = rg ? await searchWithRg({ search, context, rg }) : await searchWithWalker({ search, context })
      if (typeof found === "string") {
        return found === "cancelled" ? cancelled(title) : fail({ title, message: found })
      }
      if (found.matches === 0) return succeed({ title, output: "No matches found", meta: { matches: 0 } })
      let output = found.lines.join("\n")
      if (found.capped) output += `\n[output truncated: more than ${MAX_MATCHES} matches; narrow the pattern, the path or \`include\`]`
      const capped = truncateText({ text: output, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      return succeed({
        title,
        output: capped.text,
        truncated: found.capped || capped.truncated,
        meta: { matches: found.matches },
      })
    } catch (error) {
      return fail({ title, message: `grep failed: ${errorMessage(error)}` })
    }
  },
})
