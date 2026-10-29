import { readFile } from "node:fs/promises"
import { z } from "zod"
import { defineTool } from "../tool"
import { atomicWrite, boundPreview, displayPath, errorMessage, fail, renderDiff, resolvePath, succeed, truncateText, withFileLock } from "../util"

function countOccurrences({ text, needle }: { text: string; needle: string }): number {
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count++
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

type EditPlan = { before: string; after: string; replacements: number }

/**
 * When `oldString` is not in the file as written, the two near misses a model makes most, each taken only when it names one place:
 * the file ends its lines with CRLF and the strings with LF (both are written with CRLF), or the lines differ only in trailing
 * spaces and tabs (the file's lines are replaced). Anything looser stays "not found".
 */
function nearMatch({ text, oldString, newString }: { text: string; oldString: string; newString: string }): { text: string; replacements: number } | undefined {
  if (text.includes("\r\n") && oldString.includes("\n") && !oldString.includes("\r")) {
    const crlf = (value: string) => value.replace(/\n/g, "\r\n")
    if (countOccurrences({ text, needle: crlf(oldString) }) === 1) return { text: text.replace(crlf(oldString), () => crlf(newString)), replacements: 1 }
  }
  const lines = text.split("\n")
  const wanted = oldString.split("\n").map((line) => line.replace(/[ \t\r]+$/, ""))
  if (!wanted.some((line) => line.trim())) return undefined
  const starts: number[] = []
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    if (wanted.every((line, k) => lines[start + k]!.replace(/[ \t\r]+$/, "") === line)) starts.push(start)
    if (starts.length > 1) return undefined
  }
  const at = starts[0]
  if (at === undefined) return undefined
  // New lines end the way the file's do; the last keeps what ended the last matched line (the file's final line may have no CR).
  const eol = lines[at]!.endsWith("\r") ? "\r" : ""
  const lastEol = lines[at + wanted.length - 1]!.endsWith("\r") ? "\r" : ""
  const replaced = newString.split("\n").map((line, k, all) => line.replace(/\r$/, "") + (k < all.length - 1 ? eol : lastEol))
  return { text: [...lines.slice(0, at), ...replaced, ...lines.slice(at + wanted.length)].join("\n"), replacements: 1 }
}

/** Computes the edit without writing; a string result is the error message. */
async function planEdit({
  abs,
  shown,
  oldString,
  newString,
  replaceAll,
}: {
  abs: string
  shown: string
  oldString: string
  newString: string
  replaceAll: boolean | undefined
}): Promise<EditPlan | string> {
  if (oldString === newString) return "oldString and newString are identical"
  const before = await readFile(abs, "utf8")
  const matches = countOccurrences({ text: before, needle: oldString })
  if (matches === 0) {
    const near = nearMatch({ text: before, oldString, newString })
    return near ? { before, after: near.text, replacements: near.replacements } : `oldString not found in ${shown}`
  }
  if (matches > 1 && !replaceAll) {
    return `oldString matches ${matches} times in ${shown}; add context to make it unique or set replaceAll`
  }
  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
  return { before, after, replacements: replaceAll ? matches : 1 }
}

export default defineTool({
  name: "edit",
  description:
    "Replace exact text in a file; fails when oldString is missing or matches more than once (unless replaceAll). Line endings and trailing spaces may differ if one place still matches.",
  permission: "write",
  args: z.object({
    path: z.string().describe("Absolute or project-relative path"),
    oldString: z.string().min(1).describe("Exact text to replace"),
    newString: z.string().describe("Replacement text"),
    replaceAll: z.boolean().optional().describe("Replace every occurrence"),
  }),
  async execute({ path, oldString, newString, replaceAll }, context) {
    const abs = resolvePath({ cwd: context.cwd, path })
    const shown = displayPath({ cwd: context.cwd, path: abs })
    const title = `Edit ${shown}`
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      // Read and write as one step per file: another session's edit in between would be overwritten.
      const planned = await withFileLock([abs], async () => {
        const plan = await planEdit({ abs, shown, oldString, newString, replaceAll })
        if (typeof plan !== "string") await atomicWrite({ path: abs, content: plan.after })
        return plan
      })
      if (typeof planned === "string") return fail({ title, message: planned })
      const capped = truncateText({ text: renderDiff({ before: planned.before, after: planned.after, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) }) })
      return succeed({
        title,
        output: capped.text,
        truncated: capped.truncated,
        meta: { path: abs, replacements: planned.replacements },
      })
    } catch (error) {
      return fail({ title, message: `cannot edit ${shown}: ${errorMessage(error)}` })
    }
  },
  async preview({ path, oldString, newString, replaceAll }, context) {
    try {
      const abs = resolvePath({ cwd: context.cwd, path })
      const planned = await planEdit({ abs, shown: displayPath({ cwd: context.cwd, path: abs }), oldString, newString, replaceAll })
      return typeof planned === "string" ? undefined : boundPreview(renderDiff({ before: planned.before, after: planned.after }))
    } catch {
      return undefined
    }
  },
})
