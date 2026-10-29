import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, normalizeTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { DOUBLE_CLICK_MS } from "../src/ui/app/mouse-selection"
import { createScreen } from "../src/ui/screen"
import { fileUri, findLinks, linkRows } from "../src/view/links"
import { safeLink } from "../src/ui/hyperlink"
import { lineSpan, wordSpan } from "../src/ui/selection"

afterEach(cleanTemps)

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const rightPress = (col: number, row: number) => `\x1b[<2;${col + 1};${row + 1}M`
const osc52 = (h: Harness) => h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))
const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))

async function chat(options: { profile?: Partial<TuiProfile>; reply?: Parameters<typeof appHarness>[0] extends infer O ? (O extends { reply?: infer R } ? R : never) : never } = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...options.profile })
  const clock = { at: 1_800_000_000_000 }
  const h = appHarness({ dataDir, width: 100, height: 30, now: () => clock.at, ...(options.reply ? { reply: options.reply } : {}) })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Where is the config?", "It lives in src/config/load.ts:42 and the docs are at https://example.com/docs/config.\n\nSecond paragraph wraps because it is deliberately long enough to need more than one row on a hundred column terminal screen, so a triple click takes all of it.")
  h.app.render()
  return { h, clock }
}

test("a double click selects and copies the word under the pointer", async () => {
  const { h, clock } = await chat()
  const row = rowOf(h, "Where is the config?")
  const col = h.text()[row]!.indexOf("config")
  await h.app.onKey(press(col + 2, row))
  await h.app.onKey(release(col + 2, row))
  expect(osc52(h)).toEqual([])
  clock.at += DOUBLE_CLICK_MS - 50
  await h.app.onKey(press(col + 2, row))
  await h.app.onKey(release(col + 2, row))
  expect(osc52(h)).toEqual(["config"])
})

test("a double click keeps a path together and a slow second click is a plain click", async () => {
  const { h, clock } = await chat()
  const row = rowOf(h, "src/config/load.ts")
  const col = h.text()[row]!.indexOf("config/load")
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  clock.at += DOUBLE_CLICK_MS + 50
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  expect(osc52(h)).toEqual([])
  clock.at += 100
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  expect(osc52(h)).toEqual(["src/config/load.ts:42"])
})

test("a triple click takes the whole wrapped line, never the chrome", async () => {
  const { h, clock } = await chat()
  const row = rowOf(h, "Second paragraph")
  const col = h.text()[row]!.indexOf("deliberately")
  for (let i = 0; i < 3; i++) {
    await h.app.onKey(press(col, row))
    await h.app.onKey(release(col, row))
    clock.at += 100
  }
  expect(osc52(h)[0]).toBe("deliberately")
  const copied = osc52(h).at(-1)
  expect(copied).toBeDefined()
  expect(copied!.startsWith("Second paragraph wraps")).toBe(true)
  expect(copied!.endsWith("takes all of it.")).toBe(true)
  expect(copied).not.toContain("\n")
})

test("double and triple clicks in the prompt select the word and the row", async () => {
  const { h, clock } = await chat()
  await h.type("alpha beta gamma")
  const row = rowOf(h, "alpha beta gamma")
  const col = h.text()[row]!.indexOf("beta")
  await h.app.onKey(press(col + 1, row))
  await h.app.onKey(release(col + 1, row))
  clock.at += 100
  await h.app.onKey(press(col + 1, row))
  await h.app.onKey(release(col + 1, row))
  expect(osc52(h)).toEqual(["beta"])
  clock.at += 100
  await h.app.onKey(press(col + 1, row))
  await h.app.onKey(release(col + 1, row))
  expect(osc52(h).at(-1)).toBe("alpha beta gamma")
})

test("wordSpan and lineSpan read cells, not characters", () => {
  expect(wordSpan("see src/a-b.ts now", 6)).toEqual([4, 14])
  expect(wordSpan("see src/a-b.ts now", 3)).toBeUndefined()
  expect(wordSpan("end of file.", 10)).toEqual([7, 11])
  expect(wordSpan("中文 abc", 1)).toEqual([0, 4])
  expect(lineSpan("  text   ")).toEqual([0, 6])
  expect(lineSpan("   ")).toBeUndefined()
})

