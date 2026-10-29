import { randomBytes } from "node:crypto"
import { mkdir, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { OUTPUT_LIMITS, type ToolResult } from "./tool"

type Meta = Record<string, string | number | boolean>

export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"])
export const BINARY_SNIFF_BYTES = 8192

export function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/** Path relative to cwd when inside it, otherwise the absolute path. */
export function displayPath({ cwd, path }: { cwd: string; path: string }): string {
  const rel = relative(cwd, path)
  if (rel === "") return "."
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path
  return rel
}

export function fail({ title, message }: { title: string; message: string }): ToolResult {
  return { output: message, truncated: false, title, isError: true }
}

export function succeed({
  title,
  output,
  meta,
  truncated = false,
}: {
  title: string
  output: string
  meta?: Meta
  truncated?: boolean
}): ToolResult {
  const result: ToolResult = { output, truncated, title, isError: false }
  if (meta) result.meta = meta
  return result
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return "no such file or directory"
    if (code === "EACCES" || code === "EPERM") return "permission denied"
    if (code === "EISDIR") return "is a directory"
    if (code === "ENOTDIR") return "not a directory"
    return error.message
  }
  return String(error)
}

const num = (n: number) => n.toLocaleString("en-US")

/** Longest prefix of `text` within maxBytes of UTF-8, never splitting a character. */
export function cutBytesFromStart({ text, maxBytes }: { text: string; maxBytes: number }): string {
  const buf = Buffer.from(text)
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

/** Longest suffix of `text` within maxBytes of UTF-8, never splitting a character. */
export function cutBytesFromEnd({ text, maxBytes }: { text: string; maxBytes: number }): string {
  const buf = Buffer.from(text)
  if (buf.length <= maxBytes) return text
  let start = buf.length - maxBytes
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++
  return buf.subarray(start).toString("utf8")
}

const countLines = (text: string) => (text === "" ? 0 : text.split("\n").length)

/** Keep the beginning of `text` within OUTPUT_LIMITS and append a one-line note. */
export function truncateText({
  text,
  limits = OUTPUT_LIMITS,
}: {
  text: string
  limits?: { maxBytes: number; maxLines: number }
}): { text: string; truncated: boolean } {
  const lines = text.split("\n")
  if (lines.length <= limits.maxLines && Buffer.byteLength(text) <= limits.maxBytes) {
    return { text, truncated: false }
  }
  const keptByLines = lines.slice(0, limits.maxLines).join("\n")
  const kept = cutBytesFromStart({ text: keptByLines, maxBytes: limits.maxBytes })
  const omittedLines = lines.length - countLines(kept)
  const note =
    omittedLines > 0
      ? `[output truncated: ${num(omittedLines)} more lines]`
      : `[output truncated: ${num(Buffer.byteLength(text) - Buffer.byteLength(kept))} more bytes]`
  return { text: `${kept}\n${note}`, truncated: true }
}

/** Keep the head (40%) and tail (60%) of `text`, with a marker in between. */
export function truncateHeadTail({
  text,
  limits = OUTPUT_LIMITS,
}: {
  text: string
  limits?: { maxBytes: number; maxLines: number }
}): { text: string; truncated: boolean } {
  const lines = text.split("\n")
  if (lines.length <= limits.maxLines && Buffer.byteLength(text) <= limits.maxBytes) {
    return { text, truncated: false }
  }
  const headLines = Math.floor(limits.maxLines * 0.4)
  const tailLines = Math.max(1, limits.maxLines - headLines - 1)
  const headBytes = Math.floor(limits.maxBytes * 0.4)
  const tailBytes = limits.maxBytes - headBytes
  if (lines.length <= headLines + tailLines) {
    const head = cutBytesFromStart({ text, maxBytes: headBytes })
    const tail = cutBytesFromEnd({ text, maxBytes: tailBytes })
    return { text: `${head}\n… output truncated …\n${tail}`, truncated: true }
  }
  const head = cutBytesFromStart({ text: lines.slice(0, headLines).join("\n"), maxBytes: headBytes })
  const tail = cutBytesFromEnd({ text: lines.slice(lines.length - tailLines).join("\n"), maxBytes: tailBytes })
  const omitted = Math.max(0, lines.length - countLines(head) - countLines(tail))
  const marker = omitted > 0 ? `… ${num(omitted)} lines omitted …` : "… output truncated …"
  return { text: `${head}\n${marker}\n${tail}`, truncated: true }
}

/**
 * Bounds of a directory walk a tool does itself (`glob`): the entries it may list and the time it may take before it returns
 * what it has. The same numbers as the daemon's file search fallback (`files-query.ts`: 50,000 entries, 5 s).
 */
export const WALK_LIMITS = { maxEntries: 50_000, budgetMs: 5_000 } as const

/** A file sample is binary with one NUL byte, or when more than this share of it is control bytes. */
const BINARY_CONTROL_SHARE = 0.3
/** Command output is binary when at least this share of its characters is NUL, other control characters or undecodable bytes. */
export const BINARY_OUTPUT_SHARE = 0.1

/** The first bytes of a file (`BINARY_SNIFF_BYTES`): not text when they hold a NUL or mostly control bytes. */
export function sampleIsBinary(sample: Uint8Array): boolean {
  if (sample.includes(0)) return true
  let control = 0
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control++
  return control > sample.length * BINARY_CONTROL_SHARE
}

/**
 * Characters of decoded command output that text does not hold: NUL, the C0 controls a terminal program has no use for, and
 * U+FFFD (a byte that was not UTF-8). Tab, newline, carriage return, backspace, bell, form feed and escape (colour codes,
 * progress bars) are text.
 */
export function countBinaryChars(text: string): number {
  let bad = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 0xfffd || (code < 32 && code !== 27 && (code < 7 || code > 13))) bad++
  }
  return bad
}

