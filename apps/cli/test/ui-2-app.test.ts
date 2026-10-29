import { afterEach, expect, test } from "bun:test"
import type { Loop } from "@mendcode/protocol"
import { createTranscript } from "../src/view/transcript"
import { createTurnState } from "../src/view/turn-state"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SETUP_ROWS } from "../src/view/setup-page"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, mendRowIn, NOW, tempDir, type Harness } from "./session-ui-harness"

afterEach(cleanTemps)
const text = (h: Harness) => h.text().join("\n")
async function change(h: Harness, field: typeof CUSTOMIZE_ROWS[number], key = " ") {
  await h.type("/customize\r")
  for (let i = 0; i < CUSTOMIZE_ROWS.indexOf(field); i++) await h.app.onKey("\x1b[B")
  await h.app.onKey(key)
  await h.app.onKey("\x1b")
  h.app.render()
}
function create(profile: Partial<TuiProfile> = {}, width = 100, height = 30) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile })
  const h = appHarness({ width, height, dataDir, directory: "/work/mend", version: "0.4.2", reply: (command) => {
    if (command.type === "models.list") return { ok: true, result: { engine: "faux", selectable: false, models: [], defaults: { model: "local-test", effort: "high" }, effective: { model: "local-test", effort: "high" }, roles: {} } }
    if (command.type === "git.branch") return { ok: true, result: { branch: "ui-2" } }
    if (command.type === "changes.query") return { ok: true, result: { root: "/work/mend", files: [{ path: "one.ts", status: "modified", additions: 5, deletions: 2, binary: false, truncated: false, diff: "" }], omittedFiles: 0 } }
    if (command.type === "mcp.status") return { ok: true, result: { servers: [], issues: [] } }
    if (command.type === "recipes.list") return { ok: true, result: { recipes: [] } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true })
  return { h, dataDir }
}

test("Ctrl+P Home welcome mode picker changes and persists; Ctrl+S on home opens sessions", async () => {
  const { h, dataDir } = create()
  await h.app.onKey("\x10")
  await h.type("Home welcome mode")
  await h.app.onKey("\r")
  expect(text(h)).toContain("Home welcome mode")
  expect(text(h)).toContain("Centered")
  expect(text(h)).toContain("Split")
  await h.app.onKey("\x1b[B")
  await h.app.onKey("\r")
  expect(readTuiProfile(dataDir).homeLayout).toBe("split")
  await h.app.onKey("\x13")
  expect(h.app.page).toBe("sessions")
})

test("Agent View lists this project's sessions and its folders' only, and its spinner moves while they work", async () => {
  const { h } = create({ homeLayout: "split", logoKind: "mascot", sidebar: "hidden" }, 180, 50)
  h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: ids("session"), directory: "/work/mend/packages/api", title: "Child folder work", state: "generating", updatedAt: NOW })
  h.app.onGlobal({ type: "session.activity", gseq: 2, at: NOW, sessionId: ids("session"), directory: "/work/other", title: "Other project work", state: "generating", updatedAt: NOW })
  h.app.onGlobal({ type: "session.activity", gseq: 3, at: NOW, sessionId: ids("session"), directory: "/work/mend-two", title: "Sibling prefix work", state: "generating", updatedAt: NOW })
  h.app.render()
  expect(text(h)).toContain("Child folder work")
  expect(text(h)).not.toContain("Other project work")
  expect(text(h)).not.toContain("Sibling prefix work")
  expect(text(h)).toMatch(/0 wait · 0 loop · 1 work/)
  const row = () => text(h).split("\n").find((line) => line.includes("Child folder work"))
  const before = row()
  await Bun.sleep(300)
  expect(row()).not.toBe(before)
  h.app.stop?.()
})

