import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { defineTool } from "../tool"
import { displayPath, errorMessage, fail, isSkippedSegment, missingPathMessage, resolvePath, succeed, truncateText } from "../util"

const MAX_ENTRIES = 1000

export default defineTool({
  name: "ls",
  description: "List a directory: at most 1000 entries, directories first with a trailing slash. Skips node_modules and .git.",
  permission: "read",
  args: z.object({ path: z.string().optional().describe("Directory (default: project root)") }),
  async execute({ path }, context) {
    const abs = path ? resolvePath({ cwd: context.cwd, path }) : context.cwd
    const shown = displayPath({ cwd: context.cwd, path: abs })
    const title = `ls ${shown}`
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      const entries = await readdir(abs, { withFileTypes: true })
      const dirs: string[] = []
      const files: string[] = []
      for (const entry of entries) {
        if (isSkippedSegment(entry.name)) continue
        let isDir = entry.isDirectory()
        if (entry.isSymbolicLink()) {
          try {
            isDir = (await stat(join(abs, entry.name))).isDirectory()
          } catch {
            isDir = false
          }
        }
        ;(isDir ? dirs : files).push(isDir ? `${entry.name}/` : entry.name)
      }
      const byName = (a: string, b: string) => a.localeCompare(b)
      const all = [...dirs.sort(byName), ...files.sort(byName)]
      if (all.length === 0) return succeed({ title, output: "(empty)", meta: { entries: 0 } })
      let output = all.slice(0, MAX_ENTRIES).join("\n")
      let truncated = false
      if (all.length > MAX_ENTRIES) {
        truncated = true
        output += `\n[output truncated: ${(all.length - MAX_ENTRIES).toLocaleString("en-US")} more entries]`
      }
      const capped = truncateText({ text: output, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      return succeed({
        title,
        output: capped.text,
        truncated: truncated || capped.truncated,
        meta: { entries: Math.min(all.length, MAX_ENTRIES) },
      })
    } catch (error) {
      return fail({ title, message: `cannot list ${(await missingPathMessage({ cwd: context.cwd, path: abs })) ?? `${shown}: ${errorMessage(error)}`}` })
    }
  },
})