export const isBinaryShare = ({ bad, total }: { bad: number; total: number }) => total > 0 && bad >= total * BINARY_OUTPUT_SHARE

/** The one line the model gets in place of binary command output; undefined when `text` is text. */
export function binaryOutputNote({ text, bytes }: { text: string; bytes?: number }): string | undefined {
  if (!isBinaryShare({ bad: countBinaryChars(text), total: text.length })) return undefined
  return binaryNote(bytes === undefined ? `${num(text.length)} characters` : `${num(bytes)} bytes`)
}

export const binaryNote = (size: string) => `[binary output: ${size}; not shown. Use file, xxd | head, or strings to inspect it]`

/** "a/b/c: no such file or directory (nearest existing directory: a)" for a path that does not exist; undefined when it does. */
export async function missingPathMessage({ cwd, path }: { cwd: string; path: string }): Promise<string | undefined> {
  if (await exists(path)) return undefined
  let parent = dirname(path)
  while (parent !== dirname(parent) && !(await exists(parent))) parent = dirname(parent)
  return `${displayPath({ cwd, path })}: no such file or directory (nearest existing directory: ${displayPath({ cwd, path: parent })})`
}

export async function looksBinary(path: string): Promise<boolean> {
  const handle = await open(path, "r")
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/**
 * Write via a temp file in the same directory, then rename over the target. A symlink stays a link: the file it names is the
 * one replaced (permissions approve paths with their links resolved, so that is the file that was approved).
 */
export async function atomicWrite({ path: requested, content, mode: wanted }: { path: string; content: string; /** Permission bits for the file; by default an existing file keeps its own. */ mode?: number }): Promise<void> {
  const path = await realpath(requested).catch(() => requested)
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`)
  let mode: number | undefined = wanted
  try {
    mode ??= (await stat(path)).mode & 0o777
  } catch {
    mode = undefined
  }
  try {
    await writeFile(temp, content, mode === undefined ? undefined : { mode })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** The read-change-write running on each file (by real path), so two sessions editing one file take turns. */
const fileTurns = new Map<string, Promise<unknown>>()

/**
 * Runs `work` once no other `withFileLock` holds any of `paths` (resolved through symlinks), then lets the next one in. A file
 * read, changed and written inside it cannot lose a change another edit wrote in between. Paths are taken in sorted order.
 */
export async function withFileLock<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
  const keys = [...new Set(await Promise.all(paths.map((path) => realpath(path).catch(() => path))))].sort()
  const before = keys.map((key) => fileTurns.get(key) ?? Promise.resolve())
  const run = Promise.all(before.map((turn) => turn.catch(() => {}))).then(work)
  const settled = run.catch(() => {})
  for (const key of keys) fileTurns.set(key, settled)
  try {
    return await run
  } finally {
    for (const key of keys) if (fileTurns.get(key) === settled) fileTurns.delete(key)
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function isSkippedSegment(name: string): boolean {
  return SKIP_DIRS.has(name)
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("aborted", "AbortError")
}

export function cancelled(title: string): ToolResult {
  return fail({ title, message: "cancelled" })
}

export const PREVIEW_LIMITS = { maxLines: 200, maxBytes: 16 * 1024 } as const

/** Bound preview text to PREVIEW_LIMITS, ending with "… N more lines" when cut. */
export function boundPreview(text: string): string {
  const lines = text.split("\n")
  let bytes = 0
  let keep = 0
  while (keep < lines.length && keep < PREVIEW_LIMITS.maxLines) {
    bytes += Buffer.byteLength(lines[keep] as string) + 1
    if (bytes > PREVIEW_LIMITS.maxBytes) break
    keep++
  }
  if (keep >= lines.length) return text
  return `${lines.slice(0, keep).join("\n")}\n… ${(lines.length - keep).toLocaleString("en-US")} more lines`
}

/** Short unified-style diff: the changed line range with the common prefix/suffix trimmed. */
export function renderDiff({ before, after }: { before: string; after: string }): string {
  const a = before.split("\n")
  const b = after.split("\n")
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++
  }
  const removed = a.slice(prefix, a.length - suffix)
  const added = b.slice(prefix, b.length - suffix)
  const header = `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`
  return [header, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n")
}
