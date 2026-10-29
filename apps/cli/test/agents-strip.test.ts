import { expect, test } from "bun:test"
import type { TaskRecord } from "@mendcode/protocol"
import { glyphs } from "../src/ui/theme"
import { AGENT_DONE_MS, AGENTS_SHOWN, renderAgentsStrip, stripActive, stripTasks, type AgentActivity } from "../src/view/agents-strip"
import { textWidth } from "../src/view/wrap"

const NOW = 1_800_000_000_000
const task = (over: Partial<TaskRecord> & { taskId: string }): TaskRecord => ({ parentId: "ses_parent", rootId: "ses_parent", depth: 1, generation: 1, description: "Review the Swift sources", agent: "explore", background: false, state: "running", result: "", createdAt: NOW - 72_000, updatedAt: NOW - 1_000, ...over } as TaskRecord)
const draw = (tasks: TaskRecord[], activity: Record<string, AgentActivity> = {}, width = 120, root = false) =>
  renderAgentsStrip({ tasks, activity: (id) => activity[id], now: NOW, width, inset: 3, glyphs: glyphs({}), root, openHint: "ctrl+x ↓ open · /tasks" }).rows.map((line) => line.map((span) => span.text).join(""))

test("no sub-agents, or only ones that ended a while ago, draw nothing", () => {
  expect(draw([])).toEqual([])
  expect(draw([task({ taskId: "ses_a", state: "completed", updatedAt: NOW - AGENT_DONE_MS })])).toEqual([])
  expect(stripActive([task({ taskId: "ses_a", state: "completed" })])).toBe(false)
})

test("under a working line the sub-agents are its tree: what each was asked, await or bg, what it does now and for how long; no spinner of their own", () => {
  const tasks = [task({ taskId: "ses_a" }), task({ taskId: "ses_b", description: "Implement the settings pane", agent: "general", background: true, createdAt: NOW - 123_000 }), task({ taskId: "ses_c", description: "Rank the feed", agent: "general", background: true, state: "needs_input", createdAt: NOW - 40_000 })]
  const activity = { ses_a: { state: "tool", tool: "read BrowserModel.swift" }, ses_b: { state: "generating" }, ses_c: { state: "waiting_approval", pending: "Run command" } } as const
  const rows = draw(tasks, activity)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatch(/^   ├ Review the Swift sources\s+explore\s+await\s+read BrowserModel\.swift\s+1m 12s$/)
  expect(rows[1]).toMatch(/^   ├ Implement the settings pane\s+general\s+bg\s+thinking\s+2m 3s$/)
  expect(rows[2]).toMatch(/^   └ Rank the feed\s+general\s+bg\s+needs you: Run command\s+40s$/)
  // The columns line up from row to row.
  expect(new Set(rows.map((row) => row.search(/await|bg {3}/))).size).toBe(1)
  for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(120)
  // Agents that are all the same kind do not spend a column saying so.
  expect(draw(tasks.slice(1), activity)[0]).toMatch(/^   ├ Implement the settings pane\s+bg\s+thinking\s+2m 3s$/)
})

test("while the session rests, a head line counts them and names the key that opens one", () => {
  const rows = draw([task({ taskId: "ses_b", background: true }), task({ taskId: "ses_c", background: true, state: "needs_input" })], {}, 120, true)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatch(/^   Agents  2 running · 1 needs you\s+ctrl\+x ↓ open · \/tasks$/)
  expect(rows[2]).toMatch(/^   └ /)
})

test("one that just ended shows its outcome under the ones at work, with the time it took, and then goes", () => {
  const tasks = [task({ taskId: "ses_done", description: "Old one", state: "completed", createdAt: NOW - 65_000, updatedAt: NOW - 5_000 }), task({ taskId: "ses_bad", description: "Broke", state: "failed", updatedAt: NOW - 2_000 }), task({ taskId: "ses_a" })]
  expect(stripTasks(tasks, NOW).map((each) => each.taskId)).toEqual(["ses_a", "ses_done", "ses_bad"])
  const rows = draw(tasks)
  expect(rows[1]).toMatch(/├ Old one.*done\s+1m 0s$/)
  expect(rows[2]).toMatch(/└ Broke.*failed/)
  expect(stripTasks(tasks, NOW + AGENT_DONE_MS).map((each) => each.taskId)).toEqual(["ses_a"])
})

