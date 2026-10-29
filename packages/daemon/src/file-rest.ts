import { open, opendir, realpath, stat } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FileSymbol, MAX_FRAME_BYTES, type FileContent, type FileNode, type FileRestInput, type FileSearchMatch, type FileStatus } from "@mendcode/protocol"
import { indexEntry, rankEntries } from "./file-score"
import { fileIgnore } from "./file-ignore"
import { FileApiError, fileProcess } from "./file-rest-process"
import { fileContentPatch } from "./file-rest-patch"

const MAX_FILE_BYTES = 120_000
const MAX_ENTRIES = 50_000
const inside = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
const imageMime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml", svgz: "image/svg+xml", avif: "image/avif", apng: "image/apng", jxl: "image/jxl", heic: "image/heic", heif: "image/heif" }
const imageExtensions = new Set([...Object.keys(imageMime), "raw", "cr2", "nef", "arw", "dng", "orf", "raf", "pef", "x3f"])
const binaryExtensions = new Set("exe dll pdb bin so dylib o a lib wav mp3 ogg oga ogv ogx flac aac wma m4a weba mp4 avi mov wmv flv webm mkv zip tar gz gzip bz bz2 bzip bzip2 7z rar xz lz z pdf doc docx ppt pptx xls xlsx dmg iso img vmdk ttf otf woff woff2 eot sqlite db mdb apk ipa aab xapk app pkg deb rpm snap flatpak appimage msi msp jar war ear class kotlin_module dex vdex odex oat art wasm wat bc ll s ko sys drv efi rom com".split(" "))

export async function projectPath(root: string, target: string) {
  if (target.includes("\0")) throw new FileApiError("Invalid file path")
  const full = path.resolve(root, target)
  if (!inside(full, root)) throw new FileApiError("Path outside project", "forbidden")
  // Resolve the nearest existing ancestor too: an absent child below an external symlink is still external.
  let probe = full
  for (;;) {
    const canonical = await realpath(probe).catch((error) => { if (missing(error)) return undefined; throw error })
    if (canonical) {
      const resolved = path.resolve(canonical, path.relative(probe, full))
      if (!inside(resolved, root)) throw new FileApiError("Symlink outside project", "forbidden")
      return { full, resolved }
    }
    const parent = path.dirname(probe)
    if (parent === probe) throw new FileApiError("Invalid project path")
    probe = parent
  }
}

async function bytesFor(root: string, target: string) {
  const { resolved } = await projectPath(root, target)
  const info = await stat(resolved).catch((error) => { if (missing(error)) return undefined; throw error })
  if (!info) return undefined
  if (!info.isFile()) throw new FileApiError("Path is not a regular file")
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => { if (missing(error)) return undefined; throw error })
  if (!handle) return undefined
  try {
    const current = await handle.stat()
    if (!current.isFile()) throw new FileApiError("Path is not a regular file")
    if (current.size > MAX_FILE_BYTES) throw new FileApiError("File exceeds 120000-byte limit")
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > MAX_FILE_BYTES) throw new FileApiError("File exceeds 120000-byte limit")
    return bytes.subarray(0, size)
  } finally { await handle.close() }
}

