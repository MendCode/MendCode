import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps } from "./session-ui-harness"
import { chat, click, frame, settle, slot, type Setup } from "./file-viewer-helpers"

afterEach(cleanTemps)

const folder = async (target: string, setup: Setup = {}) => {
  const ctx = await chat({ text: "nothing to see here", ...setup })
  await ctx.h.type(`/open ${target}\r`)
  await settle()
  ctx.h.app.render()
  return ctx
}
const viewed = (h: Awaited<ReturnType<typeof chat>>["h"]) => (h.sentOf("file.view") as Array<{ path: string }>).map((read) => read.path)

describe("a folder in the viewer", () => {
  test("/open on a folder lists it: the way up, folders first, files with their sizes, and the count in the header", async () => {
    const { h } = await folder("src")
    const text = frame(h)
    expect(text).toContain("‹ src/ · 2 entries")
    const rows = slot(h)
    const up = rows.findIndex((row) => row.includes(".."))
    const dir = rows.findIndex((row) => row.includes("files/"))
    const file = rows.findIndex((row) => row.includes("app.rs"))
    expect(up).toBeGreaterThanOrEqual(0)
    expect(up).toBeLessThan(dir)
    expect(dir).toBeLessThan(file)
    expect(rows[file]).toMatch(/\d(\.\d)? KB/)
    expect(text).toContain("a ask · y copy")
    expect(text).not.toMatch(/\bo open\b/)
  })

  test("the root lists without a way up, and .git is not in it", async () => {
    const ctx = await folder(".")
    mkdirSync(path.join(ctx.dir, ".git"))
    await ctx.h.type("/open .\r")
    await settle()
    ctx.h.app.render()
    const rows = slot(ctx.h).join("\n")
    expect(rows).toContain("src/")
    expect(rows).toContain("AGENTS.md")
    expect(rows).not.toContain(".git")
    expect(rows).not.toMatch(/^\s*▎? *\.\.\s*$/m)
  })

  test("a click on a folder row enters it, on .. goes up, on a file opens it at the top", async () => {
    const { h } = await folder("src")
    await click(h, "files/")
    expect(frame(h)).toContain("‹ src/files/ · 1 entry")
    await click(h, "..")
    expect(frame(h)).toContain("‹ src/ · 2 entries")
    await click(h, "app.rs")
    expect(frame(h)).toContain("‹ app.rs · 200 lines")
    expect(viewed(h).at(-1)).toBe("src/app.rs")
  })

  test("a folder named in the chat opens as a listing on a click", async () => {
    const { h } = await chat({ text: "look in ./src/files please" })
    await click(h, "./src/files")
    expect(frame(h)).toContain("‹ src/files/ · 1 entry")
    expect(frame(h)).toContain("link.rs")
  })

  test("the keys: j and k move, enter opens, backspace goes up, and from a file back to its folder", async () => {
    const { h } = await folder("src", { profile: { viewerFocus: true } })
    const marked = () => slot(h).find((row) => row.includes("▎"))!
    expect(marked()).toContain("..")
    await h.app.onKey("j")
    h.app.render()
    expect(marked()).toContain("files/")
    await h.app.onKey("j")
    h.app.render()
    expect(marked()).toContain("app.rs")
    await h.app.onKey("k")
    h.app.render()
    expect(marked()).toContain("files/")
    await h.app.onKey("\r")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("‹ src/files/")
    await h.app.onKey("\x7f")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("‹ src/ · 2 entries")
    await h.app.onKey("j")
    await h.app.onKey("j")
    await h.app.onKey("\r")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("‹ app.rs")
    await h.app.onKey("\x7f")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("‹ src/ · 2 entries")
  })

  test("a listing is cut at 500 entries and says so", async () => {
    const ctx = await chat({ text: "nothing to see here", height: 60 })
    mkdirSync(path.join(ctx.dir, "many"))
    for (let index = 0; index < 600; index++) writeFileSync(path.join(ctx.dir, "many", `f${String(index).padStart(3, "0")}.txt`), "")
    await ctx.h.type("/open many\r")
    await settle()
    ctx.h.app.render()
    expect(frame(ctx.h)).toContain("‹ many/ · 600 entries")
    // The last row of the window is the statement, once the cursor reaches the end.
    await ctx.h.app.onKey("\x1b}")
    await ctx.h.app.onKey("G")
    ctx.h.app.render()
    expect(frame(ctx.h)).toContain("showing the first 500 of 600")
  })

  test("outside the workspace nothing is listed: .., an absolute folder and a symlink out", async () => {
    const ctx = await chat({ text: "nothing to see here" })
    const outside = path.join(ctx.dir, "..")
    symlinkSync(outside, path.join(ctx.dir, "linked"))
    for (const target of ["..", outside, "linked"]) {
      await ctx.h.type(`/open ${target}\r`)
      await settle()
      ctx.h.app.render()
      expect(frame(ctx.h)).not.toContain("‹ ")
    }
    expect(viewed(ctx.h).every((shown) => shown !== outside)).toBe(true)
  })

  test("ask puts the folder into the prompt and copy puts its path on the clipboard", async () => {
    const { h } = await folder("src", { profile: { viewerFocus: true } })
    await h.app.onKey("a")
    h.app.render()
    expect(frame(h)).toContain("❭ @src ")
    await h.app.onKey("\x1b}")
    await h.app.onKey("y")
    await settle()
    expect(h.written.some((data) => data.startsWith("\x1b]52;c;") && Buffer.from(data.slice(7, -1), "base64").toString("utf8") === "src")).toBe(true)
  })
})
