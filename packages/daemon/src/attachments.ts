import { opendir, stat } from "node:fs/promises"
import path from "node:path"
import { detectMediaMime, directoryEntries, MAX_INLINE_MEDIA_BYTES } from "@mendcode/tools/media"
import { TEXT_PUT_MAX_BYTES } from "@mendcode/protocol"

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** A non-image file pasted from outside the project is inlined as text up to this size. */
export const MAX_TEXT_ATTACHMENT_BYTES = 200 * 1024

/** Image types every supported model provider accepts, identified by magic bytes (not the extension). */
const SIGNATURES: Array<{ mime: string; test(bytes: Uint8Array): boolean }> = [
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { mime: "image/webp", test: (b) => String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP" },
]

/** Identifies a supported image by its bytes, not its extension or a tool's claimed type; `undefined` when none match. */
export function detectImageMime(bytes: Uint8Array): string | undefined {
  return SIGNATURES.find((signature) => signature.test(bytes))?.mime
}

/** Pixel size read from an image header (PNG, GIF, JPEG, WebP); `undefined` when the header is truncated or not recognised. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined)
  const mime = detectImageMime(bytes)
  if (mime === "image/png") return bytes.length >= 24 ? found(view.getUint32(16), view.getUint32(20)) : undefined
  if (mime === "image/gif") return bytes.length >= 10 ? found(view.getUint16(6, true), view.getUint16(8, true)) : undefined
  if (mime === "image/webp" && bytes.length >= 25) {
    const kind = String.fromCharCode(...bytes.subarray(12, 16))
    if (kind === "VP8X") return bytes.length < 30 ? undefined : found(1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)))
    if (kind === "VP8L") {
      const bits = view.getUint32(21, true)
      return found((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    if (kind === "VP8 ") return bytes.length < 30 ? undefined : found(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
    return undefined
  }
  if (mime === "image/jpeg") {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]!
      if (marker === 0xff) { offset++; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return found(view.getUint16(offset + 7), view.getUint16(offset + 5))
      offset += 2 + view.getUint16(offset + 2)
    }
  }
  return undefined
}

/** `undefined` when `bytes` is not valid UTF-8 (a byte-for-byte round trip, not just a non-throwing decode). */
function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

export class AttachmentError extends Error {
  constructor(message: string) {
    super(`[ATTACHMENT]: ${message}`)
    this.name = "AttachmentError"
  }
}

/** Terminals paste dropped files as quoted paths or with backslash-escaped spaces. */
export function normalizeDroppedPath(raw: string, home?: string) {
  let text = raw.trim()
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) text = text.slice(1, -1)
  else text = text.replace(/\\(.)/g, "$1")
  if (text.startsWith("file://")) text = decodeURIComponent(text.slice("file://".length))
  if (home && (text === "~" || text.startsWith("~/"))) text = path.join(home, text.slice(1))
  return text
}

/** Reads and validates a local image or PDF for attaching. */
export async function readAttachment(rawPath: string, options: { home?: string } = {}) {
  const file = normalizeDroppedPath(rawPath, options.home)
  if (!path.isAbsolute(file)) throw new AttachmentError(`path must be absolute: ${file}`)
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile()) throw new AttachmentError(`not a file: ${file}`)
  if (info.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`${path.basename(file)} is ${Math.round(info.size / 1_048_576)} MB; the limit is 20 MB`)
  const mime = detectMediaMime(new Uint8Array(await Bun.file(file).slice(0, 16).arrayBuffer()))
  if (!mime) throw new AttachmentError(`${path.basename(file)} is not a PNG, JPEG, GIF or WebP image or PDF`)
  const max = mime === "application/pdf" ? MAX_INLINE_MEDIA_BYTES : MAX_ATTACHMENT_BYTES
  if (info.size > max) throw new AttachmentError(`${path.basename(file)} exceeds the ${max / 1_048_576} MiB attachment limit`)
  const bytes = new Uint8Array(await Bun.file(file).slice(0, max + 1).arrayBuffer())
  if (bytes.length > max) throw new AttachmentError(`${path.basename(file)} exceeds the ${max / 1_048_576} MiB attachment limit`)
  return { bytes, mime, name: path.basename(file) }
}

/** Bytes a client sent (base64): the same type and size checks as `readAttachment`, without touching the file system. */
export function decodeAttachment(data: string | Uint8Array, name: string) {
  const bytes = typeof data === "string" ? new Uint8Array(Buffer.from(data, "base64")) : data
  const label = path.basename(name)
  const mime = detectMediaMime(bytes.subarray(0, 16))
  // A long paste the prompt keeps as a label: UTF-8 text, named `.txt`, that the engines put back in the message.
  if (!mime && label.endsWith(".txt")) {
    if (bytes.length > TEXT_PUT_MAX_BYTES) throw new AttachmentError(`${label} exceeds the ${TEXT_PUT_MAX_BYTES / 1_048_576} MiB text limit`)
    if (bytes.includes(0)) throw new AttachmentError(`${label} is not text`)
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { throw new AttachmentError(`${label} is not UTF-8 text`) }
    return { bytes, mime: "text/plain", name: label }
  }
  if (!mime) throw new AttachmentError(`${label} is not a PNG, JPEG, GIF or WebP image or PDF`)
  const max = mime === "application/pdf" ? MAX_INLINE_MEDIA_BYTES : MAX_ATTACHMENT_BYTES
  if (bytes.length > max) throw new AttachmentError(`${label} exceeds the ${max / 1_048_576} MiB attachment limit`)
  return { bytes, mime, name: label }
}

