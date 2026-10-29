import { describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import path from "node:path"
import { read } from "../src"
import { MAX_INLINE_MEDIA_BYTES } from "../src/media"
import { makeContext, put, useTempDir } from "./helpers"

const tmp = useTempDir()
const media = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0]],
  ["image/jpeg", [0xff, 0xd8, 0xff, 0]],
  ["image/gif", [...Buffer.from("GIF89a"), 0]],
  ["image/webp", [...Buffer.from("RIFF0000WEBP"), 0]],
  ["application/pdf", [...Buffer.from("%PDF-1.7\n"), 0]],
] as const

describe("read multimedia parity", () => {
  test.each(media)("sniffs %s with an unrelated extension and returns actual bytes", async (mime, data) => {
    const cwd = tmp(), bytes = new Uint8Array(data)
    put({ root: cwd, path: "asset.dat", content: bytes })
    const result = await read.execute({ path: "asset.dat" }, makeContext({ cwd }))
    expect(result).toMatchObject({ isError: false, truncated: false, attachments: [{ mime, bytes, name: "asset.dat" }] })
    expect(result.output).toBe(mime === "application/pdf" ? "PDF read successfully" : "Image read successfully")
  })

  test("enforces the 5 MiB boundary and does not inline a binary merely named PDF", async () => {
    const cwd = tmp(), bytes = new Uint8Array(MAX_INLINE_MEDIA_BYTES + 1)
    bytes.set(Buffer.from("%PDF-"))
    put({ root: cwd, path: "large.pdf", content: bytes })
    expect(await read.execute({ path: "large.pdf" }, makeContext({ cwd }))).toMatchObject({ isError: true, output: expect.stringContaining("5 MiB") })
    put({ root: cwd, path: "exact.pdf", content: bytes.subarray(0, MAX_INLINE_MEDIA_BYTES) })
    expect((await read.execute({ path: "exact.pdf" }, makeContext({ cwd }))).attachments?.[0]?.bytes.length).toBe(MAX_INLINE_MEDIA_BYTES)
    put({ root: cwd, path: "fake.pdf", content: new Uint8Array([65, 0, 66]) })
    expect((await read.execute({ path: "fake.pdf" }, makeContext({ cwd }))).output).toContain("binary")
  })

  test("directories sort, distinguish directories and symlinks, and paginate by entries", async () => {
    const cwd = tmp()
    put({ root: cwd, path: "src/z.ts", content: "z" })
    mkdirSync(path.join(cwd, "src/a"))
    symlinkSync(path.join(cwd, "src/a"), path.join(cwd, "src/b"))
    const first = await read.execute({ path: "src", limit: 2 }, makeContext({ cwd }))
    expect(first).toMatchObject({ isError: false, truncated: true, meta: { entries: 2, total: 3 } })
    expect(first.output).toContain("a/\nb/")
    expect(first.output).toContain("offset=3")
    const last = await read.execute({ path: "src", offset: 3 }, makeContext({ cwd }))
    expect(last).toMatchObject({ truncated: false, output: expect.stringContaining("z.ts") })
  })

  test("bounds long lines and byte-heavy output with a usable continuation offset", async () => {
    const cwd = tmp()
    put({ root: cwd, path: "long.txt", content: `${"x".repeat(3000)}\n${("é".repeat(1500) + "\n").repeat(50)}` })
    const result = await read.execute({ path: "long.txt" }, makeContext({ cwd }))
    expect(result.truncated).toBe(true)
    expect(result.output).toContain("line truncated to 2000 chars")
    expect(result.output).toMatch(/use offset=\d+ to continue/)
    expect(Buffer.byteLength(result.output)).toBeLessThan(50_100)
  })

  test("loads nearby instructions once, with AGENTS priority and no repeated root policy", async () => {
    const cwd = tmp()
    put({ root: cwd, path: "AGENTS.md", content: "ROOT POLICY" })
    put({ root: cwd, path: "src/AGENTS.md", content: "SCOPED POLICY" })
    put({ root: cwd, path: "src/CLAUDE.md", content: "LOWER PRIORITY" })
    put({ root: cwd, path: "src/a.ts", content: "a" })
    put({ root: cwd, path: "src/b.ts", content: "b" })
    const ctx = { ...makeContext({ cwd }), loadedInstructions: new Set<string>() }
    const first = await read.execute({ path: "src/a.ts" }, ctx)
    expect(first.output).toContain("<system-reminder>")
    expect(first.output).toContain("SCOPED POLICY")
    expect(first.output).not.toContain("ROOT POLICY")
    expect(first.output).not.toContain("LOWER PRIORITY")
    expect(first.loadedInstructions).toHaveLength(1)
    expect((await read.execute({ path: "src/b.ts" }, ctx)).output).not.toContain("SCOPED POLICY")
  })

  test("aborted reads return a cancellation result without bytes", async () => {
    const cwd = tmp()
    put({ root: cwd, path: "shot.png", content: new Uint8Array(media[0][1]) })
    const result = await read.execute({ path: "shot.png" }, makeContext({ cwd, signal: AbortSignal.abort() }))
    expect(result).toMatchObject({ isError: true, output: "cancelled" })
    expect(result.attachments).toBeUndefined()
  })
})
