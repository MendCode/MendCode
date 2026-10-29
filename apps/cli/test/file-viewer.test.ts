import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, conversation, tempDir, type Harness } from "./session-ui-harness"
import { chat, click, drag, frame, numbered, press, release, rowOf, settle, slot, wheelDown, type Setup } from "./file-viewer-helpers"
import { highlight } from "../src/view/syntax"
import { languageOfPath } from "../src/view/tool-bodies"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

const osc52 = (h: Harness) => h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))
const viewed = (h: Harness) => h.sentOf("file.view") as Array<{ path: string; from?: number; count?: number; directory: string }>
const open = (text: string, needle: string, setup: Setup = {}) => chat({ text, ...setup }).then(async (ctx) => { await click(ctx.h, needle); return ctx })
/** Cells with a background in row `row` of the last frame: where a selection or fill is. */
const filledRows = (h: Harness, color = "element") => (h.frames.at(-1) ?? []).flatMap((line, row) => line.some((span) => span.bg === color && span.text.trim() !== "") ? [row] : [])

describe("what a click opens", () => {
  test("a path with a line opens the file in the right slot, the cited line selected and the chat kept on the left", async () => {
    const { h } = await open("See src/app.rs:120 now.", "src/app.rs:120")
    const text = frame(h)
    // One header row, the language not repeated when the extension says it.
    expect(text).toContain("‹ app.rs · 200 lines")
    expect(text).not.toContain("· rust")
    expect(text).toContain("o open · a ask · y copy")
    expect(text).toContain("fn target()")
    expect(text).toContain("Where is it?")
    const row = rowOf(h, "fn target()")
    expect(filledRows(h)).toContain(row)
    expect(filledRows(h)).not.toContain(row + 1)
  })

  const forms: Array<[string, string, string, [number, number] | undefined]> = [
    ["a range", "see src/files/link.rs:56-79 here", "src/files/link.rs:56-79", [56, 79]],
    ["a column suffix", "at src/app.rs:120:5 here", "src/app.rs:120:5", [120, 120]],
    ["a GitHub line range", "see DESIGN.md#L10-L20 here", "DESIGN.md#L10-L20", [10, 20]],
    ["a dot slash path", "read ./AGENTS.md first", "./AGENTS.md", undefined],
    ["backticks", "read `src/app.rs:120` first", "src/app.rs:120", [120, 120]],
    ["trailing punctuation", "it is in DESIGN.md.", "DESIGN.md", undefined],
    ["a bare file name", "start with AGENTS.md, then", "AGENTS.md", undefined],
  ]
  for (const [name, text, needle, selected] of forms) {
    test(`recognises ${name}`, async () => {
      const { h } = await open(text, needle)
      expect(viewed(h).length).toBeGreaterThan(0)
      expect(frame(h)).toContain("o open · a ask · y copy")
      if (selected) {
        const rows = filledRows(h)
        expect(rows.length).toBe(Math.min(selected[1] - selected[0] + 1, rows.length))
        expect(rows.length).toBeGreaterThan(0)
      }
    })
  }

  test("an absolute path inside the workspace opens, and one in an added directory", async () => {
    const inside = await chat({ text: (dir) => `Open ${dir}/src/app.rs:120 please` })
    await click(inside.h, "/src/app.rs:120")
    expect(frame(inside.h)).toContain("‹ app.rs")
    const extra = tempDir("mendcode-file-viewer-extra-")
    writeFileSync(path.join(extra, "notes.md"), numbered(5, "note"))
    const added = await chat({ text: `Open ${extra}/notes.md please`, settings: { additionalDirectories: [extra] } })
    await click(added.h, "/notes.md")
    expect(frame(added.h)).toContain("‹ notes.md")
    const other = await chat({ text: `Open ${extra}/notes.md please` })
    await click(other.h, "/notes.md")
    expect(viewed(other.h)).toEqual([])
    expect(frame(other.h)).not.toContain("‹ notes.md")
  })

  test("a path wrapped over two rows opens from either row", async () => {
    const relative = ["a".repeat(44), "b".repeat(44), "c".repeat(44), "module.rs"].join("/")
    for (const part of ["aaaaaaaa", "module.rs"]) {
      const { h, dir } = await chat({ width: 90, height: 30, text: `Open ./${relative} now.` })
      mkdirSync(path.join(dir, path.dirname(relative)), { recursive: true })
      writeFileSync(path.join(dir, relative), "fn wrapped() {}\n")
      expect(rowOf(h, "module.rs")).toBeGreaterThan(rowOf(h, "aaaaaaaa"))
      await click(h, part, 2)
      expect(frame(h)).toContain("‹ module.rs")
    }
  })

  test("the file named in a tool card's title opens, and the rest of the header still folds the card", async () => {
    const { h, talk } = await chat({ text: "done" })
    const turnId = "turn-tool"
    talk.emit({ type: "turn.started", turnId, queueId: "queue-tool" })
    talk.emit({ type: "item.started", turnId, itemId: "item-tool", kind: "tool_call", meta: { tool: "read src/app.rs" } })
    talk.emit({ type: "item.completed", itemId: "item-tool", status: "ok", text: "     1\tuse std::collections::HashMap;\n     2\t" })
    talk.emit({ type: "turn.completed", turnId })
    h.app.render()
    expect(rowOf(h, "src/app.rs")).toBeGreaterThanOrEqual(0)
    await click(h, "src/app.rs", 3)
    expect(frame(h)).toContain("‹ app.rs · 200 lines")
    expect(viewed(h).length).toBe(1)
  })

  test("a double click opens once and still selects the word", async () => {
    const { h } = await chat({ text: "Read src/app.rs:120 now." })
    const row = rowOf(h, "src/app.rs:120")
    const col = h.text()[row]!.indexOf("app.rs")
    for (let i = 0; i < 2; i++) {
      await h.app.onKey(press(col, row))
      await h.app.onKey(release(col, row))
    }
    await settle()
    expect(viewed(h).length).toBe(1)
  })
})

