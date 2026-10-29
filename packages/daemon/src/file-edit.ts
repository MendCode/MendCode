import { constants } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { lstat, open, realpath, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { FileEditInput, FileEditResult } from "@mendcode/protocol"
import { projectPath } from "./file-rest"
import { FileApiError } from "./file-rest-process"

const MAX_BYTES = 120_000
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

function ensureText(bytes: Buffer) {
  try {
    if (bytes.includes(0)) throw new Error("binary")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch { throw new FileApiError("File is not UTF-8 text and cannot be edited") }
}

/** Exact bytes of a regular, non-symlink file inside the project, or undefined when absent. */
async function current(resolved: string) {
  const info = await lstat(resolved).catch((error) => { if (missing(error)) return undefined; throw error })
  if (!info) return undefined
  if (!info.isFile()) throw new FileApiError("Path is not a regular file")
  if (info.size > MAX_BYTES) throw new FileApiError("File exceeds 120000-byte limit")
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAX_BYTES) throw new FileApiError("File exceeds 120000-byte limit")
    return { bytes, mode: info.mode & 0o777 }
  } finally { await handle.close() }
}

/**
 * Browser editor backend. Paths follow the file API rules (inside the project, no external symlinks) and `.git` is never touched.
 * A write needs the sha256 returned by the last read (null for a new file), so edits made by the agent or another tab are never overwritten silently.
 */
export async function editFile(input: { directory: string; input: FileEditInput }): Promise<FileEditResult> {
  const root = await realpath(input.directory)
  const { full, resolved } = await projectPath(root, input.input.path)
  const relative = path.relative(root, full)
  if (!relative || relative.startsWith("..")) throw new FileApiError("Path is not a project file")
  if ([relative, path.relative(root, resolved)].some((value) => value.split(path.sep).includes(".git"))) throw new FileApiError("Git internals are not editable", "forbidden")
  const existing = await current(resolved)
  const sha256 = existing ? digest(existing.bytes) : null
  if (input.input.operation === "read") {
    const content = existing ? ensureText(existing.bytes) : ""
    return { path: relative, content, sha256, bytes: existing?.bytes.byteLength ?? 0 }
  }
  if (existing) ensureText(existing.bytes)
  if (input.input.expected !== sha256) throw new FileApiError("File changed on disk; reload before saving")
  const bytes = Buffer.from(input.input.content, "utf8")
  if (bytes.byteLength > MAX_BYTES) throw new FileApiError("Content exceeds 120000-byte limit")
  if (bytes.includes(0)) throw new FileApiError("Content is not text")
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.mend-${randomBytes(6).toString("hex")}.tmp`)
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: existing?.mode ?? 0o644 })
    await rename(temporary, resolved)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    if (missing(error)) throw new FileApiError("Parent directory does not exist")
    throw new FileApiError("File write failed")
  }
  return { path: relative, sha256: digest(bytes), bytes: bytes.byteLength }
}
