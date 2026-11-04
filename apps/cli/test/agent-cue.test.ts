import { afterEach, expect, test } from "bun:test"
import { b62Harness } from "./b62-fixtures"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"
import { agentContextLine, cuePlaceholder, markOpenRow, openRowFill, tintFrame } from "../src/view/agent-cue"
import { subagentColor } from "../src/view/agent-color"
import { promptFrame } from "../src/view/prompt-chrome"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { activeTheme, glyphs, setTheme, themeList, type Line } from "../src/ui/theme"
import { lineWidth, textWidth } from "../src/view/wrap"

const all: Array<ReturnType<typeof b62Harness>> = []
afterEach(async () => { for (const h of all.splice(0)) { await h.app.onKey("\x03"); await h.app.onKey("\x03") }; cleanTemps() })
const plain = (line: Line) => line.map((span) => span.text).join("")

/** A child's own session open from /tasks, in a tier and with the top bar on or off. */
async function inside({ mode = "balanced", topbar = true, width = 100, height = 30 }: { mode?: "balanced" | "minimal"; topbar?: boolean; width?: number; height?: number } = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, showTopbar: topbar })
  const h = b62Harness(width, height, { dataDir, mode })
  all.push(h)
  h.app.applySettings({ onboarded: true })
  await h.type("/tasks\r")
  await h.app.onKey("\r")
  await Bun.sleep(10)
  conversation(h.first, h.app.onEvent).exchange("Inspect the outbox", "Queued notices survive restart.")
  h.app.render()
  return h
}
const rowsOf = (h: Awaited<ReturnType<typeof inside>>) => h.frames.at(-1)!

const sep = "·"
const line = (width: number, over: Partial<Parameters<typeof agentContextLine>[0]> = {}) => agentContextLine({ name: "Inspect actor wake", color: "info", state: { text: "thinking", fg: "muted" }, parent: "Review daemon lifecycle", hints: ["↑ parent · ←→ siblings", "↑ parent · ←→", "↑ parent"], width, inset: 2, sep, ...over })

test("the context line is exactly as wide as asked and gives up the parent, then the state, before the keys", () => {
  for (const width of [200, 100, 70, 50, 40, 30, 20]) expect(lineWidth(line(width))).toBe(width - 2)
  expect(plain(line(100))).toContain("◆ Inspect actor wake · thinking · of Review daemon lifecycle")
  expect(plain(line(100))).toContain("↑ parent · ←→ siblings")
  expect(plain(line(90))).toContain("of Review daemon lifecycle")
  expect(plain(line(90))).toContain("↑ parent · ←→")
  expect(plain(line(70))).not.toContain("of Review")
  expect(plain(line(70))).toContain("thinking")
  const narrow = plain(line(44))
  expect(narrow).toContain("◆ Inspect actor wake")
  expect(narrow).toContain("↑ parent")
  expect(narrow).not.toContain("of Review")
  // The name is the accent, the rest recedes.
  const spans = line(100)
  expect(spans.find((span) => span.text === "Inspect actor wake")).toMatchObject({ fg: "info", bold: true })
  expect(spans.find((span) => span.text.startsWith("of Review"))?.fg).toBe("muted")
})

test("a child session with no live task row still names itself, without a state", () => {
  const { state: _state, ...rest } = { name: "Inspect actor wake", color: "info" as const, state: undefined, parent: "Main", hints: ["↑ parent"], width: 80, inset: 2, sep }
  expect(plain(agentContextLine(rest))).toMatch(/^  ◆ Inspect actor wake · of Main\s+↑ parent\s*$/)
})

test("the open row is filled whole; a theme without fills underlines its name instead", () => {
  const row: Line = [{ text: "├▸", fg: "info", bold: true }, { text: "Audit", fg: "info", bold: true }, { text: "  bg" }, { text: " ", bg: "panel" }]
  const marked = markOpenRow(row)
  expect(marked.map((span) => span.bgHex !== undefined)).toEqual([true, true, true, false])
  expect(marked[3]!.bg).toBe("panel")
  expect(markOpenRow([])).toEqual([])
})