describe("what a click must not open", () => {
  test("a URL, a Rust path with colons and prose open nothing and read nothing", async () => {
    for (const [text, needle] of [["See https://example.com/docs/app.rs for it", "example.com"], ["use std::collections::HashMap here", "collections"], ["e.g. a date 2026-09-30 and 1.5 ok", "2026"]] as const) {
      const { h } = await open(text, needle)
      expect(viewed(h)).toEqual([])
      expect(frame(h)).not.toContain("o open · a ask")
    }
  })

  test("a path outside the workspace says so in one line and is never asked for", async () => {
    const { h } = await open("Do not read /etc/hosts please.", "/etc/hosts")
    expect(viewed(h)).toEqual([])
    expect(frame(h)).toContain("not opened: /etc/hosts is outside the workspace")
    expect(frame(h)).not.toContain("o open · a ask")
  })

  test("a symlink out of the workspace is refused by the daemon and nothing of the target is shown", async () => {
    const { h, dir } = await chat({ text: "see ./escape/hosts here" })
    symlinkSync("/etc", path.join(dir, "escape"))
    await click(h, "./escape/hosts")
    expect(viewed(h).length).toBe(1)
    expect(frame(h)).toContain("is outside the workspace")
    expect(frame(h)).not.toContain("localhost")
    expect(frame(h)).not.toContain("o open · a ask")
  })

  test("a missing file opens nothing", async () => {
    const missing = await open("see src/nope.rs:3 here", "src/nope.rs")
    expect(viewed(missing.h).length).toBe(1)
    expect(frame(missing.h)).toContain("does not exist")
    expect(frame(missing.h)).not.toContain("o open · a ask")
  })

  test("a bare name that is not a file stays quiet", async () => {
    const { h } = await open("runs on Node.js today", "Node.js")
    expect(frame(h)).not.toContain("not opened")
    expect(frame(h)).not.toContain("o open · a ask")
  })

  test("a drag that starts on a path selects text and opens nothing", async () => {
    const { h } = await chat({ text: "Read src/app.rs:120 now." })
    const row = rowOf(h, "src/app.rs:120")
    const col = h.text()[row]!.indexOf("src/app.rs")
    await h.app.onKey(press(col, row))
    await h.app.onKey(drag(col + 6, row))
    await h.app.onKey(release(col + 6, row))
    await settle()
    expect(viewed(h)).toEqual([])
    expect(frame(h)).not.toContain("o open · a ask")
  })

  test("ctrl and alt clicks stay with the terminal's own link", async () => {
    const { h } = await chat({ text: "Read src/app.rs:120 now." })
    const row = rowOf(h, "src/app.rs:120")
    const col = h.text()[row]!.indexOf("app.rs")
    await h.app.onKey(`\x1b[<16;${col + 1};${row + 1}M`)
    await h.app.onKey(`\x1b[<16;${col + 1};${row + 1}m`)
    await settle()
    expect(viewed(h)).toEqual([])
  })
})

