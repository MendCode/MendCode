import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

afterEach(cleanTemps)

/** A session whose engine reports two sub-agents of its own (the shape packages/engine-claude emits for Claude Code's Agent tool). */
async function chat(shells: Array<Record<string, unknown>> = []) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  const h = appHarness({
    dataDir, width: 110, height: 34,
    reply: (command) => {
      if (command.type === "session.get") return { ok: true, result: { session: { sessionId: command.sessionId, directory: "/work" } } } as never
      if (command.type === "session.children") return { ok: true, result: { sessions: [] } } as never
      if (command.type === "task.list") return { ok: true, result: { tasks: [] } } as never
      if (command.type === "background.list") return { ok: true, result: { tasks: shells.map((shell) => ({ sessionId: h.sessionId, ...shell })) } } as never
      return undefined
    },
  })
  h.app.applySettings({ onboarded: true })
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
  const call = (itemId: string, description: string) => talk.emit({ type: "item.started", turnId: "turn_1", itemId, kind: "tool_call", meta: { tool: `agent ${description}`, subagent: true, agent: "general-purpose", background: false } })
  const child = (parent: string, itemId: string, kind: "tool_call" | "user_message" | "agent_message", meta: Record<string, string | number | boolean> = {}) => talk.emit({ type: "item.started", turnId: "turn_1", itemId, kind, meta: { ...meta, agentParent: parent } })
  call("item_a", "Read a.txt")
  call("item_b", "Read b.txt")
  child("item_a", "item_a_prompt", "user_message")
  talk.emit({ type: "item.completed", itemId: "item_a_prompt", status: "ok", text: "Locate the file named a.txt and report it." })
  child("item_a", "item_a_tool", "tool_call", { tool: "read /work/a.txt" })
  child("item_b", "item_b_prompt", "user_message")
  talk.emit({ type: "item.completed", itemId: "item_b_prompt", status: "ok", text: "Second brief: report b.txt." })
  child("item_b", "item_b_tool", "tool_call", { tool: "$ find /work -name b.txt" })
  h.app.render()
  return { h, talk, child }
}

const screen = (h: Awaited<ReturnType<typeof chat>>["h"]) => h.text().join("\n")

test("an engine's own sub-agents are in the Agents strip with what each does now, and their steps stay out of the conversation", async () => {
  const { h } = await chat()
  const text = screen(h)
  expect(text).toMatch(/├ Read a\.txt\s+await\s+read \/work\/a\.txt · 1 tool/)
  expect(text).toMatch(/└ Read b\.txt\s+await\s+\$ find \/work -name b\.txt · 1 tool/)
  // Under each call, one line says what its sub-agent is doing; the sub-agent's prompt and tools are not rows of the chat.
  expect(text).toMatch(/↳ read \/work\/a\.txt · 1 tool/)
  expect(text).not.toContain("Locate the file named a.txt")
})

test("ctrl+x down opens the sub-agent at work in the chat's place; right changes sibling; up returns to the conversation where it was", async () => {
  const { h, talk } = await chat()
  await h.type("\x18\x1b[B")
  h.app.render()
  let text = screen(h)
  expect(text).toContain("1 of 2 · ←→ · ↑ back")
  expect(text).toContain("Locate the file named a.txt and report it.")
  expect(text).toContain("read /work/a.txt")
  expect(text).not.toContain("Second brief")
  // What the sub-agent does next shows while its thread is open; the session's events still reach the session.
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_a_tool2", kind: "tool_call", meta: { tool: "$ wc -c /work/a.txt", agentParent: "item_a" } })
  h.app.render()
  expect(screen(h)).toContain("wc -c /work/a.txt")
  await h.type("\x1b[C")
  h.app.render()
  text = screen(h)
  expect(text).toContain("Second brief: report b.txt.")
  expect(text).not.toContain("Locate the file named a.txt")
  await h.type("\x1b[A")
  h.app.render()
  text = screen(h)
  expect(text).not.toContain("↑ back")
  expect(text).toMatch(/↳ \$ wc -c \/work\/a\.txt · 2 tools/)
})

