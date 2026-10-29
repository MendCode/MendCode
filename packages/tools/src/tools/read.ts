import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { z } from "zod"
import { defineTool, OUTPUT_LIMITS, type ToolContext, type ToolResult } from "../tool"
import { detectMediaMime, directoryEntries, MAX_INLINE_MEDIA_BYTES, type MediaAttachment } from "../media"
import { readInstructions } from "../read-instructions"
import { displayPath, errorMessage, fail, missingPathMessage, resolvePath, sampleIsBinary, succeed, truncateText } from "../util"

const DEFAULT_LIMIT = 2000
const MAX_LINE_LENGTH = 2000

/**
 * Most paths one call may name. The bounds on what comes back are the two budgets all of them share (each entry also keeps the
 * single-file caps): once either is spent, the paths left are named and not read.
 */
export const MAX_READ_PATHS = 64
const MULTI_READ_BUDGET_BYTES = 120_000
const MULTI_READ_MEDIA_BUDGET_BYTES = 16 * MAX_INLINE_MEDIA_BYTES

/**
 * The lines of a text stream (`\n`, `\r\n` or `\r` ends one, as readline splits them), each cut to its first `keep` characters
 * plus whether it was longer. Only that prefix is held: a log or JSON of hundreds of MB on one line costs `keep` characters.
 */
export async function* boundedLines(stream: AsyncIterable<string | Buffer>, keep: number): AsyncGenerator<{ text: string; long: boolean }> {
  let text = ""
  let long = false
  let open = false
  let carriageReturn = false
  for await (const chunk of stream) {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    let from = 0
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i)
      if (code !== 10 && code !== 13) continue
      // The `\n` of a `\r\n` cut between two chunks ends nothing more.
      if (code === 10 && carriageReturn && i === from && !open) {
        carriageReturn = false
        from = i + 1
        continue
      }
      const piece = data.slice(from, i)
      if (!long) {
        text += piece.slice(0, keep + 1 - text.length)
        if (text.length > keep) long = true
      }
      yield { text: long ? text.slice(0, keep) : text, long }
      text = ""
      long = false
      open = false
      carriageReturn = code === 13
      if (code === 13 && data.charCodeAt(i + 1) === 10) {
        i++
        carriageReturn = false
      }
      from = i + 1
    }
    if (from < data.length) {
      carriageReturn = false
      open = true
      if (!long) {
        text += data.slice(from, from + keep + 1 - text.length)
        if (text.length > keep) long = true
      }
    } else if (from === data.length && data.length > 0 && data.charCodeAt(data.length - 1) !== 13) carriageReturn = false
  }
  if (open) yield { text: long ? text.slice(0, keep) : text, long }
}

const entry = z.object({
  path: z.string().describe("Absolute or project-relative path"),
  offset: z.number().int().min(1).optional().describe("1-based line to start from"),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines"),
})
type ReadEntry = z.infer<typeof entry>
// An entry of `paths` has the same keys as the call: their descriptions are sent once, on the top-level ones.
const pathsEntry = z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() })