describe("what a file looks like", () => {
  test("a binary file is one line with its size and type, never its bytes", async () => {
    const { h } = await open("logo at ./logo.png now", "./logo.png")
    expect(frame(h)).toContain("binary file · image/png · 10 B")
    expect(frame(h)).not.toContain("PNG")
  })

  test("a pipe in the workspace is described, not opened, and does not hang", async () => {
    const { h, dir } = await chat({ text: "see ./fifo here" })
    expect(Bun.spawnSync(["mkfifo", path.join(dir, "fifo")]).exitCode).toBe(0)
    const started = Date.now()
    await click(h, "./fifo")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(frame(h)).toContain("device, pipe or socket")
  })

  test("a symlink to a device is outside the workspace and is never read", async () => {
    const { h, dir } = await chat({ text: "see ./zero here" })
    symlinkSync("/dev/zero", path.join(dir, "zero"))
    const started = Date.now()
    await click(h, "./zero")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(frame(h)).toContain("is outside the workspace")
  })

  test("an 11,000 line file opens at line 11000 at once and reads one window", async () => {
    const { h } = await open("the end is big.log:11000 now", "big.log:11000")
    expect(frame(h)).toContain("11000 lines")
    expect(frame(h)).toContain("entry 11000")
    expect(frame(h)).not.toContain("entry 100 ")
    const reads = viewed(h)
    expect(reads.length).toBe(1)
    expect(reads[0]!.count!).toBeLessThanOrEqual(400)
  })

  test("the position on the slot's last row stops one cell before the edge, where the screen does not write", async () => {
    const { h } = await open("the end is big.log:11000 now", "big.log:11000")
    const last = h.text().at(-1)!
    expect(last).toMatch(/\d+-11000\/11000 $/)
  })

  test("a file past the byte limit is one line and is not read", async () => {
    const { h, dir } = await chat({ text: "see ./huge.txt here" })
    writeFileSync(path.join(dir, "huge.txt"), Buffer.alloc(5 * 1024 * 1024, 97))
    await click(h, "./huge.txt")
    expect(frame(h)).toContain("too large to view")
  })

  test("long lines are cut with ←/→ to scroll, or wrapped with the setting", async () => {
    const long = "x".repeat(300)
    const cut = await chat({ text: "see ./long.txt here" })
    writeFileSync(path.join(cut.dir, "long.txt"), long + "\nshort\n")
    await click(cut.h, "./long.txt")
    expect(frame(cut.h)).toContain("xxxx")
    expect(frame(cut.h)).toContain("short")
    const wrapped = await chat({ text: "see ./long.txt here", profile: { viewerWrap: true } })
    writeFileSync(path.join(wrapped.dir, "long.txt"), long + "\nshort\n")
    await click(wrapped.h, "./long.txt")
    const rows = slot(wrapped.h).filter((row) => row.includes("xxxx"))
    expect(rows.length).toBeGreaterThan(2)
  })

  test("git marks show in the margin from the changes report", async () => {
    const { h } = await chat({
      text: "at src/app.rs:12 now",
      changes: (dir) => ({ root: dir, omittedFiles: 0, files: [{ path: "src/app.rs", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false, diff: "@@ -10,3 +10,4 @@\n     pub fn new() -> Self {\n-        // old\n+        // new\n+        // more\n     }" }] }),
    })
    await click(h, "src/app.rs:12")
    await settle()
    h.app.render()
    expect(slot(h).filter((row) => row.includes("▎")).length).toBe(2)
  })

  test("a changed file reads like its diff: added lines tinted, the lines HEAD had drawn in red above them", async () => {
    const { h } = await chat({
      text: "at src/app.rs:12 now",
      changes: (dir) => ({ root: dir, omittedFiles: 0, files: [{ path: "src/app.rs", status: "modified", additions: 1, deletions: 2, binary: false, truncated: false, diff: "@@ -10,4 +10,3 @@\n     pub fn new() -> Self {\n-        // old one\n-        // old\ttwo\x1b[2J\n+        // new\n         App {}" }] }),
    })
    await click(h, "src/app.rs:12")
    await settle()
    h.app.render()
    const rows = slot(h)
    const old = rows.findIndex((row) => row.includes("// old one"))
    expect(old).toBeGreaterThan(0)
    // Removed rows carry no line number and sit right above line 11, the line that replaced them; a tab and an escape in them are spaces.
    expect(rows[old]!).not.toMatch(/\d/)
    expect(rows[old + 1]!).toContain("// old  two")
    expect(frame(h)).not.toContain("\x1b[2J")
    expect(rows[old + 2]!).toMatch(/11 /)
    expect(filledRows(h, "diffRemovedBg")).toHaveLength(2)
    expect(filledRows(h, "diffAddedBg")).toHaveLength(1)
    for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(h.size.width)
  })

  test("a file opened without a line lands on its first change; with a cited line it stays there", async () => {
    const changes = (dir: string) => ({ root: dir, omittedFiles: 0, files: [{ path: "big.txt", status: "modified", additions: 1, deletions: 0, binary: false, truncated: false, diff: "@@ -199,2 +199,3 @@\n line 199\n+line 200\n line 201" }] })
    const bare = await chat({ text: "see ./big.txt and ./big.txt:5 now", changes })
    writeFileSync(path.join(bare.dir, "big.txt"), numbered(400))
    await click(bare.h, "./big.txt")
    await settle()
    bare.h.app.render()
    await settle()
    bare.h.app.render()
    expect(slot(bare.h).some((row) => row.includes("line 200"))).toBe(true)
    expect(slot(bare.h).some((row) => /\bline 1$/.test(row.trimEnd()))).toBe(false)
    const cited = await chat({ text: "see ./big.txt:5 now", changes })
    writeFileSync(path.join(cited.dir, "big.txt"), numbered(400))
    await click(cited.h, "./big.txt:5")
    await settle()
    cited.h.app.render()
    expect(slot(cited.h).some((row) => row.includes("line 5"))).toBe(true)
    expect(slot(cited.h).some((row) => row.includes("line 200"))).toBe(false)
  })

  test("a language the highlighter knows is coloured by its extension, known to the table or not", () => {
    expect(languageOfPath("Sources/App/ClaudeUsageService.swift")).toBe("swift")
    expect(languageOfPath("a/Main.kt")).toBe("kt")
    expect(languageOfPath("a/b.java")).toBe("java")
    expect(languageOfPath("a/schema.sql")).toBe("sql")
    expect(languageOfPath("notes.markdown")).toBe("md")
    expect(languageOfPath("Dockerfile")).toBe("dockerfile")
    expect(languageOfPath("a/data.bin")).toBeUndefined()
    expect(languageOfPath("LICENSE")).toBeUndefined()
    expect(highlight("final class Usage: ObservableObject { let plan: String? }", "swift").some((span) => span.fg === "synKeyword")).toBe(true)
  })

  test("secrets in a file are masked", async () => {
    const { h, dir } = await chat({ text: "see ./env.txt here" })
    writeFileSync(path.join(dir, "env.txt"), "token = sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ\n")
    await click(h, "./env.txt")
    expect(frame(h)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789")
  })
})

describe("the right slot", () => {
  const panel = { rightSidebar: true, sidebarWidgets: [{ type: "context", options: {} }] } as const

  test("closing restores the panel exactly, and a hidden slot hides again", async () => {
    const withPanel = await chat({ text: "see src/app.rs:120 now", profile: panel })
    const before = frame(withPanel.h)
    await click(withPanel.h, "src/app.rs:120")
    expect(frame(withPanel.h)).toContain("‹ app.rs")
    expect(frame(withPanel.h)).not.toBe(before)
    await withPanel.h.app.onKey("\x1b}")
    await withPanel.h.app.onKey("\x1b")
    await settle()
    withPanel.h.app.render()
    expect(frame(withPanel.h)).toBe(before)

    const hidden = await chat({ text: "see src/app.rs:120 now" })
    const bare = frame(hidden.h)
    await click(hidden.h, "src/app.rs:120")
    expect(frame(hidden.h)).toContain("‹ app.rs")
    await hidden.h.app.onKey("\x1b}")
    await hidden.h.app.onKey("q")
    await settle()
    hidden.h.app.render()
    expect(frame(hidden.h)).toBe(bare)
  })

  test("a key and a click switch between the file and the panel, and the header says which", async () => {
    const { h } = await chat({ text: "see src/app.rs:120 now", profile: panel })
    await click(h, "src/app.rs:120")
    // No second header row: the switch is the last hint of the footer, worded with the user's key.
    expect(frame(h)).not.toContain("file · panel")
    expect(frame(h)).toContain("alt+{ panel")
    await h.app.onKey("\x1b{")
    h.app.render()
    expect(frame(h)).toContain("panel · app.rs")
    expect(frame(h)).not.toContain("‹ app.rs")
    await h.app.onKey("\x1b{")
    h.app.render()
    expect(frame(h)).toContain("‹ app.rs")
    // The footer's hint switches with a click.
    const row = rowOf(h, "alt+{ panel")
    const col = h.text()[row]!.indexOf("panel")
    await h.app.onKey(press(col, row))
    await h.app.onKey(release(col, row))
    h.app.render()
    expect(frame(h)).toContain("panel · app.rs")
  })

  test("opening a second file replaces the first", async () => {
    const { h } = await chat({ text: "see src/app.rs:120 and DESIGN.md#L10-L20 now" })
    await click(h, "src/app.rs:120")
    expect(frame(h)).toContain("‹ app.rs")
    await click(h, "DESIGN.md#L10-L20")
    expect(frame(h)).toContain("‹ DESIGN.md")
    expect(frame(h)).not.toContain("‹ app.rs")
  })

  test("the wheel scrolls the file and leaves the transcript alone", async () => {
    const { h } = await open("see src/app.rs:120 now", "src/app.rs:120")
    const before = slot(h).join("\n")
    await h.app.onKey(wheelDown(h.size.width - 20, 10))
    h.app.render()
    expect(slot(h).join("\n")).not.toBe(before)
    expect(frame(h)).toContain("Where is it?")
  })

  test("a click on a line selects it and the prompt keeps the keyboard", async () => {
    const { h } = await open("see src/app.rs:120 now", "src/app.rs:120")
    const row = rowOf(h, "filler 125")
    await h.app.onKey(press(h.size.width - 20, row))
    await h.app.onKey(release(h.size.width - 20, row))
    h.app.render()
    expect(filledRows(h)).toEqual([row])
    await h.type("hello")
    expect(frame(h)).toContain("hello")
  })
})

describe("keys inside the viewer", () => {
  async function focused(text = "see src/app.rs:120 now") {
    const ctx = await open(text, text.includes("src/app.rs:120") ? "src/app.rs:120" : text)
    await ctx.h.app.onKey("\x1b}")
    ctx.h.app.render()
    return ctx
  }

  test("j and k scroll, G and g jump, and the prompt gets none of them", async () => {
    const { h } = await focused()
    const top = () => slot(h)[1]!.trim()
    const start = top()
    await h.app.onKey("j")
    h.app.render()
    expect(top()).not.toBe(start)
    await h.app.onKey("G")
    h.app.render()
    expect(frame(h)).toContain("200/200")
    await h.app.onKey("g")
    h.app.render()
    await settle()
    h.app.render()
    expect(frame(h)).toContain("use std::collections")
    expect(frame(h)).not.toContain("❭ jgG")
  })

  test("search finds lines, n and N step through them", async () => {
    const { h } = await focused()
    await h.type("/")
    for (const char of "filler 18") await h.app.onKey(char)
    await h.app.onKey("\r")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("filler 18")
    const first = rowOf(h, "filler 18")
    await h.app.onKey("n")
    h.app.render()
    expect(rowOf(h, "filler 18")).toBeGreaterThanOrEqual(0)
    expect(first).toBeGreaterThanOrEqual(0)
  })

  test("a line number after : jumps there", async () => {
    const { h } = await focused()
    for (const char of ":190\r") await h.app.onKey(char)
    h.app.render()
    expect(frame(h)).toContain("filler 190")
  })

  test("ask agent puts the file and the selected lines into the prompt", async () => {
    const { h } = await focused()
    await h.app.onKey("a")
    h.app.render()
    expect(frame(h)).toContain("@src/app.rs:120 ")
  })

  test("copy puts the selected lines on the clipboard, or the path", async () => {
    const { h } = await focused()
    await h.app.onKey("y")
    await settle()
    expect(osc52(h).at(-1)).toBe('fn target() { let key = "value"; }')
    await h.app.onKey("c")
    await h.app.onKey("y")
    await settle()
    expect(osc52(h).at(-1)).toBe("src/app.rs")
  })

  test("esc closes it", async () => {
    const { h } = await focused()
    await h.app.onKey("\x1b")
    h.app.render()
    expect(frame(h)).not.toContain("‹ app.rs")
  })

  test("a change on disk shows after the turn ends and on r", async () => {
    const { h, dir } = await focused()
    writeFileSync(path.join(dir, "src/app.rs"), "changed line one\nchanged line two\n")
    conversation(h.sessionId, h.app.onEvent).exchange("again", "done")
    await settle()
    await Bun.sleep(350)
    h.app.render()
    expect(frame(h)).toContain("changed line two")
    writeFileSync(path.join(dir, "src/app.rs"), "third version\n")
    await h.app.onKey("r")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("third version")
  })
})

describe("a narrow terminal", () => {
  test("the file opens as a page with the same header and esc returns to the chat as it was", async () => {
    const { h } = await chat({ width: 80, height: 24, text: "see src/app.rs:120 now" })
    const before = frame(h)
    await click(h, "src/app.rs:120")
    expect(h.text()[0]).toContain("‹ app.rs · 200 lines")
    expect(h.text()[0]).toContain("open")
    expect(frame(h)).toContain("esc back")
    await h.app.onKey("\x1b")
    h.app.render()
    expect(frame(h)).toBe(before)
  })

  test("widening the terminal moves the page into the slot", async () => {
    const { h } = await chat({ width: 80, height: 24, text: "see src/app.rs:120 now" })
    await click(h, "src/app.rs:120")
    h.size.width = 160
    h.app.render()
    expect(frame(h)).toContain("Where is it?")
    expect(frame(h)).toContain("‹ app.rs")
  })
})

describe("settings and tiers", () => {
  test("balanced and full open on a click, minimalist and no tier keep today's behaviour", async () => {
    for (const [tier, expected] of [["balanced", true], ["full", true], ["minimalist", false], [null, false]] as const) {
      const { h } = await open("see src/app.rs:120 now", "src/app.rs:120", { tier })
      expect(frame(h).includes("o open · a ask · y copy")).toBe(expected)
      expect(viewed(h).length > 0).toBe(expected)
    }
  })

  test("pathClick editor turns it off anywhere, panel turns it on anywhere", async () => {
    const off = await open("see src/app.rs:120 now", "src/app.rs:120", { profile: { pathClick: "editor" } })
    expect(viewed(off.h)).toEqual([])
    const on = await open("see src/app.rs:120 now", "src/app.rs:120", { tier: "minimalist", profile: { pathClick: "panel" } })
    expect(frame(on.h)).toContain("o open · a ask · y copy")
  })

  test("line numbers can be switched off", async () => {
    const withNumbers = await open("see src/app.rs:120 now", "src/app.rs:120")
    expect(frame(withNumbers.h)).toMatch(/ 120 fn target/)
    const without = await open("see src/app.rs:120 now", "src/app.rs:120", { profile: { viewerNumbers: false } })
    expect(frame(without.h)).not.toMatch(/ 120 fn target/)
    expect(frame(without.h)).toContain("fn target")
  })

  test("opening takes the keyboard only when viewerFocus is on", async () => {
    const free = await open("see src/app.rs:120 now", "src/app.rs:120")
    await free.h.type("j")
    expect(frame(free.h)).toContain("❭ j")
    const taken = await open("see src/app.rs:120 now", "src/app.rs:120", { profile: { viewerFocus: true } })
    await taken.h.type("j")
    expect(frame(taken.h)).not.toContain("❭ j")
  })
})

describe("/open", () => {
  test("opens a path at a line, a range, and refuses what it must", async () => {
    const { h } = await chat({ text: "hello" })
    await h.type("/open src/app.rs:120-125\r")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("‹ app.rs")
    await h.type("/open /etc/hosts\r")
    await settle()
    expect(viewed(h).map((read) => read.path)).toEqual(["src/app.rs"])
    await h.type("/open src/nope.rs\r")
    await settle()
    h.app.render()
    expect(frame(h)).toContain("src/nope.rs does not exist")
    await h.type("/open close\r")
    h.app.render()
    expect(frame(h)).not.toContain("‹ app.rs")
  })

  test("is listed from balanced and not in minimalist", async () => {
    const balanced = await chat({ text: "hello" })
    await balanced.h.type("/ope")
    expect(frame(balanced.h)).toContain("/open")
    const minimal = await chat({ text: "hello", tier: "minimalist" })
    await minimal.h.type("/ope")
    expect(frame(minimal.h)).not.toContain("/open")
  })

  test("@ completes the path", async () => {
    const { h } = await chat({ text: "hello" })
    await h.type("/open @AGENTS")
    await settle()
    expect(h.sentOf("files.search").length).toBeGreaterThan(0)
  })
})
