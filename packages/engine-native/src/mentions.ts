import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { detectMediaMime, directoryEntries, MAX_INLINE_MEDIA_BYTES, type MediaAttachment } from "@mendcode/tools/media"
import { cutBytesFromStart, read, readInstructions, type InstructionOptions } from "@mendcode/tools"

/** Per file, and in total across a message's mentions — keeps a turn's extra context bounded (mirrors project-instructions.ts). */
export const MAX_MENTION_FILE_BYTES = 100 * 1024
export const MAX_MENTION_TOTAL_BYTES = 300 * 1024
export const MAX_MENTION_DIR_ENTRIES = 200
export const MAX_MENTION_PATHS = 32
export const MAX_MENTION_MEDIA = 4
export const MAX_MENTION_MEDIA_BYTES = MAX_MENTION_MEDIA * MAX_INLINE_MEDIA_BYTES

/** `@token`: a leading `@` at the start of the text or after whitespace, followed by non-whitespace. */
const MENTION_RE = /(?:^|\s)@(?:("(?:\\.|[^"\\])*")|'([^']+)'|(\S+))/g

function isBinary(bytes: Uint8Array) {
  return bytes.subarray(0, 8_000).includes(0)
}

/**
 * `token` resolved under `root`. `undefined` when it would read outside `root` (a leading `/`, `~`, or
 * enough `..` segments to escape) — that path is never touched, not even to check whether it exists.
 */
export function resolveMentionPath(root: string, token: string): string | undefined {
  if (path.isAbsolute(token) || token === "~" || token.startsWith("~/")) return undefined
  const base = path.resolve(root)
  const absolute = path.resolve(base, token)
  const rel = path.relative(base, absolute)
  if (rel === "..") return undefined
  if (rel.startsWith(`..${path.sep}`)) return undefined
  if (path.isAbsolute(rel)) return undefined
  return absolute
}

async function fileBlock(token: string, absolute: string, size: number, budget: number): Promise<{ block: string; bytes: number }> {
  const cap = Math.max(0, Math.min(MAX_MENTION_FILE_BYTES, budget))
  if (cap <= 0) return { block: `<mention path="${token}" kind="file">\n[skipped: mention byte budget exhausted]\n</mention>`, bytes: 0 }
  const bytes = new Uint8Array(await Bun.file(absolute).slice(0, cap).arrayBuffer())
  if (isBinary(bytes)) return { block: `<mention path="${token}" kind="file">\n[binary file skipped, ${size} bytes]\n</mention>`, bytes: 0 }
  const text = new TextDecoder().decode(bytes)
  const body = size > cap ? `${text}\n[… truncated at ${cap} bytes of ${size}]` : text
  return { block: `<mention path="${token}" kind="file">\n${body}\n</mention>`, bytes: bytes.byteLength }
}

/**
 * Appends resolved `@path` mentions (files and directories inside `root`) to `text` as delimited blocks,
 * keeping the original text unchanged. Bounded per file (100 KB) and in total (300 KB); binary files are
 * noted, not read. A path outside `root`, missing or otherwise unreadable is left as plain text — the
 * model still sees the literal `@token`, it just gets no attached content.
 */