test("an open background sub-agent moves after its parent's turn ended: its model in the head, its own working row, its thinking", async () => {
  const { h, talk, child } = await chat()
  child("item_a", "item_a_think", "agent_message", { agentModel: "claude-sonnet-5-5-20260901" })
  talk.emit({ type: "item.completed", itemId: "item_a_think", status: "ok", text: "Checking the size next." })
  await h.type("\x18\x1b[B")
  h.app.render()
  const text = screen(h)
  expect(text).toMatch(/general-purpose · claude-sonnet-5-5 · await/)
  expect(text).toContain("Checking the size next.")
  expect(text).toMatch(/read \/work\/a\.txt\.\.\./)
})

test("a sub-agent that ended says what it took under its call and is no longer listed as at work", async () => {
  const { h, talk, child } = await chat()
  talk.emit({ type: "item.completed", itemId: "item_a_tool", status: "ok", text: "hello" })
  child("item_a", "item_a_end", "agent_message")
  talk.emit({ type: "item.completed", itemId: "item_a_end", status: "ok", text: "The file says hello.", meta: { agentParent: "item_a", agentEnd: true, toolCalls: 1, tokens: 33_406, durationMs: 9163 } })
  talk.emit({ type: "item.completed", itemId: "item_a", status: "ok", text: "The file says hello." })
  h.app.render()
  expect(screen(h)).toMatch(/└ 1 tool · .*33k tokens/)
  // It is no longer at work: the strip counts and lists the one that is.
  expect(screen(h)).toMatch(/Agents\s+1 running/)
  expect(screen(h)).toMatch(/└ Read b\.txt\s+await/)
  expect(screen(h)).not.toMatch(/[├└] Read a\.txt\s+await\s+read/)
})

test("a click on a sub-agent's row of the strip opens it", async () => {
  const { h } = await chat()
  const rows = h.text()
  const row = rows.findIndex((text) => /└ Read b\.txt\s+await/.test(text))
  const col = rows[row]!.indexOf("Read b.txt") + 3
  await h.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
  h.app.render()
  expect(screen(h)).toContain("2 of 2 · ←→ · ↑ back")
  expect(screen(h)).toContain("Second brief: report b.txt.")
})

test("a click on a sub-agent's call in the chat opens it: a thread of the session, or the child session its result names", async () => {
  const { h, talk } = await chat()
  const at = (pattern: RegExp) => { const rows = h.text(); const row = rows.findIndex((text) => pattern.test(text)); return { row, col: rows[row]!.search(pattern) + 4 } }
  const click = async ({ row, col }: { row: number; col: number }) => h.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
  await click(at(/agent Read a\.txt/))
  h.app.render()
  expect(screen(h)).toContain("Locate the file named a.txt and report it.")
  await h.type("\x1b[A")
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_task", kind: "tool_call", meta: { tool: "task: Write a story" } })
  talk.emit({ type: "item.completed", itemId: "item_task", status: "ok", text: "task_id: ses_child\nstate: completed\nOnce.", meta: { taskId: "ses_child", state: "completed" } })
  h.app.render()
  await click(at(/Task Write a story/))
  expect(h.sent.some((command) => "sessionId" in command && command.sessionId === "ses_child")).toBe(true)
})

test("each sub-agent has a colour of its own, the same on its card and on its strip row", async () => {
  const { subagentColor } = await import("../src/view/agent-color")
  expect(subagentColor("Read a.txt")).toBe(subagentColor("Read  a.txt "))
  expect(new Set(["Read a.txt", "Read b.txt", "Write a story", "Review the diff", "Rank the feed"].map(subagentColor)).size).toBeGreaterThan(2)
})