/** A project-relative path (including the root itself); undefined outside it. */
function relativeMention(directory: string, file: string): string | undefined {
  const rel = path.relative(directory, file)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined
  if (!rel) return "."
  return rel.split(path.sep).join("/")
}

export type PastedFile =
  | { kind: "image"; bytes: Uint8Array; mime: string; name: string }
  | { kind: "document"; bytes: Uint8Array; mime: "application/pdf"; name: string }
  | { kind: "mention"; path: string }
  | { kind: "text"; name: string; content: string; directory?: true }

/**
 * Classifies a local path pasted or dropped into the prompt. An image (by its bytes, checked first
 * regardless of location) resolves like `readAttachment`. A non-image file inside `directory` becomes
 * a `mention` (its project-relative path); elsewhere it is inlined as `text` when it is at most
 * `MAX_TEXT_ATTACHMENT_BYTES` and valid UTF-8.
 */
export async function resolvePastedPath(rawPath: string, options: { home?: string; directory?: string; allowDirectory?: boolean } = {}): Promise<PastedFile> {
  const file = normalizeDroppedPath(rawPath, options.home)
  if (!path.isAbsolute(file)) throw new AttachmentError(`path must be absolute: ${file}`)
  const info = await stat(file).catch(() => undefined)
  if (!info || (!info.isFile() && !info.isDirectory())) throw new AttachmentError(`not a file or directory: ${file}`)

  if (info.isDirectory()) {
    if (options.allowDirectory) {
      const entries: string[] = []
      for await (const entry of await opendir(file)) {
        entries.push(entry.name + (entry.isDirectory() ? "/" : ""))
        if (entries.length > 1000) throw new AttachmentError("directory attachment exceeds 1000 entries")
      }
      const content = `${file}\n${entries.sort().join("\n")}`
      if (Buffer.byteLength(content) > MAX_TEXT_ATTACHMENT_BYTES) throw new AttachmentError("directory attachment exceeds 200 KB")
      return { kind: "text", name: path.basename(file), content, directory: true }
    }
    const mention = options.directory ? relativeMention(options.directory, file) : undefined
    if (mention) return { kind: "mention", path: mention }
    const { entries, total, more } = await directoryEntries(file)
    const body = `<path>${file}</path>\n<type>directory</type>\n<entries>\n${entries.join("\n")}\n</entries>\n(${entries.length} of ${total} entries${more ? "; listing truncated" : ""})`
    const content = Buffer.byteLength(body) > MAX_TEXT_ATTACHMENT_BYTES ? `${Buffer.from(body).subarray(0, MAX_TEXT_ATTACHMENT_BYTES).toString("utf8")}\n[… listing byte limit reached]` : body
    return { kind: "text", name: path.basename(file), content, directory: true }
  }

  // A small head is enough to identify a supported image without reading a large non-image file whole.
  const head = new Uint8Array(await Bun.file(file).slice(0, 16).arrayBuffer())
  const mime = detectMediaMime(head)
  if (mime) {
    const max = mime === "application/pdf" ? MAX_INLINE_MEDIA_BYTES : MAX_ATTACHMENT_BYTES
    if (info.size > max) throw new AttachmentError(`${path.basename(file)} exceeds the ${max / 1_048_576} MiB attachment limit`)
    const bytes = new Uint8Array(await Bun.file(file).slice(0, max + 1).arrayBuffer())
    if (bytes.length > max) throw new AttachmentError(`${path.basename(file)} exceeds the ${max / 1_048_576} MiB attachment limit`)
    if (mime === "application/pdf") return { kind: "document", bytes, mime, name: path.basename(file) }
    return { kind: "image", bytes, mime, name: path.basename(file) }
  }

  if (options.directory) {
    const mention = relativeMention(options.directory, file)
    if (mention) return { kind: "mention", path: mention }
  }

  if (info.size > MAX_TEXT_ATTACHMENT_BYTES) throw new AttachmentError(`${path.basename(file)} is not a supported image and is larger than 200 KB`)
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const text = decodeUtf8Strict(bytes)
  if (text === undefined) throw new AttachmentError(`${path.basename(file)} is not a supported image and is not valid UTF-8 text`)
  return { kind: "text", name: path.basename(file), content: text }
}