test("the prompt frame takes the sub-agent's colour on its rules and lead, and keeps everything else", () => {
  const frame = promptFrame({ preset: "top-bottom", width: 40, glyphs: glyphs({}), rich: true })
  const tinted = tintFrame(frame, "warning", "❭")
  expect(tinted.top[0]!.some((span) => span.fg === "warning")).toBe(true)
  expect(tinted.top[0]!.some((span) => span.fg === "primary")).toBe(false)
  expect(tinted.bottom[0]!.some((span) => span.fg === "warning")).toBe(true)
  const row = tinted.row([{ text: "  " }, { text: "❭ ", fg: "muted" }, { text: "hi", fg: "text" }])
  expect(row.find((span) => span.text === "❭ ")).toMatchObject({ fg: "warning", bold: true })
  expect(row.find((span) => span.text === "hi")?.fg).toBe("text")
  expect(tinted.inset).toBe(frame.inset)
  // The box preset tints its bars as well.
  const box = tintFrame(promptFrame({ preset: "box", width: 40, glyphs: glyphs({}), rich: true }), "warning", "❭")
  expect(box.row([{ text: "x" }]).filter((span) => span.text === "│").every((span) => span.fg === "warning")).toBe(true)
})

test("the hint says whom a message goes to, and is honest about a thread that is read-only", () => {
  expect(cuePlaceholder({ kind: "child", name: "Inspect actor wake", sep, width: 60 })).toBe("message Inspect actor wake")
  expect(cuePlaceholder({ kind: "child", name: "Inspect actor wake and then a very long name", sep, width: 20 })).toHaveLength(20)
  expect(cuePlaceholder({ kind: "thread", name: "Read a.txt", sep, width: 80 })).toBe("read-only thread · messages go to the session")
})

test("inside a child's session with the top bar off, a line names it, its state, its parent and the way back; the input says whom it writes to", async () => {
  const h = await inside({ topbar: false })
  const rows = h.text()
  expect(rows[0]).toStartWith("╭─ sub-agent ")
  expect(rows[1]).toMatch(/^│ ◆ Inspect actor wake · done · of Review daemon lifecycle\s+↑ parent · ←→( siblings)? │$/)
  const prompt = rows.findIndex((row) => row.includes("❭"))
  expect(rows[prompt]).toContain("❭ message Inspect actor wake")
  // The rules around the input and the lead wear the sub-agent's colour; the open row of the strip is filled.
  const color = subagentColor("Inspect actor wake")
  const frame = rowsOf(h)
  expect(frame[prompt - 1]!.some((span) => span.fg === color && /─/.test(span.text))).toBe(true)
  expect(frame[prompt + 1]!.some((span) => span.fg === color && /─/.test(span.text))).toBe(true)
  expect(frame[prompt]!.find((span) => span.text === "❭ ")).toMatchObject({ fg: color })
  const open = frame.findIndex((line) => plain(line).includes("▸"))
  expect(open).toBeGreaterThan(-1)
  expect(frame[open]!.slice(1).every((span) => span.bgHex === openRowFill())).toBe(true)
  expect(lineWidth(frame[open]!)).toBeLessThanOrEqual(100)
  const other = frame.find((line) => /Review writer presence/.test(plain(line)))!
  expect(other.some((span) => span.bgHex !== undefined)).toBe(false)
  // Back in the parent every cue is gone and the prompt is the conversation's.
  await h.app.onKey("\x1b[A")
  await Bun.sleep(10)
  h.app.render()
  const back = h.text()
  expect(back.some((row) => row.includes("◆ Inspect actor wake") || row.includes("message Inspect"))).toBe(false)
  const lead = h.frames.at(-1)!.flat().find((span) => span.text === "❭ ")
  expect(lead?.fg).toBe("muted")
})

test("with the top bar on the child gets the same line, and the bar no longer repeats the keys", async () => {
  const h = await inside({ topbar: true })
  const rows = h.text()
  expect(rows.filter((row) => row.includes("↑ parent")).length).toBe(1)
  expect(rows.some((row) => row.includes("◆ Inspect actor wake") && row.includes("of Review daemon lifecycle"))).toBe(true)
})

test("the minimal tier shows only the context line, with no border, no strip and no change to the input", async () => {
  const h = await inside({ mode: "minimal" })
  const rows = h.text()
  expect(rows[0]).toMatch(/^ {2}◆ Inspect actor wake · done · of Review daemon lifecycle\s+↑ parent · ←→( siblings)?\s*$/)
  expect(rows.some((row) => row.includes("╭─") || row.includes("▸") || row.includes("message Inspect"))).toBe(false)
  expect(rows.filter((row) => row.includes("◆")).length).toBe(1)
})