test("the full tier says what each sub-agent runs on, on its strip row and its card; the smaller tiers do not", async () => {
  const run = { model: "gpt-6-luna", provider: "openai", engine: "native", effort: "low", fast: true }
  const draw = async (tier: "full" | "balanced") => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
    const h = appHarness({
      dataDir, width: 170, height: 30,
      reply: (command) => {
        if (command.type === "task.list") return { ok: true, result: { tasks: [{ taskId: "ses_child", parentId: command.sessionId, rootId: command.sessionId, depth: 1, generation: 1, description: "Write a story", agent: "general", background: false, state: "running", result: "", createdAt: Date.now(), updatedAt: Date.now(), run }] } } as never
        return undefined
      },
    })
    h.app.applySettings({ onboarded: true, tier })
    const talk = conversation(h.sessionId, h.app.onEvent)
    talk.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
    talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_task", kind: "tool_call", meta: { tool: "task: Write a story" } })
    h.app.render()
    await h.type("")
    h.app.render()
    // The card's row is not one run of grey: the description, the model, the engine, the effort, fast and the state each have a colour.
    if (tier === "full") {
      const card = h.frames.at(-1)!.find((row) => row.map((span) => span.text).join("").includes("Task Write a story"))!
      const tones = new Set(card.filter((span) => span.text.trim() && !/^[·\s]+$/.test(span.text)).map((span) => span.fg))
      expect(tones.size).toBeGreaterThanOrEqual(5)
    }
    return h.text().join("\n")
  }
  const full = await draw("full")
  expect(full).toMatch(/[├└] Write a story\s+await\s+thinking.*\n.*│? +GPT-6-Luna · openai · native · low · fast/)
  expect(full).toMatch(/Task Write a story.*openai · native · low · fast/)
  const balanced = await draw("balanced")
  expect(balanced).toMatch(/[├└] Write a story\s+await/)
  expect(balanced).not.toContain("native · low")
})

test("a background sub-agent stays in the strip after its turn, while the daemon still runs it, instead of turning into a plain background row", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  let sessionId = ""
  let running = true
  const h = appHarness({
    dataDir, width: 110, height: 34,
    reply: (command) => {
      if (command.type === "session.get") return { ok: true, result: { session: { sessionId: command.sessionId, directory: "/work" } } } as never
      if (command.type === "session.children") return { ok: true, result: { sessions: [] } } as never
      if (command.type === "task.list") return { ok: true, result: { tasks: [] } } as never
      if (command.type === "background.list") return { ok: true, result: { tasks: running ? [{ id: "task_1", sessionId, command: "Survey the map", status: "running", kind: "agent", startedAt: Date.now() }] : [] } } as never
      return undefined
    },
  })
  sessionId = h.sessionId
  h.app.applySettings({ onboarded: true })
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg", kind: "tool_call", meta: { tool: "agent Survey the map", subagent: true, agent: "general-purpose", background: true } })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg_tool", kind: "tool_call", meta: { tool: "$ ls /maps", agentParent: "item_bg" } })
  talk.emit({ type: "turn.completed", turnId: "turn_1" })
  talk.emit({ type: "turn.started", turnId: "turn_2", queueId: "queue_2" })
  await Bun.sleep(5)
  h.app.render()
  let text = screen(h)
  expect(text).toMatch(/Survey the map\s+bg\s+\$ ls \/maps · 1 tool/)
  expect(text).not.toMatch(/◇ Survey the map\s+agent/)
  running = false
  talk.emit({ type: "turn.completed", turnId: "turn_2" })
  await Bun.sleep(5)
  h.app.render()
  text = screen(h)
  expect(text).not.toMatch(/Survey the map\s+bg\s+\$ ls/)
})

