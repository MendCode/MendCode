import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expandMentions, MAX_MENTION_FILE_BYTES, MAX_MENTION_TOTAL_BYTES, resolveMentionPath, resolveMentions, MAX_MENTION_MEDIA, MAX_MENTION_PATHS } from "../src/mentions"
import { MAX_INLINE_MEDIA_BYTES } from "@mendcode/tools/media"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "mentions-"))
  dirs.push(dir)
  return dir
}

describe("resolveMentionPath", () => {
  test("resolves a relative path inside the root", () => {
    const root = project()
    expect(resolveMentionPath(root, "src/app.ts")).toBe(path.join(root, "src/app.ts"))
  })

  test("refuses a path that escapes the root, however it is spelled", () => {
    const root = project()
    expect(resolveMentionPath(root, "../../etc/passwd")).toBeUndefined()
    expect(resolveMentionPath(root, "../sibling")).toBeUndefined()
    expect(resolveMentionPath(root, "a/../../b")).toBeUndefined()
    expect(resolveMentionPath(root, "/etc/passwd")).toBeUndefined()
  })
})

describe("expandMentions", () => {
  test("line-range mentions select inclusive lines and reject invalid ranges", async () => {
    const root = project()
    writeFileSync(path.join(root, "notes.md"), "one\ntwo\nthree\nfour\n")
    const result = await resolveMentions("@notes.md?start=2&end=3", root)
    expect(result.text).toContain("     2\ttwo")
    expect(result.text).toContain("     3\tthree")
    expect(result.text).not.toContain("     1\tone")
    expect(result.text).not.toContain("     4\tfour")
    expect(await resolveMentions("@notes.md?start=3&end=1", root)).toEqual({ text: "@notes.md?start=3&end=1", attachments: [] })
  })

  test("mentions load nearby instructions once and malformed quoted input stays literal", async () => {
    const root = project(), claims = new Set<string>()
    mkdirSync(path.join(root, "src"))
    writeFileSync(path.join(root, "src/AGENTS.md"), "SCOPED POLICY")
    writeFileSync(path.join(root, "src/a.ts"), "a")
    writeFileSync(path.join(root, "src/b.ts"), "b")
    const first = await resolveMentions("@src/a.ts @src/b.ts", root, undefined, claims)
    expect(first.loadedInstructions).toHaveLength(1)
    expect(first.text.split("SCOPED POLICY")).toHaveLength(2)
    expect((await resolveMentions("@src/a.ts", root, undefined, claims)).text).not.toContain("SCOPED POLICY")
    expect(await resolveMentions('@"bad\\q"', root)).toEqual({ text: '@"bad\\q"', attachments: [] })
  })

  test("media still attaches when the independent text budget is exhausted", async () => {
    const root = project(), names = ["a.txt", "b.txt", "c.txt"]
    for (const name of names) writeFileSync(path.join(root, name), "x".repeat(MAX_MENTION_FILE_BYTES))
    writeFileSync(path.join(root, "spec.pdf"), "%PDF-1.7\n")
    expect((await resolveMentions([...names.map((n) => `@${n}`), "@spec.pdf"].join(" "), root)).attachments).toHaveLength(1)
  })
  test("image and PDF mentions carry bytes separately, including quoted paths and deduplication", async () => {
    const root = project()
    writeFileSync(path.join(root, "shot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))
    writeFileSync(path.join(root, "design notes.dat"), Buffer.from("%PDF-1.7\n"))
    const result = await resolveMentions('@shot.png @"design notes.dat" @shot.png', root)
    expect(result.attachments.map((a) => [a.mime, a.name])).toEqual([["image/png", "shot.png"], ["application/pdf", "design notes.dat"]])
    expect(result.text).toContain('kind="pdf"')
    expect(result.text).not.toContain("binary file skipped")
    expect(result.text).not.toContain("%PDF")
  })

  test("oversized multimedia and excess media are noted without reading their bytes", async () => {
    const root = project(), large = new Uint8Array(MAX_INLINE_MEDIA_BYTES + 1)
    large.set(Buffer.from("%PDF-"))
    writeFileSync(path.join(root, "big.pdf"), large)
    const names = Array.from({ length: MAX_MENTION_MEDIA + 1 }, (_, i) => `doc-${i}.pdf`)
    for (const name of names) writeFileSync(path.join(root, name), "%PDF-1.7\n")
    const result = await resolveMentions(["@big.pdf", ...names.map((n) => `@${n}`)].join(" "), root)
    expect(result.attachments).toHaveLength(MAX_MENTION_MEDIA)
    expect(result.attachments.some((a) => a.name === "big.pdf")).toBe(false)
    expect(result.text.split("inline media limit reached")).toHaveLength(3)
  })

  test("symlinks escaping the project are never inlined, for files and directories", async () => {
    const root = project(), outside = project()
    writeFileSync(path.join(outside, "private.txt"), "DO NOT READ")
    symlinkSync(path.join(outside, "private.txt"), path.join(root, "link.txt"))
    symlinkSync(outside, path.join(root, "outside"))
    expect(await resolveMentions("@link.txt @outside", root)).toEqual({ text: "@link.txt @outside", attachments: [] })
  })

  test("bounds the number of paths and honors cancellation", async () => {
    const root = project()
    const names = Array.from({ length: MAX_MENTION_PATHS + 1 }, (_, i) => `f-${i}.txt`)
    for (const name of names) writeFileSync(path.join(root, name), "x")
    const input = names.map((n) => `@${n}`).join(" ")
    expect((await resolveMentions(input, root)).text).toContain("1 mentions skipped")
    expect(await resolveMentions(input.slice(0, input.indexOf(" ")), root, AbortSignal.abort())).toEqual({ text: "@f-0.txt", attachments: [] })
  })
  test("text without @ tokens is returned unchanged", async () => {
    const root = project()
    expect(await expandMentions("no mentions here", root)).toBe("no mentions here")
  })

  test("appends a delimited block with the file's content, keeping the original text", async () => {
    const root = project()
    writeFileSync(path.join(root, "notes.md"), "hello world")
    const out = await expandMentions("check @notes.md please", root)
    expect(out.startsWith("check @notes.md please\n\n")).toBe(true)
    expect(out).toContain('<mention path="notes.md" kind="file">')
    expect(out).toContain("hello world")
  })

  test("a mentioned directory becomes a bounded listing", async () => {
    const root = project()
    mkdirSync(path.join(root, "src"))
    writeFileSync(path.join(root, "src", "a.ts"), "a")
    writeFileSync(path.join(root, "src", "b.ts"), "b")
    const out = await expandMentions("look at @src", root)
    expect(out).toContain('<mention path="src" kind="dir">')
    expect(out).toContain("a.ts")
    expect(out).toContain("b.ts")
  })

  test("@../../etc/passwd is never read: the mention is dropped, the literal text stays", async () => {
    const root = project()
    const out = await expandMentions("read @../../etc/passwd now", root)
    expect(out).toBe("read @../../etc/passwd now")
  })

  test("an absolute path mention is never read", async () => {
    const root = project()
    const out = await expandMentions("read @/etc/passwd now", root)
    expect(out).toBe("read @/etc/passwd now")
  })

  test("a missing path is left as plain text", async () => {
    const root = project()
    const out = await expandMentions("see @does/not/exist.ts", root)
    expect(out).toBe("see @does/not/exist.ts")
  })

  test("a binary file is noted, not embedded", async () => {
    const root = project()
    writeFileSync(path.join(root, "image.bin"), new Uint8Array([0, 1, 2, 3, 0, 5]))
    const out = await expandMentions("@image.bin", root)
    expect(out).toContain("binary file skipped")
    expect(out).not.toContain("\x00")
  })

  test("a file over the per-file cap is truncated with a note", async () => {
    const root = project()
    writeFileSync(path.join(root, "big.txt"), "x".repeat(MAX_MENTION_FILE_BYTES + 500))
    const out = await expandMentions("@big.txt", root)
    expect(out).toContain(`truncated at ${MAX_MENTION_FILE_BYTES} bytes`)
    // The embedded block itself never exceeds the per-file cap (plus a short trailing note).
    const block = out.slice(out.indexOf('<mention path="big.txt"'))
    expect(block.length).toBeLessThan(MAX_MENTION_FILE_BYTES + 200)
  })

  test("the total across every mention in one message is bounded", async () => {
    const root = project()
    const names = ["one.txt", "two.txt", "three.txt", "four.txt"]
    for (const name of names) writeFileSync(path.join(root, name), "y".repeat(MAX_MENTION_FILE_BYTES))
    const out = await expandMentions(names.map((n) => `@${n}`).join(" "), root)
    const embeddedBytes = names.filter((n) => out.includes(`<mention path="${n}" kind="file">\ny`)).length * MAX_MENTION_FILE_BYTES
    expect(embeddedBytes).toBeLessThanOrEqual(MAX_MENTION_TOTAL_BYTES)
    expect(out).toContain("budget exhausted")
  })

  test("the same token mentioned twice is only read and appended once", async () => {
    const root = project()
    writeFileSync(path.join(root, "once.ts"), "content")
    const out = await expandMentions("@once.ts and again @once.ts", root)
    expect(out.split('<mention path="once.ts"').length - 1).toBe(1)
  })

  test("an @ mid-word (not a mention) is ignored", async () => {
    const root = project()
    writeFileSync(path.join(root, "x.ts"), "x")
    const out = await expandMentions("email me@x.ts about it", root)
    expect(out).toBe("email me@x.ts about it")
  })
})