test("the cues fit 100x30 and 200x60 without a row wider than the screen", async () => {
  for (const [width, height] of [[100, 30], [200, 60]] as const) for (const mode of ["balanced", "minimal"] as const) for (const topbar of [true, false]) {
    const h = await inside({ mode, topbar, width, height })
    expect(h.text()).toHaveLength(height)
    for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(width)
  }
})

/** An engine's own sub-agent opened as a thread (the shape agent-threads.test.ts uses). */
async function thread(mode: "balanced" | "minimal", topbar = true) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, showTopbar: topbar })
  const h = appHarness({
    dataDir, width: 110, height: 34, mode,
    reply: (command) => {
      if (command.type === "session.get") return { ok: true, result: { session: { sessionId: command.sessionId, directory: "/work" } } } as never
      if (command.type === "session.children") return { ok: true, result: { sessions: [] } } as never
      if (command.type === "task.list") return { ok: true, result: { tasks: [] } } as never
      if (command.type === "background.list") return { ok: true, result: { tasks: [] } } as never
      return undefined
    },
  })
  h.app.applySettings({ onboarded: true })
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
  for (const [itemId, name] of [["item_a", "Read a.txt"], ["item_b", "Read b.txt"]] as const) talk.emit({ type: "item.started", turnId: "turn_1", itemId, kind: "tool_call", meta: { tool: `agent ${name}`, subagent: true, agent: "general-purpose", background: true } })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "a_prompt", kind: "user_message", meta: { agentParent: "item_a" } })
  talk.emit({ type: "item.completed", itemId: "a_prompt", status: "ok", text: "Locate a.txt." })
  h.app.render()
  await h.type("\x18\x1b[B")
  return h
}

test("an engine's thread says it is read-only in the input, in its own colour, with the top bar off too", async () => {
  const h = await thread("balanced", false)
  const rows = h.text()
  expect(rows.some((row) => row.includes("◆ Read a.txt · of this session") && row.includes("1 of 2 · ←→ · ↑ back"))).toBe(true)
  const prompt = rows.findIndex((row) => row.includes("❭"))
  expect(rows[prompt]).toContain("read-only thread · messages go to the session")
  expect(h.frames.at(-1)![prompt - 1]!.some((span) => span.fg === subagentColor("Read a.txt"))).toBe(true)
})

test("in the minimal tier a thread gets the context line alone", async () => {
  const h = await thread("minimal")
  const rows = h.text()
  expect(rows[0]).toMatch(/^ {2}◆ Read a\.txt · .* · of .+←→ · ↑ back\s*$/)
  expect(rows.some((row) => row.includes("╭─") || row.includes("read-only thread"))).toBe(false)
  await h.type("\x1b[A")
  expect(h.text().some((row) => row.includes("◆ Read a.txt"))).toBe(false)
})

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => { const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05) }

test("the open row's fill stands out of the background and keeps the muted text and the agent colours readable on every theme, light or dark", () => {
  const before = activeTheme().name
  try {
    for (const theme of themeList()) {
      if (theme.ansi) continue
      expect(setTheme(theme.name)).toBe(true)
      const fillHex = openRowFill()
      expect(contrast(theme.background, fillHex), `${theme.name} fill against its background`).toBeGreaterThanOrEqual(1.15)
      expect(contrast(theme.colors.muted, fillHex), `${theme.name} muted on the fill`).toBeGreaterThanOrEqual(3)
      for (const role of ["info", "warning", "success", "synType", "accent", "primary"] as const) expect(contrast(theme.colors[role], fillHex), `${theme.name} ${role} on the fill`).toBeGreaterThanOrEqual(3)
    }
    // The light themes are covered too, not only the dark ones.
    expect(themeList().some((theme) => !theme.ansi && luminance(theme.background) > 0.5)).toBe(true)
    // A theme on the terminal's own palette has no fill: the open row's name is underlined instead.
    expect(setTheme("terminal")).toBe(true)
    const marked = markOpenRow([{ text: "Audit", bold: true }, { text: "  bg" }])
    expect(marked.map((span) => span.underline)).toEqual([true, undefined])
    expect(marked.some((span) => span.bgHex || span.bg)).toBe(false)
  } finally { setTheme(before) }
})