test("Agent View lists waiting, looping and working sessions, a finished one under Completed, and removes finished loops", async () => {
  const { h } = create({ homeLayout: "split", logoKind: "mascot", sidebar: "hidden" }, 180, 50)
  const loop: Loop = { loopId: ids("loop"), sessionId: ids("session"), name: "Watch tests", directory: "/work/mend", objective: "Watch tests", state: "running", trigger: { kind: "interval", everyMs: 60_000 }, budget: { mode: "monitor" }, runs: 1, history: [], createdAt: NOW, updatedAt: NOW }
  h.app.onGlobal({ type: "loop.changed", gseq: 1, at: NOW, loop })
  for (const [index, state] of (["idle", "generating", "waiting_approval"] as const).entries()) h.app.onGlobal({ type: "session.activity", gseq: index + 2, at: NOW, sessionId: ids("session"), directory: "/work/mend", title: state, state, updatedAt: NOW })
  h.app.render()
  expect(text(h)).toContain("Watch tests")
  expect(text(h)).toMatch(/1 wait · 1 loop · 1 work/)
  const lines = text(h).split("\n")
  expect(lines[lines.findIndex((line) => line.includes("Completed")) + 1]).toContain("✦ idle")
  expect(text(h)).not.toMatch(/start of session/)
  h.app.onGlobal({ type: "loop.changed", gseq: 5, at: NOW, loop: { ...loop, state: "completed" } })
  h.app.render()
  expect(text(h)).not.toContain("Watch tests")
})

test("footer and session chrome controls change real data immediately", async () => {
  const { h } = create({ showEffort: true }, 100, 30)
  await Bun.sleep(5)
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Keep the transcript", "Answer stays visible")
  await Bun.sleep(5)
  h.app.render()
  expect(text(h)).toContain("Build · local-test · high / faux")
  expect(text(h)).toContain("ui-2 /work/mend")
  await change(h, "showDiffFiles")
  expect(h.text()[0]).toContain("1 file")
  await change(h, "showProject")
  expect(h.text()[0]).not.toMatch(/ui-2|\/work\/mend|git/)
  await change(h, "showModel")
  expect(h.text().at(-1)).not.toContain("local-test")
  await change(h, "showProvider")
  expect(h.text().at(-1)).not.toContain("faux")
  await change(h, "showEffort")
  expect(h.text().at(-1)).not.toContain("high")
  await change(h, "showAgent")
  expect(h.text().at(-1)).not.toContain("Build")
  await change(h, "showStatus")
  expect(text(h)).toContain("Answer stays visible")
  expect(h.frames.at(-1)).toHaveLength(30)
})

test("setup welcome and logo choices persist and preview the new identity", async () => {
  const { h, dataDir } = create({}, 180, 50)
  await h.type("/setup advanced\r")
  for (let i = 0; i < SETUP_ROWS.indexOf("homeLayout"); i++) await h.app.onKey("\x1b[B")
  await h.app.onKey("\x1b[C")
  for (let i = SETUP_ROWS.indexOf("homeLayout"); i < SETUP_ROWS.indexOf("logoKind"); i++) await h.app.onKey("\x1b[B")
  await h.app.onKey("\x1b[C")
  h.app.render()
  expect(text(h)).toContain("/|[+]|\\")
  expect(readTuiProfile(dataDir)).toMatchObject({ homeLayout: "split", logoKind: "mascot" })
  expect(h.sentOf("settings.set")).toHaveLength(0)
})

test("official Mend is six rows of colored half blocks at every app breakpoint, its eyes on the tool at work", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [220, 60]]) {
    const { h } = create({ pet: "mend", activityMascot: true }, width, height)
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("Review the file", "Inspecting")
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "foreground.state", state: "tool", turnId })
    chat.emit({ type: "item.started", turnId, itemId: ids("item"), kind: "tool_call", meta: { tool: "test" } })
    h.app.render()
    const frame = h.frames.at(-1)!
    expect(mendRowIn(frame, "testing")).toBeGreaterThan(0)
    expect(mendRowIn(frame, "idle")).toBe(-1)
    expect(frame).toHaveLength(height!)
    for (const line of frame) expect(textWidth(line.map((span) => span.text).join(""))).toBeLessThanOrEqual(width!)
    expect(frame.flat().some((span) => span.text.includes("█"))).toBe(false)
  }
})

test("Agent View arrows select a real session; Enter opens it, Esc clears selection", async () => {
  const { h } = create({ logoKind: "mascot" })
  const other = ids("session")
  h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: other, directory: "/work/mend", title: "Active work", state: "generating", updatedAt: NOW })
  await h.app.onKey("\x1b[B")
  expect(h.frames.at(-1)!.flat().some((span) => span.text === "Active work" && span.bg === "element")).toBe(true)
  await h.app.onKey("\x1b")
  expect(h.frames.at(-1)!.flat().some((span) => span.text === "Active work" && span.bg === "element")).toBe(false)
  await h.app.onKey("\x1b[B")
  await h.app.onKey("\r")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(other)
})

