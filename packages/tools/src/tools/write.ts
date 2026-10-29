import { readFile, stat } from "node:fs/promises"
import { z } from "zod"
import { defineTool } from "../tool"
import { atomicWrite, boundPreview, displayPath, errorMessage, fail, looksBinary, renderDiff, resolvePath, succeed } from "../util"

const MAX_PREVIEW_FILE_BYTES = 5 * 1024 * 1024

export default defineTool({
  name: "write",
  description: "Write a whole file, replacing it; creates parent directories.",
  permission: "write",
  args: z.object({
    path: z.string().describe("Absolute or project-relative path"),
    content: z.string().describe("Full file content"),
  }),
  async execute({ path, content }, context) {
    const abs = resolvePath({ cwd: context.cwd, path })
    const shown = displayPath({ cwd: context.cwd, path: abs })
    const title = `Write ${shown}`
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      let created = true
      try {
        const info = await stat(abs)
        if (info.isDirectory()) return fail({ title, message: `${shown} is a directory` })
        created = false
      } catch {
        created = true
      }
      await atomicWrite({ path: abs, content })
      const bytes = Buffer.byteLength(content)
      return succeed({
        title,
        output: `${created ? "Created" : "Wrote"} ${shown} (${bytes} bytes)`,
        meta: { path: abs, bytes, created },
      })
    } catch (error) {
      return fail({ title, message: `cannot write ${shown}: ${errorMessage(error)}` })
    }
  },
  async preview({ path, content }, context) {
    try {
      const abs = resolvePath({ cwd: context.cwd, path })
      let existing: string | undefined
      try {
        const info = await stat(abs)
        if (info.isDirectory() || info.size > MAX_PREVIEW_FILE_BYTES || (await looksBinary(abs))) return undefined
        existing = await readFile(abs, "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined
      }
      if (existing === undefined) {
        const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n")
        return boundPreview([`+ new file ${lines.length} ${lines.length === 1 ? "line" : "lines"}`, ...lines.map((line) => `+${line}`)].join("\n"))
      }
      if (existing === content) return "(no changes)"
      return boundPreview(renderDiff({ before: existing, after: content }))
    } catch {
      return undefined
    }
  },
})
