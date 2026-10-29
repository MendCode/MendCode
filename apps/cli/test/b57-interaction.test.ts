import { afterEach, expect, test } from "bun:test"
import { b57Harness, QUESTIONS } from "./b57-harness"
import { cleanTemps, appHarness, conversation, ids, tempDir } from "./session-ui-harness"
import { parseTodoText, renderDock } from "../src/view/dock"
import { textWidth } from "../src/view/wrap"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

afterEach(cleanTemps)
const answers = (h: ReturnType<typeof b57Harness>) => h.sentOf("request.resolve")

test("batch tabs retain selections and custom answers; only Confirm submits ordered label arrays", async () => {
  const h = b57Harness()
  await h.app.onKey("2")
  expect(h.text().join("\n")).toContain("Which checks should run?")
  await h.app.onKey("1")
  await h.app.onKey("2")
  await h.app.onKey("3")
  await h.type("Lint\r")
  // The saved answer of one's own takes the custom row's place, ticked.
  expect(h.text().join("\n")).toContain("[✓] Lint")
  await h.app.onKey("\t")
  await h.type("Keep the existing client API\r")
  expect(answers(h)).toHaveLength(0)
  expect(h.text().join("\n")).toContain("Review")
  expect(h.text().join("\n")).toContain("Checks: Types, Tests, Lint")
  await h.app.onKey("\x1b[Z")
  expect(h.text().join("\n")).toContain("Keep the existing client API")
  await h.app.onKey("\t")
  await h.app.onKey("\r")
  expect(answers(h)).toEqual([{ type: "request.resolve", sessionId: h.sessionId, requestId: h.requestId, decision: { kind: "answer", text: "Postgres\nTypes, Tests, Lint\nKeep the existing client API", answers: [["Postgres"], ["Types", "Tests", "Lint"], ["Keep the existing client API"]] } }])
  await h.app.onKey("\x03")
})

test("Enter toggles multi-select; Confirm can submit unanswered questions without selecting defaults", async () => {
  const h = b57Harness()
  await h.app.onKey("\t")
  await h.app.onKey("\r")
  await h.app.onKey("\r")
  expect(h.text().join("\n")).toContain("[ ] Types")
  await h.app.onKey("\t")
  await h.app.onKey("\t")
  expect(h.text().join("\n")).toContain("(not answered)")
  await h.app.onKey("\r")
  expect(answers(h)[0]).toMatchObject({ decision: { kind: "answer", answers: [[], [], []] } })
  await h.app.onKey("\x03")
})

test("editing custom text cancels locally; the next Esc rejects the whole request", async () => {
  const h = b57Harness()
  await h.app.onKey("\t")
  await h.app.onKey("3")
  await h.type("draft")
  await h.app.onKey("\x1b")
  expect(answers(h)).toHaveLength(0)
  await h.app.onKey("\x1b")
  expect(answers(h)[0]).toMatchObject({ decision: { kind: "deny" } })
  await h.app.onKey("\x03")
})

test("closed choices refuse custom typing and paste; a one-question batch submits immediately", async () => {
  const h = b57Harness(100, 30, [{ ...QUESTIONS[0]!, custom: false }])
  await h.type("custom")
  await h.app.onInput("\x1b[200~/tmp/example.txt\x1b[201~")
  expect(h.text().join("\n")).not.toContain("Type your own answer")
  expect(h.sentOf("attachment.ingest")).toHaveLength(0)
  await h.app.onKey("2")
  expect(answers(h)[0]).toMatchObject({ decision: { answers: [["Postgres"]] } })
  await h.app.onKey("\x03")
})

test("custom answers starting with a slash never run commands or show a slash popup", async () => {
  const h = b57Harness()
  await h.type("/help\r")
  expect(h.app.page).toBe("chat")
  expect(answers(h)).toHaveLength(0)
  await h.app.onKey("\x1b[Z")
  expect(h.text().join("\n")).toContain("/help")
  await h.app.onKey("\x03")
})

test("tab and option click regions are independent and survive narrow/wide panels", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [180, 50]]) {
    const h = b57Harness(width, height)
    const row = h.text().findIndex((line) => line.includes("Database") && line.includes("Checks"))
    const col = h.text()[row]!.indexOf("Checks")
    await h.app.onKey(`\x1b[<0;${col + 1};${row + 1}M`)
    expect(h.text().join("\n")).toContain("Which checks should run?")
    const option = h.text().findIndex((line) => line.includes("2. [ ] Tests"))
    await h.app.onKey(`\x1b[<0;${width > 110 ? 48 : 8};${option + 1}M`)
    expect(h.text().join("\n")).toContain("[✓] Tests")
    await h.app.onKey("\x03")
  }
})

test("a new request resets all batch draft state", async () => {
  const h = b57Harness()
  await h.app.onKey("2")
  await h.app.onKey("1")
  h.chat.emit({ type: "server.request.resolved", requestId: h.requestId, resolution: "denied" })
  h.chat.emit({ type: "server.request", requestId: ids("request"), turnId: h.turnId, kind: "question", title: "New", detail: "", questions: QUESTIONS })
  h.app.render()
  expect(h.text().join("\n")).toContain("Which database should the service use?")
  await h.app.onKey("\t")
  expect(h.text().join("\n")).toContain("[ ] Types")
  await h.app.onKey("\x03")
})