test("Mend pet hover shows its happy eyes and restores the phase outside its cells", async () => {
  const { h } = create({ pet: "mend" })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Check the file", "Done")
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "foreground.state", state: "tool", turnId })
  chat.emit({ type: "item.started", turnId, itemId: ids("item"), kind: "tool_call", meta: { tool: "test" } })
  h.app.render()
  const row = mendRowIn(h.frames.at(-1)!, "testing") + 2
  expect(row).toBeGreaterThan(2)
  const col = h.text()[row]!.indexOf("▀")
  await h.app.onKey(`\x1b[<35;${col + 1};${row + 1}M`)
  expect(mendRowIn(h.frames.at(-1)!, "hover")).toBe(row - 2)
  await h.app.onKey("\x1b[<35;1;1M")
  expect(mendRowIn(h.frames.at(-1)!, "testing")).toBe(row - 2)
})

test("reasoning and tool presentation change cached rows without changing transcript data", () => {
  const transcript = createTranscript({ mode: "full" })
  const chat = conversation(ids("session"), transcript.apply)
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  for (const [kind, body] of [["reasoning", "Inspecting the boundary\n".repeat(12)], ["tool_call", "result row\n".repeat(40)], ["agent_message", "Final answer remains"]] as const) {
    const itemId = ids("item")
    chat.emit({ type: "item.started", turnId, itemId, kind, meta: kind === "tool_call" ? { tool: "read" } : {} })
    chat.emit({ type: "item.completed", itemId, status: "ok", text: body })
  }
  chat.emit({ type: "turn.completed", turnId })
  const data = JSON.stringify(transcript.blocks())
  const full = transcript.totalLines(100)
  transcript.setAppearance({ reasoning: "hidden", toolOutput: "collapsed", doneSymbol: "*", messageMeta: "full" })
  const quiet = transcript.viewport(100, 100).map((line) => line.spans.map((span) => span.text).join("")).join("\n")
  expect(quiet).not.toContain("Inspecting the boundary")
  expect(quiet).toContain("Final answer remains")
  expect(quiet).toContain("* ")
  expect(transcript.totalLines(100)).toBeLessThan(full)
  transcript.setAppearance({ reasoning: "expanded", toolOutput: "expanded" })
  expect(transcript.viewport(100, 100).map((line) => line.text).join("\n")).toContain("Inspecting the boundary")
  expect(JSON.stringify(transcript.blocks())).toBe(data)
})

test("activity tokens count the current turn and preserve session totals", () => {
  const turn = createTurnState()
  const chat = conversation(ids("session"), turn.apply)
  const usage = { type: "usage.recorded", provider: "faux", model: "local", input: 10, output: 20, reasoning: 3, cacheRead: 0, cacheWrite: 0 }
  const first = ids("turn")
  chat.emit({ type: "turn.started", turnId: first, queueId: ids("queue") })
  chat.emit({ ...usage, turnId: first })
  expect(turn.output).toBe(23)
  chat.emit({ type: "turn.completed", turnId: first })
  const second = ids("turn")
  chat.emit({ type: "turn.started", turnId: second, queueId: ids("queue") })
  expect(turn.output).toBe(0)
  chat.emit({ ...usage, turnId: second })
  expect(turn.output).toBe(23)
  expect(turn.totals.output).toBe(46)
})

test("window title tokens, accent and sidebar side apply to the real app", async () => {
  const { h } = create({ titleTemplate: "{product} · {route} · {path}" }, 180, 50)
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Show the layout", "Current conversation")
  h.app.render()
  expect(h.titles.at(-1)).toBe("MendCode · chat · /work/mend")
  await change(h, "sessionAccent")
  expect(h.frames.at(-1)!.flat().some((span) => span.fg === "primary" && !!span.fgHex)).toBe(true)
  await change(h, "terminalTitle")
  expect(h.titles.at(-1)).toBe("")
  await change(h, "sidebarSide", "\x1b[C")
  const right = h.text()[0]!
  expect(right.indexOf("Sessions")).toBeGreaterThan(130)
  await change(h, "sidebar", "\x1b[D")
  expect(h.text()[0]).not.toContain("Sessions")
})
