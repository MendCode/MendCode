import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AttachmentError, decodeAttachment, imageDimensions, MAX_TEXT_ATTACHMENT_BYTES, normalizeDroppedPath, readAttachment, resolvePastedPath } from "../src/attachments"
import { MAX_INLINE_MEDIA_BYTES } from "@mendcode/tools/media"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

describe("attachments", () => {
  test("R7 sent bytes get the same type check as a path and never touch the file system", () => {
    const sent = decodeAttachment(Buffer.from(PNG).toString("base64"), "/etc/some/dir/shot.png")
    expect(sent).toMatchObject({ mime: "image/png", name: "shot.png" })
    expect(sent.bytes).toEqual(PNG)
    expect(() => decodeAttachment(Buffer.from("just text").toString("base64"), "notes.png")).toThrow(AttachmentError)
  })

  test("dropped paths are unquoted, unescaped and expanded", () => {
    expect(normalizeDroppedPath("'/tmp/My Shot.png'")).toBe("/tmp/My Shot.png")
    expect(normalizeDroppedPath("/tmp/My\\ Shot.png ")).toBe("/tmp/My Shot.png")
    expect(normalizeDroppedPath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png")
    expect(normalizeDroppedPath("~/x.png", "/Users/me")).toBe("/Users/me/x.png")
  })

  test("images are identified by their bytes, not the extension", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    const real = path.join(dir, "shot one.png")
    writeFileSync(real, PNG)
    const fake = path.join(dir, "notes.png")
    writeFileSync(fake, "just text")
    const ok = await readAttachment(real.replaceAll(" ", "\\ "))
    expect(ok).toMatchObject({ mime: "image/png", name: "shot one.png" })
    await expect(readAttachment(fake)).rejects.toThrow("not a PNG, JPEG, GIF or WebP image")
    await expect(readAttachment(path.join(dir, "missing.png"))).rejects.toBeInstanceOf(AttachmentError)
    await expect(readAttachment("relative.png")).rejects.toThrow("must be absolute")
  })
})

describe("resolvePastedPath", () => {
  test("PDF is sniffed before text, inside and outside a project, independent of extension", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    const file = path.join(dir, "spec.dat"), bytes = Buffer.from("%PDF-1.7\n")
    writeFileSync(file, bytes)
    for (const directory of [dir, path.join(dir, "other")]) {
      expect(await resolvePastedPath(file, { directory })).toMatchObject({ kind: "document", mime: "application/pdf", name: "spec.dat", bytes: new Uint8Array(bytes) })
    }
    expect(await readAttachment(file)).toMatchObject({ mime: "application/pdf", name: "spec.dat" })
  })

  test("PDFs over 5 MiB are rejected by both paste and add", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    const file = path.join(dir, "big.pdf"), bytes = new Uint8Array(MAX_INLINE_MEDIA_BYTES + 1)
    bytes.set(Buffer.from("%PDF-"))
    writeFileSync(file, bytes)
    await expect(resolvePastedPath(file)).rejects.toThrow("5 MiB")
    await expect(readAttachment(file)).rejects.toThrow("5 MiB")
  })

  test("external directories inline a sorted listing; a nested project directory stays a mention", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    mkdirSync(path.join(dir, "a"))
    writeFileSync(path.join(dir, "z.txt"), "z")
    expect(await resolvePastedPath(dir, { directory: path.join(dir, "a") })).toMatchObject({ kind: "text", content: expect.stringContaining("a/\nz.txt") })
    expect(await resolvePastedPath(path.join(dir, "a"), { directory: dir })).toEqual({ kind: "mention", path: "a" })
  })
  test("an image is always an attachment, even inside the project", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    const file = path.join(dir, "shot.png")
    writeFileSync(file, PNG)
    const resolved = await resolvePastedPath(file, { directory: dir })
    expect(resolved).toMatchObject({ kind: "image", mime: "image/png", name: "shot.png" })
  })

  test("a non-image file inside the project directory becomes a mention", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    const nested = path.join(dir, "sub")
    mkdirSync(nested)
    const nestedFile = path.join(nested, "notes.ts")
    writeFileSync(nestedFile, "export const x = 1\n")
    const resolved = await resolvePastedPath(nestedFile, { directory: dir })
    expect(resolved).toEqual({ kind: "mention", path: "sub/notes.ts" })
  })

  test("a non-image file outside the project is inlined as text when it is small and UTF-8", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"))
    dirs.push(outside)
    const file = path.join(outside, "log.txt")
    writeFileSync(file, "hola mundo\n")
    const resolved = await resolvePastedPath(file, { directory: dir })
    expect(resolved).toEqual({ kind: "text", name: "log.txt", content: "hola mundo\n" })
  })

  test("without a directory, a non-image file is inlined as text directly", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    const file = path.join(dir, "readme.md")
    writeFileSync(file, "# hi\n")
    expect(await resolvePastedPath(file)).toEqual({ kind: "text", name: "readme.md", content: "# hi\n" })
  })

  test("a non-image file outside the project larger than 200 KB is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"))
    dirs.push(outside)
    const file = path.join(outside, "big.txt")
    writeFileSync(file, "x".repeat(MAX_TEXT_ATTACHMENT_BYTES + 1))
    await expect(resolvePastedPath(file)).rejects.toThrow("larger than 200 KB")
  })

  test("a non-image, non-UTF-8 file outside the project is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"))
    dirs.push(outside)
    const file = path.join(outside, "binary.dat")
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]))
    await expect(resolvePastedPath(file)).rejects.toThrow("not valid UTF-8")
  })

  test("a project directory becomes a mention", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "attach-"))
    dirs.push(dir)
    expect(await resolvePastedPath(dir, { directory: dir })).toEqual({ kind: "mention", path: "." })
  })
})

describe("imageDimensions", () => {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const le16 = (n: number) => [n & 255, n >> 8]
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]

  test("reads PNG, GIF, JPEG and WebP (extended, lossless, lossy) headers", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(1440), ...be32(900)])
    expect(imageDimensions(png)).toEqual({ width: 1440, height: 900 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(320), ...le16(200)])
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 200 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0, 0, 0, 0])
    expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480 })
    const riff = (kind: string, body: number[]) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...Buffer.from(kind), 0, 0, 0, 0, ...body])
    expect(imageDimensions(riff("VP8X", [0, 0, 0, 0, ...le24(1999), ...le24(999)]))).toEqual({ width: 2000, height: 1000 })
    const lossless = 99 | (49 << 14)
    expect(imageDimensions(riff("VP8L", [0x2f, lossless & 255, (lossless >> 8) & 255, (lossless >> 16) & 255, (lossless >>> 24) & 255]))).toEqual({ width: 100, height: 50 })
    expect(imageDimensions(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(64), ...le16(48)]))).toEqual({ width: 64, height: 48 })
  })

  test("a truncated or unrecognised header yields undefined", () => {
    expect(imageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeUndefined()
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeUndefined()
  })
})