test("a right click pastes the clipboard only when rightClickPaste is on", async () => {
  const reply = (command: { type: string }) => command.type === "attachment.clipboard" ? { ok: true as const, result: { kind: "text", text: "from clipboard" } } : undefined
  const off = await chat({ reply })
  await off.h.app.onKey(rightPress(10, 5))
  expect(off.h.sent.some((command) => command.type === "attachment.clipboard")).toBe(false)
  const on = await chat({ profile: { rightClickPaste: true }, reply })
  await on.h.app.onKey(rightPress(10, 5))
  expect(on.h.sent.filter((command) => command.type === "attachment.clipboard")).toHaveLength(1)
  on.h.app.render()
  expect(on.h.text().join("\n")).toContain("from clipboard")
})

test("wheelLines sets how many rows a notch scrolls", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `row ${i + 1} of the answer`).join("\n\n")
  async function scrolled(wheelLines: number) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, wheelLines })
    const h = appHarness({ dataDir, width: 100, height: 30 })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    conversation(h.sessionId, h.app.onEvent).exchange("Count", lines)
    h.app.render()
    const before = rowOf(h, "of the answer")
    await h.app.onKey("\x1b[<64;10;10M")
    h.app.render()
    const first = h.text().find((row) => /row \d+ of the answer/.test(row))!
    return { before, first }
  }
  const slow = await scrolled(1)
  const fast = await scrolled(10)
  const number = (row: string) => Number(/row (\d+)/.exec(row)![1])
  expect(number(fast.first)).toBeLessThan(number(slow.first))
  expect(normalizeTuiProfile({ wheelLines: 99 }).wheelLines).toBe(20)
  expect(normalizeTuiProfile({ wheelLines: "x" }).wheelLines).toBe(3)
})