test("long question lists scroll to the selected option and fit the prompt at every supported size", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [220, 60]]) {
    const h = b57Harness(width, height, [{ header: "Checks", question: "Select checks", multiple: true, options: Array.from({ length: 9 }, (_, i) => ({ label: `Check ${i + 1}`, description: "Validate the service interfaces and rejection paths ".repeat(5) })) }])
    await h.app.onKey("9")
    h.app.render()
    expect(h.text().join("\n")).toContain("[✓] Check 9")
    expect(h.frames.at(-1)).toHaveLength(height)
    expect(h.text().every((line) => textWidth(line) <= width)).toBe(true)
    expect(h.cursors.at(-1)!.row).toBeLessThan(height)
    await h.app.onKey("\x03")
  }
})

test("TODO priorities and cancellation reach the dock, then an empty replacement clears it ", async () => {
  const h = appHarness({ width: 100, height: 30, dataDir: tempDir(), directory: tempDir() })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Plan the implementation", "Track work in Todos.")
  const add = (text: string, title: string) => {
    const turnId = ids("turn"), itemId = ids("item")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "todo" } })
    chat.emit({ type: "item.completed", itemId, status: "ok", text, meta: { tool: title } })
    chat.emit({ type: "turn.completed", turnId })
  }
  add("[ ] (high) Check interfaces\n[-] (low) Retire client", "todo 0/2")
  await h.app.onKey("\x14")
  expect(h.text().join("\n")).toContain("high · Check interfaces")
  expect(h.text().join("\n")).toContain("low · Retire client")
  expect(h.text().join("\n")).toContain("1 open")
  add("", "todo 0/0")
  h.app.render()
  expect(h.text().join("\n")).toContain("No todo items.")
  expect(h.text().slice(h.text().findIndex((row) => row.includes("0 open"))).join("\n")).not.toContain("high · Check interfaces")
  await h.app.onKey("\x03")
})

test("compact TODO dock uses one panel and keeps real priorities and open counts", () => {
  const todos = parseTodoText("[~] (high) Validate\n[-] (low) Retire")
  const rows = renderDock({ width: 60, todos, subagents: [], info: { cwd: "/work", permission: "ask", activity: "idle" } })
  const text = rows.map((row) => row.map((span) => span.text).join("")).join("\n")
  expect(text).toContain("high · Validate")
  expect(text).toContain("1 open")
  expect(text).not.toContain("Info")
})

test("the opt-in TODO sidebar retains priorities and cancellation, then clears its current list", async () => {
  for (const width of [100, 180]) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: true, sidebarWidgets: [{ type: "todos", options: {} }] })
    const h = appHarness({ width, height: 30, dataDir, directory: "/work/project" })
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("Track the work", "The task list is in the sidebar.")
    const replace = (text: string) => {
      const turnId = ids("turn"), itemId = ids("item")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "todo" } })
      chat.emit({ type: "item.completed", itemId, status: "ok", text })
      chat.emit({ type: "turn.completed", turnId })
      h.app.render()
    }
    replace("[~] (high) Validate\n[-] (low) Retire")
    expect(h.text().join("\n")).toContain("0/2 done")
    expect(h.text().join("\n")).toContain("▸ high · Validate")
    expect(h.text().join("\n")).toContain("× low · Retire")
    replace("")
    expect(h.text().join("\n")).toContain("No todos")
    await h.app.onKey("\x03")
  }
})

test("Review scroll stays bounded so one Up moves back after repeated Down keys", async () => {
  const questions = Array.from({ length: 32 }, (_, i) => ({ header: `Question ${i + 1}`, question: `Choice ${i + 1}?`, options: [] }))
  const h = b57Harness(60, 20, questions)
  await h.app.onKey("\x1b[Z")
  for (let i = 0; i < 80; i++) await h.app.onKey("\x1b[B")
  const end = h.text().join("\n")
  expect(end).toContain("Question 32: (not answered)")
  await h.app.onKey("\x1b[A")
  expect(h.text().join("\n")).not.toBe(end)
  await h.app.onKey("\x03")
})

test("long question/context introductions reserve visible choices and keep custom editing inside a short screen", async () => {
  const questions = [{ header: "Details", question: "Explain which integration should be preserved. ".repeat(10), context: "Keep the existing interfaces while migrating the service. ".repeat(50), options: [{ label: "Keep API" }] }]
  for (const width of [60, 100, 160, 220]) {
    const h = b57Harness(width, 20, questions)
    expect(h.text().join("\n")).toContain("1. Keep API")
    await h.app.onKey("2")
    await h.app.onInput("\x1b[200~First line\nSecond line\x1b[201~")
    expect(h.text().join("\n")).toContain("Second line")
    expect(h.frames.at(-1)).toHaveLength(20)
    expect(h.cursors.at(-1)!.row).toBeLessThan(20)
    await h.app.onKey("\x1b")
    await h.app.onKey("\x03")
  }
})
