import { ui4Harness as harness } from "./ui-4-harness"
import { afterAll, expect, test } from "bun:test"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { sidebarSpec, SIDEBAR_PRESETS, WIDGET_TYPES } from "../src/view/sidebar-spec"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"
import { appHarness as extensionHarness, scratch } from "./extensions-harness"

afterAll(cleanTemps)


const settle = async () => { await Bun.sleep(5) }

test("btw keeps history through close/reopen and session switches; focus routes typing away from main", async () => {
  const h = harness()
  await h.type("/btw first\r")
  await settle()
  expect(h.text().join("\n")).toContain("Side answer 1")
  await h.type("main draft")
  await h.app.onKey("\x1d")
  await h.type("follow up\r")
  await settle()
  expect(h.app.editor.text).toBe("main draft")
  expect(h.threads.get(h.sessionId)?.messages.map((m) => m.text)).toEqual(["first", "Side answer 1", "follow up", "Side answer 2"])
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).toContain("Side answer 2")
  await h.app.onKey("\x1b]")
  expect(h.text().join("\n")).not.toContain("Side answer 2")
  h.app.editor.clear()
  await h.type("/btw\r")
  await settle()
  expect(h.text().join("\n")).toContain("Side answer 2")
  // `/btw` alone opens it ready to type; esc gives the keyboard back to the prompt.
  await h.app.onKey("\x1b")
  await h.type("/new\r")
  expect(h.text().join("\n")).not.toContain("Side answer 2")
  await h.type("/new\r")
  expect(h.text().join("\n")).toContain("Side answer 2")
  await h.type("/btw clear\r")
  await settle()
  expect(h.text().join("\n")).not.toContain("Side answer 2")
  expect(h.threads.get(h.sessionId)?.messages).toEqual([])
  expect(h.sent.some((command) => command.type === "user.submit")).toBe(false)
})

test("side chat bottom sheet and right column fit every requested size and preserve main transcript", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [220, 60]]) {
    const h = harness(width, height)
    await h.type("/btw question\r")
    await settle()
    h.app.render()
    const rows = h.text()
    expect(rows).toHaveLength(height!)
    expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
    expect(rows.join("\n")).toContain("Side answer 1")
    expect(rows.join("\n")).toContain("alt+] close")
    if (width! < 110) expect(rows.findIndex((row) => row.includes("❭"))).toBeGreaterThan(rows.findIndex((row) => row.includes("Side answer 1")))
    else expect(rows.some((row) => row.includes("Main answer") && row.slice(-56).startsWith("│"))).toBe(true)
    await h.app.onKey("\x1b]")
    expect(h.text().join("\n")).toContain("Main answer")
  }
})

test("every built-in widget renders actual terminal state and honest empty states", async () => {
  const expected = { context: "12,500 /", usage: "fake-provider weekly: 23%", todos: "Ship sidebar", changes: "changed.ts", jobs: "bun test", loops: "Watch checks", workflows: "Build UI", agents: "task: Inspect", mcp: "local-mcp: running", git: "2 ahead", session: "UI-4 session", clock: new Date(NOW).toLocaleTimeString(), text: "User note", sidechat: "/btw to open", agent: "Subscription", activity: "2 done", workspace: "ui-four", tokens: "Input", tools: "Tool list unavailable", alerts: "No alerts", pace: "active-call rate", savings: "Savings unavailable", queue: "Nothing queued", lineage: "Lineage unavailable", files: "Session files unavailable", limits: "fake-provider", rent: "Context rent unavailable", orbit: "Galaxy needs full tier", stats: "1 model call", atom: "◆ 0 agents", models: "fake-provider/fake-model", backlog: "Backlog is off · /tier backlog on" } satisfies Record<(typeof WIDGET_TYPES)[number], string>
  for (const type of WIDGET_TYPES) {
    const h = harness(180, 50, [{ type, options: type === "text" ? { text: "User note" } : {} }])
    const turnId = ids("turn")
    h.chat.emit({ type: "usage.recorded", turnId, provider: "fake-provider", model: "fake-model", input: 12_000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 12_000 })
    h.app.onGlobal({ type: "quota.snapshot", gseq: 1, at: NOW, provider: "fake-provider", windows: [{ id: "weekly", label: "weekly", usedPercent: 23 }], fetchedAt: NOW, source: "fake" })
    for (const [tool, result] of [["todo", "[ ] Ship sidebar"], ["task: Inspect", "Inspecting"]]) {
      const itemId = ids("item")
      h.chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool } })
      h.chat.emit({ type: "item.completed", itemId, status: "ok", text: result! })
    }
    await settle()
    h.app.render()
    expect(h.text().join("\n"), type).toContain(expected[type]!)
  }
  for (const [type, empty] of [["context", "Context usage unavailable"], ["usage", "Quota windows unavailable"], ["todos", "No todos"], ["agents", "No sub-agents"], ["stats", "No model calls yet"], ["text", "No text"]]) {
    const h = harness(180, 50, [{ type: type!, options: {} }])
    await settle()
    h.app.render()
    expect(h.text().join("\n")).toContain(empty!)
  }
})