export async function resolveMentions(text: string, root: string, signal?: AbortSignal, claims = new Set<string>(), instructions?: InstructionOptions): Promise<{ text: string; attachments: MediaAttachment[]; loadedInstructions?: string[] }> {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_RE)) {
    let token: string
    try { token = match[1] ? JSON.parse(match[1]) as string : match[2] ?? match[3]! } catch { continue }
    if (!seen.has(token)) {
      seen.add(token)
      tokens.push(token)
    }
  }
  if (tokens.length === 0) return { text, attachments: [] }

  const blocks: string[] = []
  const attachments: MediaAttachment[] = []
  const loadedInstructions: string[] = []
  let budget = MAX_MENTION_TOTAL_BYTES
  let mediaBudget = MAX_MENTION_MEDIA_BYTES
  const canonicalRoot = await realpath(root).catch(() => path.resolve(root))
  const context = { cwd: canonicalRoot, signal: signal ?? new AbortController().signal, loadedInstructions: claims, ...(instructions ? { instructions } : {}) }
  const appendInstructions = async (file: string) => {
    const instructions = await readInstructions(file, context, budget)
    if (instructions.loaded.length) {
      loadedInstructions.push(...instructions.loaded)
      blocks.push(instructions.text.trim())
      budget -= Buffer.byteLength(instructions.text)
    }
  }
  for (const rawToken of tokens.slice(0, MAX_MENTION_PATHS)) {
    if (signal?.aborted) break
    const token = rawToken.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
    const range = /^(.*)\?start=(\d+)(?:&end=(\d+))?$/.exec(rawToken)
    const offset = range ? Number(range[2]) : undefined
    const end = range?.[3] ? Number(range[3]) : undefined
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1 || end !== undefined && (!Number.isSafeInteger(end) || end < offset))) continue
    const absolute = resolveMentionPath(root, range?.[1] ?? rawToken)
    if (!absolute) continue
    try {
      const canonical = await realpath(absolute)
      const rel = path.relative(canonicalRoot, canonical)
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue
      const info = await stat(canonical)
      if (!info.isDirectory() && !info.isFile()) continue
      if (info.isDirectory()) {
        if (budget <= 0) { blocks.push(`<mention path="${token}" kind="dir">\n[skipped: mention byte budget exhausted]\n</mention>`); continue }
        const { entries, total } = await directoryEntries(canonical, 1, MAX_MENTION_DIR_ENTRIES)
        const raw = entries.join("\n")
        const body = cutBytesFromStart({ text: raw, maxBytes: Math.min(budget, MAX_MENTION_FILE_BYTES) })
        budget -= Buffer.byteLength(body)
        blocks.push(`<mention path="${token}" kind="dir">\n${body}${entries.length < total ? `\n… ${total - entries.length} more entries` : ""}${body.length < raw.length ? "\n[… listing byte limit reached]" : ""}\n</mention>`)
        continue
      }
      const head = new Uint8Array(await Bun.file(canonical).slice(0, 16).arrayBuffer())
      const mime = detectMediaMime(head)
      if (mime) {
        const kind = mime === "application/pdf" ? "pdf" : "image"
        if (info.size > MAX_INLINE_MEDIA_BYTES || info.size > mediaBudget || attachments.length >= MAX_MENTION_MEDIA) {
          blocks.push(`<mention path="${token}" kind="${kind}">\n[skipped: inline media limit reached (5 MiB per file, 4 files / 20 MiB per message)]\n</mention>`)
          continue
        }
        const bytes = new Uint8Array(await Bun.file(canonical).slice(0, Math.min(MAX_INLINE_MEDIA_BYTES, mediaBudget) + 1).arrayBuffer())
        if (bytes.length > MAX_INLINE_MEDIA_BYTES || bytes.length > mediaBudget) continue
        attachments.push({ mime, bytes, name: path.basename(canonical) })
        mediaBudget -= bytes.length
        blocks.push(`<mention path="${token}" kind="${kind}">\n${kind === "pdf" ? "PDF" : "Image"} read successfully\n</mention>`)
        await appendInstructions(canonical)
        continue
      }
      if (budget > 0 && offset !== undefined) {
        const result = await read.execute({ path: canonical, offset, ...(end !== undefined ? { limit: end - offset + 1 } : {}) }, context)
        const body = cutBytesFromStart({ text: result.output, maxBytes: Math.min(budget, MAX_MENTION_FILE_BYTES) })
        blocks.push(`<mention path="${token}" kind="file">\n${body}${body.length < result.output.length ? "\n[… mention byte limit reached]" : ""}\n</mention>`)
        budget -= Buffer.byteLength(body)
        loadedInstructions.push(...result.loadedInstructions ?? [])
        continue
      }
      const result = await fileBlock(token, canonical, info.size, budget)
      blocks.push(result.block)
      budget -= result.bytes
      if (result.bytes) await appendInstructions(canonical)
    } catch {
      continue
    }
  }
  if (tokens.length > MAX_MENTION_PATHS) blocks.push(`[${tokens.length - MAX_MENTION_PATHS} mentions skipped: limit ${MAX_MENTION_PATHS}]`)
  return { text: blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text, attachments, ...(loadedInstructions.length ? { loadedInstructions } : {}) }
}

/** Text-only compatibility entrypoint; engines use resolveMentions to persist the multimedia refs too. */
export async function expandMentions(text: string, root: string): Promise<string> {
  return (await resolveMentions(text, root)).text
}