test("more sub-agents than rows are counted, and a narrow terminal keeps every row inside its width", () => {
  const many = Array.from({ length: AGENTS_SHOWN + 3 }, (_, i) => task({ taskId: `ses_${i}`, description: `A long description of what sub-agent number ${i} was asked to do in this project` }))
  expect(draw(many).at(-1)).toMatch(/└ \+3 more · \/tasks$/)
  for (const width of [40, 60, 80, 100]) {
    const rows = draw(many, { ses_0: { state: "tool", tool: "shell bun test packages/engine-native/test/queue-policy.test.ts" } }, width)
    expect(rows).toHaveLength(AGENTS_SHOWN + 1)
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
    expect(rows[0]).toMatch(/\d+s$/)
  }
})

test("in the chat: a task.changed for the open session asks for its sub-agents and the strip stands over the prompt, with the live tool from the activity push", async () => {
  const { appHarness, cleanTemps, conversation, ids, tempDir } = await import("./session-ui-harness")
  try {
    const child = ids("session")
    let listed = 0
    let tasks: TaskRecord[] = []
    const h = appHarness({ width: 120, height: 30, dataDir: tempDir(), directory: tempDir(), reply: (command) => {
      if (command.type !== "task.list") return undefined
      listed++
      return { ok: true, result: { tasks } } as never
    } })
    h.app.applySettings({ onboarded: true, reducedMotion: true })
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("request", "answer")
    h.app.render()
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).not.toContain("Agents")
    tasks = [task({ taskId: child as never, parentId: h.sessionId as never, description: "Review the Swift sources", createdAt: Date.now() - 5_000, updatedAt: Date.now() })]
    const before = listed
    h.app.onGlobal({ type: "task.changed", gseq: 1, at: Date.now(), sessionId: child, parentId: h.sessionId } as never)
    h.app.onGlobal({ type: "session.activity", gseq: 2, at: Date.now(), sessionId: child, directory: "/repo", title: "Review", state: "tool", updatedAt: Date.now(), tool: "read BrowserModel.swift" } as never)
    await Bun.sleep(5)
    h.app.render()
    expect(listed).toBe(before + 1)
    const text = h.text()
    const head = text.findIndex((line) => /Agents\s+1 running/.test(line))
    expect(head).toBeGreaterThan(0)
    expect(text[head + 1]).toMatch(/└ Review the Swift sources\s+await\s+read BrowserModel\.swift/)
    // Over the prompt, under the transcript.
    expect(head).toBeGreaterThan(text.findIndex((line) => line.includes("answer")))
    expect(text).toHaveLength(30)
    // A change for another session's child asks nothing.
    h.app.onGlobal({ type: "task.changed", gseq: 3, at: Date.now(), sessionId: ids("session"), parentId: ids("session") } as never)
    await Bun.sleep(5)
    expect(listed).toBe(before + 1)
  } finally { cleanTemps() }
})

test("while a turn works the tree hangs under the working line, and the pet stands on the prompt beside it without covering a row's time", async () => {
  const path = await import("node:path")
  const { appHarness, cleanTemps, conversation, ids, tempDir } = await import("./session-ui-harness")
  try {
    const child = ids("session")
    let tasks: TaskRecord[] = []
    const h = appHarness({ width: 120, height: 30, dataDir: tempDir(), directory: tempDir(), pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: tempDir(), images: false }, reply: (command) => (command.type === "task.list" ? ({ ok: true, result: { tasks } } as never) : undefined) })
    h.app.applySettings({ onboarded: true, tier: "full", pet: "user:tiny", reducedMotion: true })
    await h.app.petReady
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("request", "answer")
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "foreground.state", state: "generating", turnId })
    tasks = [task({ taskId: child as never, parentId: h.sessionId as never, background: true, createdAt: Date.now() - 5_000, updatedAt: Date.now() })]
    h.app.onGlobal({ type: "task.changed", gseq: 1, at: Date.now(), sessionId: child, parentId: h.sessionId } as never)
    await Bun.sleep(5)
    h.app.render()
    const text = h.text()
    const row = text.findIndex((line) => line.includes("└ Review the Swift sources"))
    expect(row).toBeGreaterThan(0)
    expect(text.join("\n")).not.toContain("Agents ")
    // The working line is the row right over the tree; the prompt's rule the row right under it.
    expect(text[row - 1]).toMatch(/\d+s/)
    expect(text[row - 1]).not.toContain("Review")
    const petRows = h.frames.at(-1)!.flatMap((line, at) => line.some((span) => span.fgHex && /[▀▄]/.test(span.text)) ? [at] : [])
    expect(Math.max(...petRows)).toBe(row)
    // The row's time is whole, left of the pet's cells.
    expect(text[row]!.replace(/[▀▄\s]+$/, "")).toMatch(/\d+s$/)
    expect(text).toHaveLength(30)
  } finally { cleanTemps() }
})