test("clicking the jump-to-latest label follows the newest output again", async () => {
  const dataDir = tempDir()
  const h = appHarness({ dataDir, width: 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const reply = Array.from({ length: 70 }, (_, i) => `line ${String(i + 1).padStart(2, "0")} of the answer`).join("\n\n")
  conversation(h.sessionId, h.app.onEvent).exchange("Count for me", reply)
  h.app.render()
  await h.app.onKey("\x1b[<64;10;10M")
  h.app.render()
  const row = rowOf(h, "↓ latest")
  expect(row).toBeGreaterThan(-1)
  expect(rowOf(h, "line 70 of the answer")).toBe(-1)
  await h.app.onKey(press(h.text()[row]!.indexOf("↓ latest") + 2, row))
  h.app.render()
  expect(rowOf(h, "↓ latest")).toBe(-1)
  expect(rowOf(h, "line 70 of the answer")).toBeGreaterThan(-1)
})

test("URLs and file paths become OSC 8 links, in the drawn rows only when hyperlinks are on", async () => {
  const context = { cwd: "/work/app", home: "/home/me", opener: "vscode" as const }
  expect(findLinks("open src/config/load.ts:42:7 or ~/notes/todo.md", context).map((m) => m.uri)).toEqual(["vscode://file/work/app/src/config/load.ts:42:7", "vscode://file/home/me/notes/todo.md"])
  expect(findLinks("a/b and 10/12/2026 and and/or", context)).toEqual([])
  expect(findLinks("see https://example.com/a_(b), then (https://x.dev/y).", context).map((m) => m.uri)).toEqual(["https://example.com/a_(b)", "https://x.dev/y"])
  expect(findLinks("src/a.ts", { ...context, opener: "none" })).toEqual([])
  expect(fileUri({ file: "/a b/c#d.ts", line: 3, opener: "file" })).toBe("file:///a%20b/c%23d.ts")
  expect(fileUri({ file: "/p/x.ts", line: 3, column: 2, opener: "idea" })).toBe("idea://open?file=%2Fp%2Fx.ts&line=3&column=2")
  expect(safeLink("javascript:alert(1)")).toBeUndefined()
  expect(safeLink("https://x.y/\x1b[31m")).toBeUndefined()
  expect(safeLink("https://x.y/é")).toBeUndefined()

  const { h } = await chat()
  const painted = h.frames.at(-1)!.flat().filter((span) => span.link)
  expect(painted.map((span) => span.text)).toContain("src/config/load.ts:42")
  expect(painted.find((span) => span.text.startsWith("https://example.com"))?.link).toBe("https://example.com/docs/config")
  const plain = await chat({ profile: { hyperlinks: false } })
  expect(plain.h.frames.at(-1)!.flat().some((span) => span.link && span.text.includes("load.ts"))).toBe(false)
})

test("a URL cut by the layout points at the whole address on both rows", () => {
  const url = "https://example.com/a/very/long/path/that/keeps/going/and/going"
  const first = [{ text: `  ${url.slice(0, 30)}` }]
  const second = [{ text: `  ${url.slice(30)} tail` }]
  const rows = linkRows([
    { spans: first, text: first[0]!.text },
    { spans: second, text: second[0]!.text, soft: "none", gutter: 2 },
  ], { cwd: "/", opener: "file" })
  expect(rows[0]!.filter((span) => span.link).map((span) => span.link)).toEqual([url])
  expect(rows[1]!.filter((span) => span.link).map((span) => span.link)).toEqual([url])
  expect(rows[1]!.at(-1)!.link).toBeUndefined()
})

test("the screen wraps linked spans in OSC 8 and drops unsafe or disabled links", () => {
  const writes: string[] = []
  const screen = createScreen({ columns: 40, rows: 3, write: (data) => void writes.push(data) }, { COLORTERM: "truecolor" })
  screen.draw([[{ text: "go " }, { text: "docs", link: "https://example.com/d" }, { text: " bad", link: "javascript:x" }]])
  const out = writes.join("")
  expect(out).toContain("\x1b]8;;https://example.com/d\x1b\\docs\x1b]8;;\x1b\\")
  expect(out).not.toContain("javascript")
  writes.length = 0
  screen.setHyperlinks(false)
  screen.draw([[{ text: "go " }, { text: "docs", link: "https://example.com/d" }]])
  expect(writes.join("")).not.toContain("\x1b]8;")
  const vetoed = createScreen({ columns: 40, rows: 3, write: (data) => void writes.push(data) }, { MENDCODE_HYPERLINKS: "0" })
  writes.length = 0
  vetoed.setHyperlinks(true)
  vetoed.draw([[{ text: "docs", link: "https://example.com/d" }]])
  expect(writes.join("")).not.toContain("\x1b]8;")
})

test("a click on a web address opens it in the browser; a drag over it still selects", async () => {
  const { h, clock } = await chat()
  const row = rowOf(h, "https://example.com/docs/config")
  const col = h.text()[row]!.indexOf("example.com")
  await h.app.onKey(press(col, row))
  await h.app.onKey(release(col, row))
  expect(h.sentOf("url.open").map((command) => (command as { url: string }).url)).toEqual(["https://example.com/docs/config"])
  clock.at += DOUBLE_CLICK_MS + 50
  await h.app.onKey(press(col, row))
  await h.app.onKey(`\x1b[<32;${col + 5};${row + 1}M`)
  await h.app.onKey(release(col + 4, row))
  expect(h.sentOf("url.open")).toHaveLength(1)
  expect(osc52(h)).toEqual(["examp"])
})

test("the pointer over a web address underlines it and turns into a hand; moving off puts both back", async () => {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Where does it run?", "Open `http://127.0.0.1:5173` in the browser.")
  h.app.render()
  const row = rowOf(h, "http://127.0.0.1:5173")
  const col = h.text()[row]!.indexOf("127.0.0.1")
  const move = (c: number, r: number) => `\x1b[<35;${c + 1};${r + 1}M`
  const underlined = () => h.frames.at(-1)!.flat().filter((span) => span.underline && span.link === "http://127.0.0.1:5173")
  expect(underlined()).toEqual([])
  await h.app.onKey(move(col, row))
  h.app.render()
  expect(underlined().length).toBeGreaterThan(0)
  expect(h.written.at(-1)).toBe("\x1b]22;pointer\x1b\\")
  await h.app.onKey(move(0, row - 2))
  h.app.render()
  expect(underlined()).toEqual([])
  expect(h.written.at(-1)).toBe("\x1b]22;default\x1b\\")
})