async function readOne({ path, offset, limit }: ReadEntry, context: ToolContext): Promise<ToolResult> {
    const abs = resolvePath({ cwd: context.cwd, path })
    const shown = displayPath({ cwd: context.cwd, path: abs })
    const title = `Read ${shown}`
    if (context.signal.aborted) return fail({ title, message: "cancelled" })
    try {
      const info = await stat(abs)
      if (info.isDirectory()) {
        const { entries, total, more } = await directoryEntries(abs, offset ?? 1, Math.min(limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT), 45_000)
        const capped = truncateText({ text: `<path>${abs}</path>\n<type>directory</type>\n<entries>\n${entries.join("\n")}\n</entries>`, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
        return succeed({ title, output: `${capped.text}\n(${entries.length} of ${total} entries${more ? `; use offset=${(offset ?? 1) + entries.length} to continue` : ""})`, truncated: more || capped.truncated, meta: { path: abs, entries: entries.length, total } })
      }
      if (!info.isFile()) return fail({ title, message: `${shown} is not a regular file` })
      const stored = context.readStoredFile?.(abs)
      const sample = stored ? stored.subarray(0, 8192) : new Uint8Array(await Bun.file(abs).slice(0, 8192).arrayBuffer())
      const mime = detectMediaMime(sample)
      if (mime) {
        if ((stored?.length ?? info.size) > MAX_INLINE_MEDIA_BYTES) return fail({ title, message: `${shown} exceeds the 5 MiB inline media limit` })
        const bytes = stored ?? new Uint8Array(await Bun.file(abs).slice(0, MAX_INLINE_MEDIA_BYTES + 1).arrayBuffer())
        if (context.signal.aborted) return fail({ title, message: "cancelled" })
        if (bytes.length > MAX_INLINE_MEDIA_BYTES) return fail({ title, message: `${shown} exceeds the 5 MiB inline media limit` })
        const instructions = await readInstructions(abs, context)
        return { ...succeed({ title, output: (mime === "application/pdf" ? "PDF read successfully" : "Image read successfully") + instructions.text, meta: { path: abs, mime, bytes: bytes.length } }), attachments: [{ mime, bytes, name: basename(abs) }], ...(instructions.loaded.length ? { loadedInstructions: instructions.loaded } : {}) }
      }
      if (sampleIsBinary(sample)) return fail({ title, message: `${shown} is a binary file (${(stored?.length ?? info.size).toLocaleString("en-US")} bytes); not shown. Use shell with file, xxd | head, or strings to inspect it` })
      const start = (offset ?? 1) - 1
      const stream = stored ? Readable.from([Buffer.from(stored).toString("utf8")]) : createReadStream(abs, { encoding: "utf8", signal: context.signal })
      const numbered: string[] = []
      let count = 0, bytes = 0, cut = false
      try {
        for await (const raw of boundedLines(stream, MAX_LINE_LENGTH)) {
          count++
          if (count <= start || numbered.length >= Math.min(limit ?? DEFAULT_LIMIT, context.outputLimits ? 100000 : DEFAULT_LIMIT)) continue
          const line = raw.long ? `${raw.text}... (line truncated to ${MAX_LINE_LENGTH} chars)` : raw.text
          const value = `${String(count).padStart(6)}\t${line}`
          const size = Buffer.byteLength(value) + 1
          if (bytes + size > (context.outputLimits ? 8 * 1024 * 1024 : OUTPUT_LIMITS.maxBytes)) { cut = true; break }
          numbered.push(value)
          bytes += size
        }
      } finally {
        stream.destroy()
      }
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      if (start > 0 && start >= count) return fail({ title, message: `offset ${offset} is beyond the end of the file (${count} lines)` })
      let body = numbered.join("\n")
      const remaining = count - start - numbered.length
      const capped = truncateText({ text: body, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      body = capped.text
      if (cut) body += `\n[output capped at ${context.outputLimits ? "8 MB" : "50 KB"}; use offset=${start + numbered.length + 1} to continue]`
      else if (remaining > 0 && !capped.truncated) {
        body += `\n[output truncated: ${remaining.toLocaleString("en-US")} more lines]`
      }
      const instructions = await readInstructions(abs, context)
      return { ...succeed({
        title,
        output: body + instructions.text,
        truncated: capped.truncated || cut || remaining > 0,
        meta: { path: abs, lines: numbered.length },
      }), ...(instructions.loaded.length ? { loadedInstructions: instructions.loaded } : {}) }
    } catch (error) {
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      return fail({ title, message: `cannot read ${(await missingPathMessage({ cwd: context.cwd, path: abs })) ?? `${shown}: ${errorMessage(error)}`}` })
    }
}

export default defineTool({
  name: "read",
  description:
    "Read files or directories: text with 1-based line numbers (2000 lines unless `limit`, lines cut at 2000 characters), sorted directory entries, images and PDFs inline up to 5 MiB; binary files are refused. For several files pass `paths` (up to 64) in one call, not one read per file.",
  permission: "read",
  args: z.object({
    path: entry.shape.path.optional(),
    offset: entry.shape.offset,
    limit: entry.shape.limit,
    paths: z.array(pathsEntry).min(1).max(MAX_READ_PATHS).optional().describe("Several paths in one call, instead of path"),
  }),
  async execute({ paths, ...single }, context) {
    if (paths === undefined) {
      if (single.path === undefined) return fail({ title: "Read", message: "read needs `path` or `paths`" })
      return readOne({ ...single, path: single.path }, context)
    }
    if (single.path !== undefined) return fail({ title: "Read", message: "give `path` or `paths`, not both" })
    const sections: string[] = []
    const attachments: MediaAttachment[] = []
    const loaded = new Set<string>()
    let spent = 0, attached = 0, failed = 0, truncated = false
    for (const [index, item] of paths.entries()) {
      if (context.signal.aborted) return fail({ title: "Read", message: "cancelled" })
      const shownOf = (entry: ReadEntry) => displayPath({ cwd: context.cwd, path: resolvePath({ cwd: context.cwd, path: entry.path }) })
      const used = spent >= MULTI_READ_BUDGET_BYTES
        ? `returned ${MULTI_READ_BUDGET_BYTES.toLocaleString("en-US")} bytes`
        : attached >= MULTI_READ_MEDIA_BUDGET_BYTES ? `attached ${MULTI_READ_MEDIA_BUDGET_BYTES / (1024 * 1024)} MiB of media` : undefined
      if (used) {
        const rest = paths.slice(index)
        sections.push(`[not read: this call already ${used}; read the remaining ${rest.length} path${rest.length === 1 ? "" : "s"} in another call]\n${rest.map(shownOf).join("\n")}`)
        truncated = true
        break
      }
      const result = await readOne(item, context)
      if (result.isError) failed++
      truncated ||= result.truncated
      spent += Buffer.byteLength(result.output)
      for (const attachment of result.attachments ?? []) attached += attachment.bytes.length
      attachments.push(...(result.attachments ?? []))
      for (const name of result.loadedInstructions ?? []) loaded.add(name)
      sections.push(`=== ${shownOf(item)} ===\n${result.output}`)
    }
    const title = `Read ${paths.length} files`
    const output = sections.join("\n\n")
    if (failed === paths.length) return fail({ title, message: output })
    return { ...succeed({ title, output, truncated, meta: { files: paths.length, failed } }), ...(attachments.length ? { attachments } : {}), ...(loaded.size ? { loadedInstructions: [...loaded] } : {}) }
  },
})