test("a rule the pet stands on is cut clean, not ended with an ellipsis; text still gets one", async () => {
  const { withRightBlock } = await import("../src/view/prompt-chrome")
  const block = [{ text: "PET" }]
  const plain = (line: ReturnType<typeof withRightBlock>) => line.map((span) => span.text).join("")
  expect(plain(withRightBlock([{ text: `${"─".repeat(20)} Packing context ${"─".repeat(40)}` }], 60, block, 3))).toMatch(/─ PET$/)
  expect(plain(withRightBlock([{ text: "word ".repeat(20) }], 60, block, 3))).toMatch(/… ?PET$/)
  // A panel's side and its bottom corner are frame, like a rule: cut without a mark.
  expect(plain(withRightBlock([{ text: `│ idle${" ".repeat(52)}│` }], 60, block, 3))).not.toContain("…")
  expect(plain(withRightBlock([{ text: `└${"─".repeat(57)}┘` }], 60, block, 3))).not.toContain("…")
  expect(plain(withRightBlock([{ text: `│ ${"word ".repeat(12)}│` }], 60, block, 3))).toContain("…")
})

test("a pie's text is a round disc of dots with one colour per slice and a legend beside it; its disc rows say which chart they belong to", async () => {
  const { renderMermaid } = await import("../src/view/mermaid")
  const { pictureOf } = await import("../src/view/line-meta")
  const result = renderMermaid('pie title Tokens\n"MendCode": 138.543775\n"Codex CLI": 106.64183', 100)
  if (!("lines" in result)) throw new Error("no pie")
  const text = result.lines.map((line) => line.map((span) => span.text).join(""))
  expect(text.find((row) => row.includes("MendCode"))).toMatch(/^●{24} {3}● MendCode {3}138\.54 {2}56\.5%$/)
  expect(text.some((row) => /Total +245\.19$/.test(row))).toBe(true)
  expect(new Set(result.lines.flatMap((line) => line.filter((span) => span.text.includes("●"))).map((span) => span.fg))).toEqual(new Set(["info", "warning"]))
  const marked = result.lines.map(pictureOf).filter((cells) => cells !== undefined)
  expect(marked.map((cells) => cells.row)).toEqual(Array.from({ length: 12 }, (_, row) => row))
  expect(marked[0]).toMatchObject({ rows: 12, cols: 24, col: 0, key: expect.stringMatching(/^chart:/) })
  // Too narrow for a legend beside it: the legend goes below, and no row passes the width.
  const narrow = renderMermaid('pie\n"Done": 70\n"Todo": 30', 30)
  if (!("lines" in narrow)) throw new Error("no pie")
  expect(narrow.lines.map((line) => line.map((span) => span.text).join("")).at(-1)).toMatch(/^ {2}Total +100$/)
})

test("background commands join the sub-agents' tree: one block, the head counts both, one hint names /ps, the columns line up", () => {
  const tasks = [task({ taskId: "ses_a", description: "Corregir catálogo y continuidad visual", background: true, createdAt: NOW - 96_531_000 })]
  const rows = renderAgentsStrip({ tasks, activity: () => ({ state: "generating" }), now: NOW, width: 120, inset: 3, glyphs: glyphs({}), root: true, openHint: "ctrl+x ↓ open · /tasks", commands: [{ command: "bun run dev", kind: "command", startedAt: NOW - 673_000 }] }).rows.map((line) => line.map((span) => span.text).join(""))
  expect(rows).toHaveLength(3)
  expect(rows[0]).toMatch(/^   Agents  1 running · 1 command\s+ctrl\+x ↓ open · \/tasks · \/ps$/)
  expect(rows[1]).toMatch(/^   ├ Corregir catálogo y continuidad visual\s+bg\s+thinking\s+26h 48m$/)
  expect(rows[2]).toMatch(/^   └ bun run dev\s+cmd\s+11m 13s$/)
  expect(rows[1]!.indexOf("bg ")).toBe(rows[2]!.indexOf("cmd"))
  for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(120)
})