test("empty right starts pulse in this session; editor add/remove/reorder persists the spec and reset hides it", async () => {
  const h = harness()
  await h.type("/sidebar right\r")
  expect(h.app.accessibility.profile.sidebarWidgets).toEqual(SIDEBAR_PRESETS.pulse)
  expect(h.app.accessibility.profile.rightSidebar).toBe(true)
  await h.type("/panel reset\r")
  await h.type("/sidebar edit\r")
  await h.type("a\r")
  expect(readTuiProfile(h.dataDir).sidebarWidgets.map((w) => w.type)).toEqual(["context"])
  await h.type("a")
  await h.app.onKey("\x1b[C")
  await h.app.onKey("\r")
  expect(readTuiProfile(h.dataDir).sidebarWidgets.map((w) => w.type)).toEqual(["context", "usage"])
  await h.type("Kd")
  expect(readTuiProfile(h.dataDir).sidebarWidgets.map((w) => w.type)).toEqual(["context"])
  await h.app.onKey("\x1b")
  await h.type("/sidebar reset\r")
  expect(readTuiProfile(h.dataDir).sidebarWidgets).toEqual([])
  expect(readTuiProfile(h.dataDir).rightSidebar).toBe(false)
  expect(sidebarSpec([{ type: "invented", options: {} }])).toEqual([])
})

test("extension:<id> renders a registered terminal slot and contains a throwing widget", async () => {
  const layout = scratch()
  try {
    writeTuiProfile(layout.dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: true, sidebarWidgets: [{ type: "extension:proof", options: {} }] })
    layout.write("data/extensions/sidebar.ts", 'export default { name: "proof", tui(api) { api.slot("sidebar:proof", ({width}) => [[{text:"Real extension " + width, fg:"primary"}]]) } }')
    const h = await extensionHarness({ dataDir: layout.dataDir, directory: layout.project, width: 180, height: 50 })
    await h.start()
    expect(h.text()).toContain("Real extension 54")
  } finally { layout.cleanup() }
})


test("empty or unavailable sources never invent widget values", async () => {
  for (const [type, empty] of [["jobs", "No background jobs"], ["loops", "No loops"], ["workflows", "No workflows"], ["mcp", "MCP status unavailable"], ["git", "No Git repository"], ["session", "Start time unavailable"], ["changes", "Changes unavailable"], ["extension:missing", "Extension widget unavailable"]]) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: true, sidebarWidgets: [{ type: type!, options: {} }] })
    const h = appHarness({ dataDir, directory: tempDir(), width: 180, height: 50 })
    h.app.applySettings({ onboarded: true })
    await settle()
    h.app.render()
    expect(h.text().join("\n"), type).toContain(empty!)
  }
})

