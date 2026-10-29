import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { viewFile } from "../../../packages/daemon/src/file-view"
import { cleanTemps, type Harness } from "./session-ui-harness"
import { chat, longSource, LONG_KINDS, settle, type LongKind } from "./file-viewer-helpers"

afterEach(cleanTemps)

const KINDS = Object.keys(LONG_KINDS) as LongKind[]

/** The spans painted for the row that holds `needle` in the last frame, trimmed of the gutter and the padding. */
function painted(h: Harness, needle: string) {
  const row = (h.frames.at(-1) ?? []).find((line) => line.map((span) => span.text).join("").includes(needle))
  if (!row) throw new Error(`[TEST]: "${needle}" is not painted`)
  // The code of the row: not the border of the slot, not the line number.
  return row.filter((span) => (needle.includes(span.text) && span.text.trim() !== "" || span.text.includes(needle)) && span.fg !== "border" && !/^\s*\d+ $/.test(span.text))
}

async function open(kind: LongKind, stripLex = false) {
  const ctx = await chat({ width: 160, height: 45, stripLex })
  writeFileSync(path.join(ctx.dir, LONG_KINDS[kind].file), longSource(kind))
  await ctx.h.type(`/open ${LONG_KINDS[kind].file}:3000\r`)
  await settle()
  ctx.h.app.render()
  return ctx
}

describe("a window below something opened above it", () => {
  test("a block comment opened at line 10 is drawn as a comment at line 3,000 (TS and Rust)", async () => {
    for (const kind of ["ts", "rust"] as const) {
      const { h } = await open(kind)
      const spans = painted(h, LONG_KINDS[kind].inside)
      expect(spans.length).toBeGreaterThan(0)
      expect(spans.every((span) => span.fg === "synComment")).toBe(true)
    }
  })

  test("a triple-quoted string opened at line 10 is drawn as a string at line 3,000 (Python)", async () => {
    const { h } = await open("py")
    const spans = painted(h, LONG_KINDS.py.inside)
    expect(spans.length).toBeGreaterThan(0)
    expect(spans.every((span) => span.fg === "synString")).toBe(true)
  })

  test("a fenced block opened at line 10 is drawn as code at line 3,000 (Markdown)", async () => {
    const { h } = await open("md")
    const keyword = painted(h, "const").find((span) => span.text.trim() === "const")
    expect(keyword?.fg).toBe("synKeyword")
    const comment = painted(h, "// a fenced line")
    expect(comment.some((span) => span.fg === "synComment")).toBe(true)
  })

  test("without the daemon's state the same window is drawn as plain code, which is what the test proves it guards", async () => {
    const { h } = await open("ts", true)
    const spans = painted(h, "insideComment")
    expect(spans.some((span) => span.fg === "synComment" && span.text.includes("insideComment"))).toBe(false)
  })

  test("the client asked for a window, never for the whole file", async () => {
    const { h } = await open("ts")
    const reads = h.sentOf("file.view") as Array<{ from?: number; count?: number }>
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read.count ?? 200).toBeLessThanOrEqual(400)
  })

  test("the daemon says what is open at the first row, and nothing for a window at the top", async () => {
    const { dir } = await chat({ width: 100, height: 30 })
    writeFileSync(path.join(dir, "long.ts"), longSource("ts"))
    const deep = await viewFile({ directory: dir, path: "long.ts", from: 2_990, count: 20, lang: "ts" })
    expect(deep.lex).toEqual({ block: true })
    const top = await viewFile({ directory: dir, path: "long.ts", from: 1, count: 20, lang: "ts" })
    expect(top.lex).toBeUndefined()
    const after = await viewFile({ directory: dir, path: "long.ts", from: 3_600, count: 20, lang: "ts" })
    expect(after.lex).toBeUndefined()
  })

  test("the carried state is exact for each language", async () => {
    const { dir } = await chat({ width: 100, height: 30 })
    for (const kind of KINDS) {
      writeFileSync(path.join(dir, LONG_KINDS[kind].file), longSource(kind))
      const lang = kind === "rust" ? "rust" : kind
      const inside = await viewFile({ directory: dir, path: LONG_KINDS[kind].file, from: 2_990, count: 20, lang })
      const lex = inside.lex ?? {}
      expect(kind === "ts" || kind === "rust" ? lex.block : kind === "py" ? lex.triple : lex.fence).toBeTruthy()
      const outside = await viewFile({ directory: dir, path: LONG_KINDS[kind].file, from: 4_000, count: 20, lang })
      expect(outside.lex).toBeUndefined()
    }
  })

  test("a window asked for with an unknown language gets no state and costs no scan", async () => {
    const { dir } = await chat({ width: 100, height: 30 })
    writeFileSync(path.join(dir, "long.ts"), longSource("ts"))
    const none = await viewFile({ directory: dir, path: "long.ts", from: 2_990, count: 20, lang: "text" })
    expect(none.lex).toBeUndefined()
  })
})
