import { stat } from "node:fs/promises"
import { z } from "zod"
import { newWalkBudget, walkGlob } from "../glob-walk"
import { defineTool } from "../tool"
import { displayPath, errorMessage, fail, missingPathMessage, resolvePath, succeed, truncateText, WALK_LIMITS } from "../util"

const MAX_RESULTS = 1000
/** Most patterns one call may merge; they share the result cap. */
const MAX_PATTERNS = 8
/** Overrides the entry budget of a walk (used by tests). */
export const GLOB_MAX_ENTRIES_ENV = "MENDCODE_GLOB_MAX_ENTRIES"

export default defineTool({
  name: "glob",
  description:
    "Find files by glob (src/**/*.ts, {src,test}/**/*.ts), newest first, at most 1000; `patterns` takes several. " +
    "Skips node_modules, .git and hidden files unless named (.github/**). A walk stops at 50,000 entries or 5 s.",
  permission: "read",
  args: z.object({
    pattern: z.string().min(1).optional().describe("Glob pattern"),
    patterns: z.array(z.string().min(1)).min(1).max(MAX_PATTERNS).optional().describe("Several glob patterns, merged into one result"),
    path: z.string().optional().describe("Directory to search (default: project root)"),
  }),
  async execute({ pattern, patterns, path }, context) {
    const wanted = [...new Set([...(pattern === undefined ? [] : [pattern]), ...(patterns ?? [])])]
    if (wanted.length === 0) return fail({ title: "Glob", message: "glob needs `pattern` or `patterns`" })
    const base = path ? resolvePath({ cwd: context.cwd, path }) : context.cwd
    const title = `Glob ${wanted.join(", ")}`
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      const missing = await missingPathMessage({ cwd: context.cwd, path: base })
      if (missing) return fail({ title, message: missing })
      const info = await stat(base)
      if (!info.isDirectory()) return fail({ title, message: `${displayPath({ cwd: context.cwd, path: base })} is not a directory` })
      const maxEntries = Number(process.env[GLOB_MAX_ENTRIES_ENV]) || WALK_LIMITS.maxEntries
      const budget = newWalkBudget({ ...WALK_LIMITS, maxEntries })
      const paths = new Set<string>()
      for (const one of wanted) await walkGlob({ pattern: one, base, budget, signal: context.signal, onFile: (file) => paths.add(file) })
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      const found: Array<{ path: string; mtime: number }> = []
      for (const file of paths) {
        const mtime = await stat(file).then((entry) => entry.mtimeMs, () => undefined)
        if (mtime !== undefined) found.push({ path: file, mtime })
      }
      found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
      const total = found.length
      const shown = found.slice(0, MAX_RESULTS).map((f) => displayPath({ cwd: context.cwd, path: f.path }))
      const walked = `${budget.entries.toLocaleString("en-US")} entries`
      const seconds = `${((Date.now() - budget.startedAt) / 1000).toFixed(1)} s`
      // A comma outside braces is part of one pattern here, never a separator: say where several patterns go.
      const joined = wanted.some((entry) => /,/.test(entry.replace(/\{[^{}]*\}/g, "")))
      if (shown.length === 0) {
        if (budget.partial) return succeed({ title, output: `No files found in the first ${walked} (${seconds}): narrow the pattern or the directory`, truncated: true, meta: { matches: 0, entries: budget.entries, partial: true } })
        return succeed({ title, output: joined ? "No files found. A comma does not separate patterns: put each one in `patterns`." : "No files found", meta: { matches: 0 } })
      }
      let output = shown.join("\n")
      let truncated = budget.partial
      if (total > MAX_RESULTS) {
        truncated = true
        output += `\n[output truncated: ${(total - MAX_RESULTS).toLocaleString("en-US")} more files]`
      }
      if (budget.partial) output += `\n[stopped after ${walked} in ${seconds}: results are partial; narrow the pattern or the directory]`
      const capped = truncateText({ text: output, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      return succeed({
        title,
        output: capped.text,
        truncated: truncated || capped.truncated,
        meta: { matches: shown.length, ...(budget.partial ? { entries: budget.entries, partial: true } : {}) },
      })
    } catch (error) {
      return fail({ title, message: `glob failed: ${errorMessage(error)}` })
    }
  },
})
