import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { AUTOSCROLL_MS } from "../src/ui/app/mouse-selection"

afterEach(cleanTemps)

const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`
const osc52 = (h: Harness) => h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))

async function chat(options: { copyOnSelect?: boolean; width?: number } = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...(options.copyOnSelect === undefined ? {} : { copyOnSelect: options.copyOnSelect }) })
  const h = appHarness({ dataDir, width: options.width ?? 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("What does the daemon do when a terminal disappears?", "It keeps the session running and stores the last unsent prompt, so the next terminal can bring it back exactly as it was typed before the crash happened.\n\nA second paragraph stays separate.")
  talk.exchange("And history?", "Every submitted prompt is kept per project.")
  h.app.render()
  return h
}

const rowOf = (h: Harness, needle: string) => h.text().findIndex((row) => row.includes(needle))

test("dragging across wrapped lines and two messages copies the plain text once, on release", async () => {
  const h = await chat()
  const first = rowOf(h, "What does the daemon")
  const last = rowOf(h, "Every submitted prompt")
  expect(first).toBeGreaterThan(-1)
  expect(last).toBeGreaterThan(first)
  const start = h.text()[first]!.indexOf("What")
  await h.app.onKey(press(start, first))
  await h.app.onKey(drag(start + 5, first + 1))
  await h.app.onKey(drag(60, last))
  expect(osc52(h)).toEqual([])
  const highlighted = h.frames.at(-1)![last]!.some((span) => span.bg === "primary")
  expect(highlighted).toBe(true)
  await h.app.onKey(release(60, last))
  const [copied] = osc52(h)
  expect(copied).toBeDefined()
  expect(copied!.startsWith("What does the daemon do when a terminal disappears?")).toBe(true)
  expect(copied).toContain("so the next terminal can bring it back exactly as it was typed before the crash happened.")
  expect(copied).toContain("\n\nA second paragraph stays separate.")
  expect(copied).toContain("And history?")
  expect(copied!.endsWith("Every submitted prompt is kept per project.")).toBe(true)
  expect(copied).not.toMatch(/\x1b/)
  expect(copied!.split("\n").every((line) => !line.startsWith(" "))).toBe(true)
  // The wrapped sentence is one line again, not cut where the terminal wrapped it.
  expect(copied!.split("\n").some((line) => line.includes("stores the last unsent prompt") && line.includes("crash happened."))).toBe(true)
  // The clipboard is out of sight, so a short notice says the copy happened.
  expect(h.text().join("\n")).toContain("copied 301 chars")
  expect(h.frames.at(-1)!.flat().some((span) => span.bg === "primary" && span.fg === "background")).toBe(false)
})

test("code blocks, quotes and tables copy without their bars, borders and labels", async () => {
  const h = appHarness({ dataDir: tempDir(), width: 90, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  conversation(h.sessionId, h.app.onEvent).exchange("Show me code", "Here:\n\n```ts\nfunction a() {\n  return 1\n}\n```\n\n> quoted text\n\n| a | b |\n|---|---|\n| 1 | 2 |")
  h.app.render()
  const first = rowOf(h, "Here:")
  const last = rowOf(h, "│ 1 │ 2 │")
  await h.app.onKey(press(0, first))
  await h.app.onKey(drag(80, last))
  await h.app.onKey(release(80, last))
  expect(osc52(h)).toEqual(["Here:\n\nfunction a() {\n  return 1\n}\n\nquoted text\n\na\tb\n1\t2"])
})

test("a plain click copies nothing", async () => {
  const h = await chat()
  const row = rowOf(h, "Every submitted prompt")
  await h.app.onKey(press(10, row))
  await h.app.onKey(release(10, row))
  await h.app.onKey(press(30, row))
  await h.app.onKey(drag(30, row))
  await h.app.onKey(release(30, row))
  expect(osc52(h)).toEqual([])
})

test("copyOnSelect off keeps the selection highlighted until ctrl+c copies it", async () => {
  const h = await chat({ copyOnSelect: false })
  const row = rowOf(h, "Every submitted prompt")
  const start = h.text()[row]!.indexOf("Every")
  await h.app.onKey(press(start, row))
  await h.app.onKey(drag(start + 4, row))
  await h.app.onKey(release(start + 4, row))
  h.app.render()
  expect(osc52(h)).toEqual([])
  expect(h.frames.at(-1)![row]!.some((span) => span.bg === "primary")).toBe(true)
  await h.app.onKey("\x03")
  expect(osc52(h)).toEqual(["Every"])
})

test("selecting text in the prompt copies exactly that text", async () => {
  const h = await chat()
  await h.type("alpha beta gamma")
  const row = rowOf(h, "alpha beta gamma")
  const start = h.text()[row]!.indexOf("beta")
  await h.app.onKey(press(start, row))
  await h.app.onKey(drag(start + 3, row))
  await h.app.onKey(release(start + 3, row))
  expect(osc52(h)).toEqual(["beta"])
  expect(h.text().join("\n")).toContain("copied 4 chars")
})

async function longChat() {
  const h = appHarness({ dataDir: tempDir(), width: 100, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const reply = Array.from({ length: 70 }, (_, i) => `line ${String(i + 1).padStart(2, "0")} of the answer`).join("\n\n")
  conversation(h.sessionId, h.app.onEvent).exchange("Count for me", reply)
  h.app.render()
  return h
}

const lineNumbers = (text: string) => [...text.matchAll(/line (\d\d) of the answer/g)].map((match) => Number(match[1]))

test("dragging past the top edge scrolls the transcript and copies the rows that left the screen", async () => {
  const h = await longChat()
  const start = rowOf(h, "line 70 of the answer")
  expect(start).toBeGreaterThan(-1)
  const visibleBefore = lineNumbers(h.text().join("\n")).length
  await h.app.onKey(press(60, start))
  await h.app.onKey(drag(20, start - 2))
  await h.app.onKey(drag(20, 0))
  await Bun.sleep(AUTOSCROLL_MS * 8)
  h.app.render()
  // Older text scrolled into view while the pointer stayed put.
  expect(h.text().some((row) => row.includes("line 70 of the answer"))).toBe(false)
  await h.app.onKey(release(20, 0))
  const [copied] = osc52(h)
  expect(copied).toBeDefined()
  const numbers = lineNumbers(copied!)
  // Everything between the anchor and the new top is there, in order, including rows that were never on screen at press time.
  expect(numbers.length).toBeGreaterThan(visibleBefore)
  expect(numbers.at(-1)).toBe(70)
  expect(numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1)).toBe(true)
})

test("dragging below the transcript scrolls it back down and stops once the pointer returns inside", async () => {
  const h = await longChat()
  for (let i = 0; i < 8; i++) await h.app.onKey("\x1b[<64;10;10M")
  h.app.render()
  const top = h.text().findIndex((row) => /line \d\d of the answer/.test(row))
  const first = lineNumbers(h.text()[top]!)[0]!
  await h.app.onKey(press(0, top))
  await h.app.onKey(drag(20, top + 3))
  await h.app.onKey(drag(20, 28))
  await Bun.sleep(AUTOSCROLL_MS * 8)
  h.app.render()
  expect(lineNumbers(h.text().join("\n"))).not.toContain(first)
  await h.app.onKey(drag(20, top + 4))
  const settled = h.text().join("\n")
  await Bun.sleep(AUTOSCROLL_MS * 4)
  h.app.render()
  expect(h.text().join("\n")).toBe(settled)
  await h.app.onKey(release(20, top + 4))
  const numbers = lineNumbers(osc52(h)[0]!)
  expect(numbers[0]).toBe(first)
  expect(numbers.length).toBeGreaterThan(8)
})

test("the wheel keeps a selection on its text: a drag reaches past one screen and copies it all on release", async () => {
  const h = await longChat()
  const start = rowOf(h, "line 70 of the answer")
  const visibleBefore = lineNumbers(h.text().join("\n")).length
  await h.app.onKey(press(60, start))
  await h.app.onKey(drag(20, start - 2))
  for (let i = 0; i < 8; i++) await h.app.onKey("\x1b[<64;21;5M")
  h.app.render()
  expect(h.text().some((row) => row.includes("line 70 of the answer"))).toBe(false)
  expect(h.frames.at(-1)!.flat().some((span) => span.bg === "primary" && span.fg === "background")).toBe(true)
  await h.app.onKey(release(20, 4))
  const numbers = lineNumbers(osc52(h)[0] ?? "")
  expect(numbers.length).toBeGreaterThan(visibleBefore)
  expect(numbers.at(-1)).toBe(70)
  expect(numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1)).toBe(true)
  expect(h.text().join("\n")).toContain("copied")
})

test("a kept selection (copy on select off) survives the wheel and still copies its own text", async () => {
  const h = await chat({ copyOnSelect: false })
  const row = rowOf(h, "Every submitted prompt")
  const col = h.text()[row]!.indexOf("submitted")
  await h.app.onKey(press(col, row))
  await h.app.onKey(drag(col + 8, row))
  await h.app.onKey(release(col + 8, row))
  await h.app.onKey("\x1b[<64;10;10M")
  await h.app.onKey("\x03")
  expect(osc52(h)).toEqual(["submitted"])
})

test("the footer under the prompt is selectable: a drag copies its text, a plain click selects nothing", async () => {
  const h = await chat()
  const rows = h.text()
  const footer = rows.length - 1 - [...rows].reverse().findIndex((row) => row.trim().length > 0)
  const text = rows[footer]!
  const start = text.search(/\S/)
  const end = text.trimEnd().length - 1
  expect(start).toBeGreaterThan(-1)
  await h.app.onKey(press(start, footer))
  await h.app.onKey(release(start, footer))
  expect(osc52(h)).toEqual([])
  await h.app.onKey(press(start, footer))
  await h.app.onKey(drag(end, footer))
  expect(h.frames.at(-1)![footer]!.some((span) => span.bg === "primary")).toBe(true)
  await h.app.onKey(release(end, footer))
  expect(osc52(h)).toEqual([text.trim()])
})