test("a background sub-agent named only once its call ended still matches the daemon's background work and stays in the strip", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  let sessionId = ""
  const h = appHarness({
    dataDir, width: 110, height: 34,
    reply: (command) => {
      if (command.type === "session.get") return { ok: true, result: { session: { sessionId: command.sessionId, directory: "/work" } } } as never
      if (command.type === "session.children") return { ok: true, result: { sessions: [] } } as never
      if (command.type === "task.list") return { ok: true, result: { tasks: [] } } as never
      if (command.type === "background.list") return { ok: true, result: { tasks: [{ id: "task_1", sessionId, command: "Survey the map", status: "running", kind: "agent", startedAt: Date.now() }] } } as never
      return undefined
    },
  })
  sessionId = h.sessionId
  h.app.applySettings({ onboarded: true })
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg", kind: "tool_call", meta: { tool: "agent", subagent: true, background: false } })
  talk.emit({ type: "item.completed", turnId: "turn_1", itemId: "item_bg", status: "ok", text: "running in the background", meta: { tool: "agent Survey the map", subagent: true, agent: "general-purpose", background: true } })
  talk.emit({ type: "turn.completed", turnId: "turn_1" })
  await Bun.sleep(5)
  h.app.render()
  const text = screen(h)
  expect(text).toMatch(/Survey the map\s+bg/)
  expect(text).not.toMatch(/◇ Survey the map\s+agent/)
})

test("an open sub-agent's thread has a header: its name, its place among its siblings and the keys, then what it is doing", async () => {
  const { h } = await chat()
  await h.type("\x18\x1b[B")
  h.app.render()
  const rows = h.text()
  const head = rows.findIndex((text) => text.includes("◆ Read a.txt"))
  expect(head).toBeGreaterThan(-1)
  expect(rows[head]).toContain("1 of 2 · ←→ · ↑ back")
  expect(rows[head + 1]).toMatch(/general-purpose · await · 1 tool · [^·]+ · read \/work\/a\.txt/)
  expect(rows[head + 2]).toMatch(/│\s+─{20,}\s*$/)
})

test("with background commands listed under the sub-agents, a click on the first row still opens the first sub-agent, and a command's row opens /ps on it", async () => {
  const { h } = await chat([{ id: "bg_cmd", command: "bun test --watch", kind: "command", startedAt: Date.now() - 60_000, status: "running" }])
  h.app.onGlobal({ type: "session.background.changed", gseq: 9, at: Date.now(), sessionId: h.sessionId } as never)
  await Bun.sleep(5)
  h.app.render()
  const click = async (pattern: RegExp) => {
    const rows = h.text()
    const row = rows.findIndex((text) => pattern.test(text))
    expect(row).toBeGreaterThanOrEqual(0)
    const col = rows[row]!.search(pattern) + 4
    await h.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
    h.app.render()
  }
  expect(screen(h)).toMatch(/└ bun test --watch\s+cmd/)
  await click(/Read a\.txt\s+await/)
  expect(screen(h)).toContain("1 of 2 · ←→ · ↑ back")
  await h.type("\x1b[A")
  h.app.render()
  await click(/bun test --watch\s+cmd/)
  expect(screen(h)).toContain("bun test --watch")
  expect(screen(h)).toMatch(/background/i)
})

test("after the daemon restarts, a background sub-agent that ended with the old one leaves the strip: the list is asked again on reconnect", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  let sessionId = ""
  let running = true
  const h = appHarness({
    dataDir, width: 110, height: 34,
    reply: (command) => {
      if (command.type === "session.get") return { ok: true, result: { session: { sessionId: command.sessionId, directory: "/work" } } } as never
      if (command.type === "task.list") return { ok: true, result: { tasks: [] } } as never
      if (command.type === "background.list") return { ok: true, result: { tasks: running ? [{ id: "task_1", sessionId, command: "Survey the map", status: "running", kind: "agent", startedAt: Date.now() }] : [] } } as never
      return undefined
    },
  })
  sessionId = h.sessionId
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(5)
  h.app.render()
  expect(screen(h)).toMatch(/Survey the map\s+bg/)
  // The daemon restarts: its new process runs nothing of the old one's, and sends no event about it.
  running = false
  await Bun.sleep(5)
  h.app.render()
  expect(screen(h)).toMatch(/Survey the map\s+bg/)
  h.app.onConnection("reconnecting")
  h.app.onConnection("connected")
  await Bun.sleep(5)
  h.app.render()
  expect(screen(h)).not.toMatch(/Survey the map\s+bg/)
})