async function ignoredNodes(root: string, nodes: FileNode[], signal: AbortSignal) {
  if (nodes.length && Bun.which("git")) {
    const result = await fileProcess(["git", "-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-z", "--stdin"], root, signal, nodes.map((node) => node.path).join("\0") + "\0")
    if (result.code === 0 || result.code === 1) {
      const paths = new Set(result.stdout.split("\0").map((file) => file.replace(/\/$/, "")))
      for (const node of nodes) node.ignored = paths.has(node.path)
    }
  }
  const patterns = ((await bytesFor(root, ".ignore"))?.toString("utf8") ?? "").split(/\r?\n/).filter((line) => line && !line.startsWith("#"))
  for (const pattern of patterns) {
    const negate = pattern.startsWith("!")
    const ignored = fileIgnore([(negate ? pattern.slice(1) : pattern).replace(/^\//, "")])
    for (const node of nodes) if (ignored(node.path)) node.ignored = !negate
  }
}

async function list(root: string, target: string, signal: AbortSignal) {
  const { full, resolved } = await projectPath(root, target)
  const dir = await opendir(resolved).catch((error) => { if (missing(error)) return undefined; throw error })
  if (!dir) return []
  const nodes: FileNode[] = []
  try {
    for await (const entry of dir) {
      signal.throwIfAborted()
      if ([".git", ".DS_Store"].includes(entry.name)) continue
      if (nodes.length >= 2000) throw new FileApiError("Directory entry limit exceeded")
      const absolute = path.join(full, entry.name)
      let resolvedEntry: Awaited<ReturnType<typeof projectPath>>
      try { resolvedEntry = await projectPath(root, absolute) } catch (error) { if (error instanceof FileApiError && error.code === "forbidden") continue; throw error }
      const info = await stat(resolvedEntry.resolved).catch(() => undefined)
      if (!info || !info.isFile() && !info.isDirectory()) continue
      nodes.push({ name: entry.name, path: path.relative(root, absolute), absolute, type: info.isDirectory() ? "directory" : "file", ignored: false })
    }
  } catch (error) { if (missing(error)) return []; throw error }
  await ignoredNodes(root, nodes, signal)
  return nodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)
}

async function catalog(root: string, signal: AbortSignal) {
  if (!Bun.which("rg")) throw new FileApiError("ripgrep is not installed", "unsupported")
  const result = await fileProcess(["rg", "--no-config", "--files", "--hidden", "--glob=!.git/*", "--null", "."], root, signal)
  if (result.code !== 0 && result.code !== 1) throw new FileApiError("File search failed")
  const files = result.stdout.split("\0").filter(Boolean).map((file) => file.replace(/^\.\//, ""))
  if (files.length > MAX_ENTRIES) throw new FileApiError("File search entry limit exceeded")
  const safe: string[] = []
  for (const file of files) {
    signal.throwIfAborted()
    try { await projectPath(root, file); safe.push(file) } catch (error) { if (error instanceof FileApiError && error.code === "forbidden") continue; throw error }
  }
  return safe
}

async function read(root: string, target: string, signal: AbortSignal): Promise<FileContent> {
  await projectPath(root, target)
  const extension = path.extname(target).slice(1).toLowerCase()
  if (binaryExtensions.has(extension)) return { type: "binary", content: "" }
  const bytes = await bytesFor(root, target)
  if (!bytes) return { type: "text", content: "" }
  const mimeType = imageMime[extension] ?? (imageExtensions.has(extension) ? `image/${extension}` : Bun.file(path.resolve(root, target)).type)
  if (mimeType.startsWith("image/")) return { type: "text", content: bytes.toString("base64"), mimeType, encoding: "base64" }
  if (bytes.includes(0) || /^(audio|video|font|model|multipart)\//.test(mimeType)) return { type: "binary", content: "", ...(mimeType ? { mimeType } : {}) }
  const content = bytes.toString("utf8").trim()
  if (!Bun.which("git")) return { type: "text", content }
  const file = path.relative(root, path.resolve(root, target))
  const git = (args: string[], limit = 512_000) => fileProcess(["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "--literal-pathspecs", ...args], root, signal, undefined, limit)
  const args = ["--relative", "--no-color", "--no-ext-diff", "--no-textconv", "--unified=0", "--", file]
  let changed = await git(["diff", ...args])
  if (!changed.stdout.trim()) changed = await git(["diff", "--cached", ...args])
  if (changed.code !== 0 || !changed.stdout.trim()) return { type: "text", content }
  const prefix = await git(["rev-parse", "--show-prefix"])
  const original = await git(["show", `HEAD:${prefix.stdout.replace(/\n$/, "")}${file}`], MAX_FILE_BYTES)
  return { type: "text", content, ...fileContentPatch(file, original.code === 0 ? original.stdout : "", content) }
}

async function searchText(root: string, pattern: string, signal: AbortSignal): Promise<FileSearchMatch[]> {
  if (!Bun.which("rg")) throw new FileApiError("ripgrep is not installed", "unsupported")
  const result = await fileProcess(["rg", "--no-config", "--json", "--hidden", "--glob=!.git/*", "--no-messages", "--max-count=10", "--max-filesize=2000000", "--", pattern, "."], root, signal)
  if (![0, 1, 2].includes(result.code)) throw new FileApiError("Text search failed")
  if (result.code === 2 && !result.stdout) throw new FileApiError("Invalid text pattern or unreadable project")
  const matches: FileSearchMatch[] = []
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const row = JSON.parse(line)
    if (row.type !== "match" || typeof row.data?.path?.text !== "string" || typeof row.data?.lines?.text !== "string") continue
    const file = row.data.path.text.replace(/^\.\//, "")
    try { await projectPath(root, file) } catch (error) { if (error instanceof FileApiError && error.code === "forbidden") continue; throw error }
    matches.push({ ...row.data, path: { text: file } })
  }
  return matches
}

async function status(root: string, signal: AbortSignal): Promise<FileStatus[]> {
  if (!Bun.which("git")) return []
  const git = (args: string[]) => fileProcess(["git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], root, signal)
  if ((await git(["rev-parse", "--is-inside-work-tree"])).code !== 0) return []
  const base = (await git(["rev-parse", "--verify", "HEAD"])).code === 0 ? ["HEAD"] : ["--cached"]
  const [diff, deleted, untracked] = await Promise.all([
    git(["diff", ...base, "--relative", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", "--", "."]),
    git(["diff", ...base, "--relative", "--no-renames", "--name-only", "--diff-filter=D", "-z", "--", "."]),
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
  ])
  if ([diff, deleted, untracked].some((result) => result.code !== 0)) throw new FileApiError("Git status failed")
  const removed = new Set(deleted.stdout.split("\0"))
  const entries: FileStatus[] = diff.stdout.split("\0").filter(Boolean).map((row) => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row)
    if (!match) throw new FileApiError("Invalid Git status")
    return { path: match[3]!, added: removed.has(match[3]!) || match[1] === "-" ? 0 : Number(match[1]), removed: removed.has(match[3]!) || match[2] === "-" ? 0 : Number(match[2]), status: removed.has(match[3]!) ? "deleted" : "modified" }
  })
  for (const file of untracked.stdout.split("\0").filter(Boolean)) {
    signal.throwIfAborted()
    let bytes: Buffer | undefined
    try { bytes = await bytesFor(root, file) } catch (error) { if (error instanceof FileApiError && error.code === "forbidden") continue; throw error }
    if (bytes) entries.push({ path: file, added: bytes.toString("utf8").split("\n").length, removed: 0, status: "added" })
    if (entries.length > 2000) throw new FileApiError("Git status entry limit exceeded")
  }
  if (entries.length > 2000) throw new FileApiError("Git status entry limit exceeded")
  return entries
}

export async function readFileApi(input: { directory: string; input: FileRestInput; signal?: AbortSignal | undefined; symbols?: ((input: { cwd: string; query: string; signal?: AbortSignal }) => Promise<{ result: unknown[]; unavailable?: string | undefined }>) | undefined; frecency?: { score(root: string, file: string): number; opened(root: string, file: string): void } | undefined }) {
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
  const root = await realpath(input.directory)
  if (!(await stat(root)).isDirectory()) throw new FileApiError("Project path is not a directory")
  const query = input.input
  let value: unknown
  switch (query.operation) {
    case "file.list": value = await list(root, query.path, signal); break
    case "file.read": {
      value = await read(root, query.path, signal)
      if ((value as FileContent).type === "text" && (await stat(path.resolve(root, query.path)).catch(() => undefined))?.isFile()) input.frecency?.opened(root, query.path)
      break
    }
    case "file.status": value = await status(root, signal); break
    case "find.text": value = await searchText(root, query.pattern, signal); break
    case "find.files": {
      const files = await catalog(root, signal), dirs = new Set<string>()
      for (const file of files) {
        let dir = path.dirname(file)
        while (dir !== ".") { dirs.add(dir + "/"); dir = path.dirname(dir) }
      }
      const kind = query.type ?? (query.dirs === false ? "file" : "all"), limit = query.limit ?? 10
      const directories = [...dirs].sort()
      const hidden = (item: string) => item.split("/").some((part) => part.startsWith("."))
      const preferHidden = query.query.trim().startsWith(".") || query.query.trim().includes("/.")
      const sortHidden = (items: string[]) => preferHidden ? items : [...items.filter((item) => !hidden(item)), ...items.filter(hidden)]
      const items = kind === "file" ? files : kind === "directory" || !query.query.trim() ? directories : [...files, ...directories]
      const ranked = rankEntries(items.map((file) => indexEntry(file, file.endsWith("/") ? "dir" : "file")), query.query, kind === "directory" || !query.query.trim() ? MAX_ENTRIES : limit).map((entry) => entry.path)
      ranked.sort((a, b) => (input.frecency?.score(root, b) ?? 0) - (input.frecency?.score(root, a) ?? 0))
      value = (kind === "directory" || !query.query.trim() && kind !== "file" ? sortHidden(ranked) : ranked).slice(0, limit)
      break
    }
    case "find.symbols": {
      const report = input.symbols ? await input.symbols({ cwd: root, query: query.query, signal }) : { result: [] }
      if (report.unavailable) throw new FileApiError("Workspace symbol search failed")
      const symbols = []
      for (const item of report.result) {
        const parsed = FileSymbol.safeParse(item)
        if (!parsed.success || !parsed.data.location.uri.startsWith("file:")) continue
        let file: string
        try { file = fileURLToPath(parsed.data.location.uri) } catch { continue }
        try { await projectPath(root, file); symbols.push(parsed.data) } catch (error) { if (error instanceof FileApiError && error.code === "forbidden") continue; throw error }
      }
      value = symbols
      break
    }
  }
  signal.throwIfAborted()
  if (Buffer.byteLength(JSON.stringify({ value })) > MAX_FRAME_BYTES - 2048) throw new FileApiError("File API response limit exceeded")
  return { value }
}
