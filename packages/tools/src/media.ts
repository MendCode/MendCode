import { readdir, stat } from "node:fs/promises"
import path from "node:path"

export const MAX_INLINE_MEDIA_BYTES = 5 * 1024 * 1024
export type MediaMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf"
export type MediaAttachment = { mime: MediaMime; bytes: Uint8Array; name?: string }

/** Sniff supported inline media before testing for binary text; extensions never decide the type. */
export function detectMediaMime(bytes: Uint8Array): MediaMime | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  const head = String.fromCharCode(...bytes.subarray(0, 5))
  if (head.startsWith("GIF8")) return "image/gif"
  if (head.startsWith("RIFF") && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp"
  if (head === "%PDF-") return "application/pdf"
  return undefined
}

/** Sorted immediate entries, including a trailing slash on directories and symlinks to directories. */
export async function directoryEntries(directory: string, offset = 1, limit = 2000, maxBytes = Infinity) {
  const all = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
  const selected = all.slice(offset - 1, offset - 1 + limit)
  const resolved = await Promise.all(selected.map(async (entry) => {
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path.join(directory, entry.name)).catch(() => undefined))?.isDirectory())
    return entry.name + (isDirectory ? "/" : "")
  }))
  const entries: string[] = []
  let bytes = 0
  for (const entry of resolved) {
    bytes += Buffer.byteLength(entry) + 1
    if (bytes > maxBytes) break
    entries.push(entry)
  }
  return { entries, total: all.length, more: offset - 1 + entries.length < all.length }
}
