import { readFile } from "node:fs/promises"
import { z } from "zod"
import { defineTool } from "../tool"
import { atomicWrite, boundPreview, DIFF_CONTEXT_LINES, displayPath, errorMessage, fail, renderDiff, resolvePath, succeed, truncateText, withFileLock } from "../util"

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

/** Most replacements one call may carry in `edits`. */
export const MAX_EDITS = 50

type Replacement = { oldString: string; newString: string; replaceAll?: boolean | undefined }

/** One replacement on `text` as earlier ones left it; a string result is the error message. */
function replaceOne({ text, shown, edit }: { text: string; shown: string; edit: Replacement }): { after: string; replacements: number } | string {
  const { oldString, newString, replaceAll } = edit
  if (oldString === newString) return "oldString and newString are identical"
  const matches = countOccurrences({ text, needle: oldString })
  if (matches === 0) {
    const near = nearMatch({ text, oldString, newString })
    return near ? { after: near.text, replacements: near.replacements } : `oldString not found in ${shown}`
  }
  if (matches > 1 && !replaceAll) {
    return `oldString matches ${matches} times in ${shown}; add context to make it unique or set replaceAll`
  }
  const after = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
  return { after, replacements: replaceAll ? matches : 1 }
}

/**
 * Computes every replacement in order on one read of the file, without writing; a string result is the error message. Each one
 * sees the text the previous ones left, and the first that fails stops the call before anything is written.
 */
async function planEdit({ abs, shown, edits }: { abs: string; shown: string; edits: Replacement[] }): Promise<EditPlan | string> {
  const before = await readFile(abs, "utf8")
  let after = before
  let replacements = 0
  for (const [index, edit] of edits.entries()) {
    const step = replaceOne({ text: after, shown, edit })
    if (typeof step === "string") return edits.length > 1 ? `edit ${index + 1} of ${edits.length}: ${step}; nothing was written` : step
    after = step.after
    replacements += step.replacements
  }
  return { before, after, replacements }
}

const Args = z.object({
  path: z.string().describe("Absolute or project-relative path"),
  oldString: z.string().min(1).optional().describe("Exact text to replace"),
  newString: z.string().optional().describe("Replacement text"),
  replaceAll: z.boolean().optional().describe("Replace every occurrence"),
  // More pairs, applied in order after the top-level one. An entry has the same keys as the call, described once on the top-level ones,
  // and `replaceAll` covers every entry: every key and description is paid on each request.
  edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string() })).min(1).max(MAX_EDITS).optional(),
})

/** The replacements a call asks for: the top-level pair first when given, then `edits`, all under `replaceAll`; a string is what is missing. */
function replacementsOf(args: z.infer<typeof Args>): Replacement[] | string {
  const single = args.oldString !== undefined || args.newString !== undefined
  if (single && (args.oldString === undefined || args.newString === undefined)) return "oldString and newString go together"
  if (!single && !args.edits) return "edit needs oldString and newString, or edits"
  const pairs = [...(single ? [{ oldString: args.oldString!, newString: args.newString! }] : []), ...(args.edits ?? [])]
  return pairs.map((pair) => ({ ...pair, replaceAll: args.replaceAll }))
}

export default defineTool({
  name: "edit",
  description:
    "Replace exact text in a file; fails unless oldString matches once (or replaceAll). CRLF and trailing spaces may differ if one place still matches.",
  permission: "write",
  args: Args,
  async execute(args, context) {
    const abs = resolvePath({ cwd: context.cwd, path: args.path })
    const shown = displayPath({ cwd: context.cwd, path: abs })
    const title = `Edit ${shown}`
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    const edits = replacementsOf(args)
    if (typeof edits === "string") return fail({ title, message: edits })
    try {
      // Read and write as one step per file: another session's edit in between would be overwritten.
      const planned = await withFileLock([abs], async () => {
        const plan = await planEdit({ abs, shown, edits })
        if (typeof plan !== "string") await atomicWrite({ path: abs, content: plan.after })
        return plan
      })
      if (typeof planned === "string") return fail({ title, message: planned })
      const limits = context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}
      const capped = truncateText({ text: renderDiff({ before: planned.before, after: planned.after }), ...limits })
      // The card shows the unchanged lines around the change; the model is told the change alone.
      const framed = truncateText({ text: renderDiff({ before: planned.before, after: planned.after, context: DIFF_CONTEXT_LINES }), ...limits })
      return {
        ...succeed({
          title,
          output: capped.text,
          truncated: capped.truncated,
          meta: { path: abs, replacements: planned.replacements, ...(edits.length > 1 ? { edits: edits.length } : {}) },
        }),
        display: framed.text,
      }
    } catch (error) {
      return fail({ title, message: `cannot edit ${shown}: ${errorMessage(error)}` })
    }
  },
  async preview(args, context) {
    try {
      const edits = replacementsOf(args)
      if (typeof edits === "string") return undefined
      const abs = resolvePath({ cwd: context.cwd, path: args.path })
      const planned = await planEdit({ abs, shown: displayPath({ cwd: context.cwd, path: abs }), edits })
      return typeof planned === "string" ? undefined : boundPreview(renderDiff({ before: planned.before, after: planned.after }))
    } catch {
      return undefined
    }
  },
})