test("a child resumed a day after its first run counts from its current run, not from its creation", () => {
  const rows = draw([task({ taskId: "ses_a", generation: 2, createdAt: NOW - 26 * 3_600_000, startedAt: NOW - 95_000 })], { ses_a: { state: "generating", since: NOW - 26 * 3_600_000 } })
  expect(rows[0]).toMatch(/1m 35s$/)
})

test("each row names what it opens: the head and `+N more` nothing, a sub-agent its task, a command its background item", () => {
  const tasks = [task({ taskId: "ses_a", background: true }), task({ taskId: "ses_b", background: true })]
  const commands = [{ id: "bg_1", command: "bun test --watch", kind: "command" as const, startedAt: NOW - 60_000 }]
  const strip = (root: boolean) => renderAgentsStrip({ tasks, activity: () => undefined, now: NOW, width: 120, inset: 3, glyphs: glyphs({}), root, openHint: "ctrl+x ↓ open · /tasks", commands })
  expect(strip(false).ids).toEqual(["ses_a", "ses_b", "bg_1"])
  expect(strip(true).ids).toEqual([undefined, "ses_a", "ses_b", "bg_1"])
  for (const root of [false, true]) expect(strip(root).ids).toHaveLength(strip(root).rows.length)
  const crowd = Array.from({ length: AGENTS_SHOWN + 2 }, (_, at) => task({ taskId: `ses_${at}` }))
  const many = renderAgentsStrip({ tasks: crowd, activity: () => undefined, now: NOW, width: 120, inset: 3, glyphs: glyphs({}), root: false, openHint: "" })
  expect(many.ids).toEqual([...crowd.slice(0, AGENTS_SHOWN).map((entry) => entry.taskId), undefined])
})

test("what a sub-agent runs on is a line under its row, in its own colours, and its id opens the same agent; past the row budget the model goes on the row", () => {
  const facts = (model: string) => [{ text: model, fg: "body" as const }, { text: " · ", fg: "muted" as const }, { text: "claude", fg: "info" as const }, { text: " · ", fg: "muted" as const }, { text: "high", fg: "warning" as const }]
  const run = (entry: { taskId: string }) => facts(entry.taskId === "ses_a" ? "Sonnet 5.5" : "Opus 5.5")
  const two = renderAgentsStrip({ tasks: [task({ taskId: "ses_a", background: true }), task({ taskId: "ses_b", background: true })], run, activity: () => undefined, now: NOW, width: 80, inset: 3, glyphs: glyphs({}), root: false, openHint: "" })
  const text = two.rows.map((line) => line.map((span) => span.text).join(""))
  expect(text).toHaveLength(4)
  expect(text[1]).toBe("   │   Sonnet 5.5 · claude · high")
  expect(text[3]).toBe("       Opus 5.5 · claude · high")
  expect(two.ids).toEqual(["ses_a", "ses_a", "ses_b", "ses_b"])
  expect(two.rows[1]!.find((span) => span.text === "high")?.fg).toBe("warning")
  // Four agents and two commands would take ten rows: the model alone joins each row instead.
  const crowd = Array.from({ length: AGENTS_SHOWN }, (_, at) => task({ taskId: `ses_${at}`, background: true }))
  const commands = [{ id: "bg_1", command: "bun run dev", kind: "command" as const, startedAt: NOW }, { id: "bg_2", command: "bun test", kind: "command" as const, startedAt: NOW }]
  const tight = renderAgentsStrip({ tasks: crowd, run, activity: () => undefined, now: NOW, width: 80, inset: 3, glyphs: glyphs({}), root: false, openHint: "", commands })
  const rows = tight.rows.map((line) => line.map((span) => span.text).join(""))
  expect(rows).toHaveLength(AGENTS_SHOWN + 2)
  expect(rows[0]).toMatch(/Review the Swift sources\s+bg\s+Opus 5\.5\s+thinking/)
  for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(80)
})