test("streaming and in-panel errors render; scrolling and clear do not mutate the main draft", async () => {
  const h = harness(100, 30)
  await h.type("/btw\r")
  h.app.onGlobal({ type: "aside.changed", gseq: 0, at: NOW, sessionId: h.sessionId, thread: { busy: true, messages: [{ role: "user", text: "q" }, { role: "assistant", text: "Partial answer" }] } })
  expect(h.text().join("\n")).toContain("Partial answer")
  expect(h.text().join("\n")).toContain("thinking…")
  h.app.onGlobal({ type: "aside.changed", gseq: 0, at: NOW, sessionId: h.sessionId, thread: { busy: false, error: "Provider failed", messages: [{ role: "assistant", text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n\n") }] } })
  expect(h.text().join("\n")).toContain("Provider failed")
  await h.app.onKey("\x1b[5~")
  expect(h.text().join("\n")).not.toContain("line 40")
  await h.app.onKey("\x1b[6~")
  expect(h.text().join("\n")).toContain("line 40")
  await h.type("side draft")
  await h.app.onKey("\x1b")
  expect(h.app.editor.text).toBe("")
  await h.type("/btw clear\r")
  await settle()
  expect(h.text().join("\n")).toContain("Ask something about this session")
})

test("editor and reset target an existing project override without changing user widgets", async () => {
  const h = harness(180, 50, [{ type: "clock", options: {} }])
  const { updateSidebar, readSidebar } = await import("../../../packages/daemon/src/sidebar")
  updateSidebar(h.dataDir, h.directory, { action: "set", scope: "project", widgets: [{ type: "git", options: {} }] })
  await h.type("/sidebar edit\r")
  await h.type("a\r")
  expect(readSidebar(h.dataDir, h.directory).map((widget) => widget.type)).toEqual(["git", "context"])
  expect(readTuiProfile(h.dataDir).sidebarWidgets.map((widget) => widget.type)).toEqual(["clock"])
  await h.app.onKey("\x1b")
  await h.type("/sidebar reset\r")
  expect(readSidebar(h.dataDir, h.directory)).toEqual([])
  expect(readTuiProfile(h.dataDir).sidebarWidgets.map((widget) => widget.type)).toEqual(["clock"])
})

test("text ASCII keeps whitespace, and sidechat widgets retain their configured order and title", async () => {
  const h = harness(180, 50, [{ type: "text", options: { text: "```\n  /\\\n <++>\n  \\/\n```" } }, { type: "sidechat", title: "Review chat", options: {} }])
  await h.type("/btw first\r")
  await settle()
  h.app.render()
  const rows = h.text()
  expect(rows.join("\n")).toContain("  /\\")
  const text = rows.findIndex((row) => row.slice(-56).includes("Text"))
  const chat = rows.findIndex((row) => row.slice(-56).includes("Review chat"))
  expect(chat).toBeGreaterThan(text)
})

test("side input uses grapheme-aware editing and a narrow widget bar scrolls from its own focus", async () => {
  const h = harness(100, 30, Array.from({ length: 8 }, (_, index) => ({ type: "text", title: `Widget ${index}`, options: { text: `Value ${index}` } })))
  h.app.render()
  expect(h.text().join("\n")).not.toContain("Widget 6")
  expect(h.text().join("\n")).toContain("Main answer") // the bar is laid out under the transcript, never over its newest output
  await h.app.onKey("\x1b}")
  for (let i = 0; i < 10; i++) await h.app.onKey("\x1b[6~")
  expect(h.text().join("\n")).toContain("Widget 7")
  await h.app.onKey("\x1b")
  await h.type("/btw\r")
  await h.type("ab")
  await h.app.onKey("\x1b[D")
  await h.type("c")
  await h.app.onKey("\r")
  await settle()
  expect(h.threads.get(h.sessionId)?.messages[0]?.text).toBe("acb")
})

test("opening the side chat with ctrl+] keeps the prompt's draft, and closing it gives the same draft back", async () => {
  const h = harness(100, 30)
  await h.type("half a message")
  await h.app.onKey("\x1d")
  await h.type("side question")
  expect(h.app.editor.text).toBe("half a message")
  await h.app.onKey("\x1b")
  expect(h.app.editor.text).toBe("half a message")
  await h.app.onKey("\x1d")
  await h.app.onKey("\x1d")
  expect(h.app.editor.text).toBe("half a message")
  expect(h.text().join("\n")).toContain("half a message")
})
