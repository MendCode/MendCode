import { constants } from "node:fs"
import { lstat, open, opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { FILE_VIEW_MAX_BYTES, FILE_VIEW_MAX_ENTRIES, FILE_VIEW_MAX_HITS, FILE_VIEW_MAX_LINE, FILE_VIEW_MAX_REPLY_BYTES, FILE_VIEW_MAX_ROWS, FILE_VIEW_MAX_SCAN, isHighlighted, lexEntry, redactSecrets, type FileView, type FileViewEntry, type FileViewKind } from "@mendcode/protocol"
import { projectPath } from "./file-rest"
import { FileApiError } from "./file-rest-process"

const DEFAULT_ROWS = 200
const SNIFF_BYTES = 8_000
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
/** Formats the viewer never opens as text, by extension (a NUL byte in the first 8 KB catches the rest). */
const BINARY = new Set("png jpg jpeg gif bmp webp ico tif tiff avif apng heic heif raw exe dll so dylib o a lib wav mp3 ogg flac aac m4a mp4 avi mov webm mkv zip tar gz bz2 7z rar xz pdf doc docx ppt pptx xls xlsx dmg iso ttf otf woff woff2 eot sqlite db jar class wasm".split(" "))

function mimeOf(file: string, binary: boolean) {
  const type = Bun.file(file).type.split(";")[0] ?? ""
  return type && type !== "text/plain" ? type : binary ? "application/octet-stream" : ""
}

/** Masks secrets the way diffs and tool output are; the window is redacted as one text so a key block spanning rows is caught. */
function redactRows(rows: string[]): { rows: string[]; count: number } {
  const whole = redactSecrets(rows.join("\n"))
  if (!whole.count) return { rows, count: 0 }
  const lines = whole.text.split("\n")
  if (lines.length === rows.length) return { rows: lines, count: whole.count }
  let count = 0
  return { rows: rows.map((row) => { const one = redactSecrets(row); count += one.count; return one.text }), count }
}

/** Lines of `lines` that hold `needle`: case-insensitive unless the needle has a capital. */
function searchLines(lines: string[], needle: string) {
  const fold = needle === needle.toLowerCase()
  const hits: number[] = []
  let total = 0
  for (let at = 0; at < lines.length; at++) {
    if (!(fold ? lines[at]!.toLowerCase() : lines[at]!).includes(needle)) continue
    total++
    if (hits.length < FILE_VIEW_MAX_HITS) hits.push(at + 1)
  }
  return { lines: hits, total }
}

/** A folder's entries for the viewer: folders first, then the rest, each by name; `.git` is left out, at most `FILE_VIEW_MAX_ENTRIES` are listed and `FILE_VIEW_MAX_SCAN` read. */
async function listFolder(folder: string, shown: string): Promise<FileView> {
  const base: FileView = { path: shown, kind: "directory", size: 0, version: "directory" }
  const found: Array<{ name: string; kind: FileViewEntry["kind"] }> = []
  let total = 0
  const dir = await opendir(folder)
  try {
    for await (const entry of dir) {
      if (entry.name === ".git") continue
      total++
      found.push({ name: entry.name, kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other" })
      if (total >= FILE_VIEW_MAX_SCAN) break
    }
  } finally {
    // Reading to the end closes the directory already; closing it again may throw, or return nothing, depending on the runtime.
    try { await dir.close() } catch { /* already closed */ }
  }
  const order = (a: string, b: string) => { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0 }
  found.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || order(a.name, b.name))
  const entries: FileViewEntry[] = await Promise.all(found.slice(0, FILE_VIEW_MAX_ENTRIES).map(async (entry): Promise<FileViewEntry> => {
    if (entry.kind !== "file") return entry
    const size = await lstat(path.join(folder, entry.name)).then((info) => info.size, () => undefined)
    return size === undefined ? entry : { ...entry, size }
  }))
  return { ...base, entries, entriesTotal: total }
}

/**
 * One window of a project file for the terminal's file viewer (`file.view`, docs/file-viewer.md). Read-only and bounded:
 * a path outside the project (or a symlink out of it) is `outside` and never read, a device, pipe or socket is `special` and never
 * opened, a file over `FILE_VIEW_MAX_BYTES` is `large` and not read, a binary file is described by size and type, and a text file
 * answers `count` lines from `from` with secrets masked. `known` (a `version`) answers `unchanged` without reading the file.
 */
export async function viewFile(input: { directory: string; path: string; from?: number | undefined; count?: number | undefined; search?: string | undefined; known?: string | undefined; lang?: string | undefined }): Promise<FileView> {
  const root = await realpath(input.directory).catch(() => { throw new FileApiError("Project path is not a directory") })
  const answer = (kind: FileViewKind, shown: string, extra: Partial<FileView> = {}): FileView => ({ path: shown, kind, size: 0, version: kind, ...extra })
  let resolved: string
  let full: string
  try {
    ;({ full, resolved } = await projectPath(root, input.path))
  } catch (error) {
    if (error instanceof FileApiError && error.code === "forbidden") return answer("outside", input.path)
    throw error
  }
  const shown = path.relative(root, full).split(path.sep).join("/") || "."
  // Git's own files hold remotes with credentials and hooks; the viewer is for the working tree.
  if ([shown, path.relative(root, resolved)].some((value) => value.split(/[\\/]/).includes(".git"))) return answer("outside", shown)
  const info = await stat(resolved).catch((error) => { if (missing(error)) return undefined; throw error })
  if (!info) return answer("missing", shown)
  if (info.isDirectory()) return listFolder(resolved, shown).catch(() => answer("directory", shown))
  if (!info.isFile()) return answer("special", shown)
  const version = `${info.size}:${Math.round(info.mtimeMs)}`
  const base = { size: info.size, version }
  if (input.known === version) return { path: shown, kind: "text", ...base, unchanged: true }
  const extension = path.extname(shown).slice(1).toLowerCase()
  if (BINARY.has(extension)) return { path: shown, kind: "binary", ...base, mime: mimeOf(resolved, true) }
  if (info.size > FILE_VIEW_MAX_BYTES) return { path: shown, kind: "large", ...base }
  // O_NONBLOCK and O_NOFOLLOW: a FIFO swapped in after the stat cannot hang the daemon, and a symlink swapped in cannot leave the project.
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => { if (missing(error)) return undefined; throw error })
  if (!handle) return answer("missing", shown)
  let bytes: Buffer
  try {
    const current = await handle.stat()
    if (!current.isFile()) return answer("special", shown)
    bytes = await handle.readFile()
  } finally { await handle.close() }
  if (bytes.byteLength > FILE_VIEW_MAX_BYTES) return { path: shown, kind: "large", ...base, size: bytes.byteLength }
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return { path: shown, kind: "binary", ...base, size: bytes.byteLength, mime: mimeOf(resolved, true) }
  const text = bytes.toString("utf8")
  const all = text.length === 0 ? [] : text.split("\n")
  if (all.length && all.at(-1) === "") all.pop()
  const total = all.length
  const from = Math.min(Math.max(1, input.from ?? 1), Math.max(1, total))
  const wanted = Math.min(input.count ?? DEFAULT_ROWS, FILE_VIEW_MAX_ROWS)
  let cut = 0
  let budget = FILE_VIEW_MAX_REPLY_BYTES
  const picked: string[] = []
  // The lines above the window, as the terminal will see them (CR dropped, long lines cut), lexed by the highlighter itself: a block comment, a
  // triple-quoted string or a Markdown fence opened above `from` is still open in the first row. Only asked for with the language, and only worth sending when something is open.
  const lex = input.lang && from > 1 && isHighlighted(input.lang) ? lexEntry(all.slice(0, from - 1).map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line).slice(0, FILE_VIEW_MAX_LINE)), input.lang) : undefined
  for (const line of all.slice(from - 1, from - 1 + wanted)) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line
    const shortened = clean.length > FILE_VIEW_MAX_LINE ? (cut++, clean.slice(0, FILE_VIEW_MAX_LINE)) : clean
    budget -= Buffer.byteLength(JSON.stringify(shortened)) + 1
    if (budget < 0 && picked.length > 0) break
    picked.push(shortened)
  }
  const masked = redactRows(picked)
  return {
    path: shown, kind: "text", ...base, size: bytes.byteLength, lines: total, from, rows: masked.rows,
    ...(cut ? { cut } : {}), ...(masked.count ? { redacted: masked.count } : {}), ...(lex && Object.keys(lex).length ? { lex } : {}),
    ...(input.search ? { hits: searchLines(all, input.search) } : {}),
  }
}
