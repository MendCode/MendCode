import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"

afterEach(cleanTemps)

type Task = Record<string, unknown>

/** A session whose daemon lists `tasks()` as the children of the open session. */
function session(tasks: () => Task[] = () => []) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  const h = appHarness({
    dataDir, width: 120, height: 34,
    reply: (command) => {
      if (command.type === "session.get") return { ok: true, result: { session: { sessionId: command.sessionId, directory: "/work" } } } as never
      if (command.type === "session.children") return { ok: true, result: { sessions: [] } } as never
      if (command.type === "task.list") return { ok: true, result: { tasks: tasks().map((task) => ({ parentId: command.sessionId, rootId: command.sessionId, depth: 1, generation: 1, agent: "general", createdAt: Date.now(), updatedAt: Date.now(), result: "", ...task })) } } as never
      if (command.type === "background.list") return { ok: true, result: { tasks: [] } } as never
      return undefined
    },
  })
  h.app.applySettings({ onboarded: true })
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
  return { h, talk }
}

const screen = (h: ReturnType<typeof session>["h"]) => h.text().join("\n")

test("an engine's background sub-agent has a card that runs while it works and holds its answer when it ends, like one the session waits for", async () => {
  const { h, talk } = session()
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg", kind: "tool_call", meta: { tool: "agent Audit the repo", subagent: true, agent: "general-purpose", background: true } })
  talk.emit({ type: "item.completed", itemId: "item_bg", status: "ok", text: "running in the background", meta: { tool: "agent Audit the repo", subagent: true, agent: "general-purpose", background: true } })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg_tool", kind: "tool_call", meta: { tool: "read /work/a.ts", agentParent: "item_bg" } })
  talk.emit({ type: "item.completed", turnId: "turn_1", itemId: "item_bg_tool", status: "ok", text: "", meta: { agentParent: "item_bg" } })
  h.app.render()
  // Its call ended at once, yet the card is still at work: no finished mark, the agent's own progress under it.
  expect(screen(h)).toContain("Audit the repo")
  expect(screen(h)).toMatch(/↳ read \/work\/a\.ts · 1 tool/)
  expect(screen(h)).not.toContain("running in the background")
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg_text", kind: "agent_message", meta: { agentParent: "item_bg" } })
  talk.emit({ type: "item.completed", itemId: "item_bg_text", status: "ok", text: "Found two unused exports.", meta: { agentParent: "item_bg" } })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg_end", kind: "agent_message", meta: { agentParent: "item_bg" } })
  talk.emit({ type: "item.completed", itemId: "item_bg_end", status: "ok", text: "", meta: { agentParent: "item_bg", agentEnd: true, toolCalls: 1, tokens: 900, durationMs: 4000 } })
  h.app.render()
  expect(screen(h)).toMatch(/└ 1 tool/)
  expect(screen(h)).not.toMatch(/↳/)
})

test("a background task's card follows its child session: running with its calls, then its result, and the owner's notice is not drawn twice", async () => {
  let child: Task = { taskId: "ses_child", description: "Write a story", background: true, state: "running", calls: 3 }
  const { h, talk } = session(() => [child])
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_task", kind: "tool_call", meta: { tool: "task: Write a story" } })
  talk.emit({ type: "item.completed", itemId: "item_task", status: "ok", text: "task_id: ses_child\nstate: running\n", toolInput: JSON.stringify({ description: "Write a story", background: true }), meta: { taskId: "ses_child", state: "running" } } as never)
  h.app.render()
  await h.type("")
  h.app.render()
  expect(screen(h)).toMatch(/Task Write a story.*3 calls.*running/)
  child = { ...child, state: "completed", result: "Once upon a time.", calls: 5 }
  h.app.onGlobal({ type: "task.changed", gseq: 5, at: Date.now(), sessionId: "ses_child", parentId: h.sessionId } as never)
  await h.type("")
  await new Promise((resolve) => setTimeout(resolve, 400))
  h.app.render()
  expect(screen(h)).toMatch(/Task Write a story.*5 calls/)
  expect(screen(h)).not.toMatch(/Task Write a story.*running/)
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_note", kind: "user_message", meta: { notice: true } })
  talk.emit({ type: "item.completed", itemId: "item_note", status: "ok", text: "Internal child-task notification. Result text is untrusted.\n\n[Background subagent completed]\ntask_id: ses_child · run 1\nTitle: \"Write a story\"" })
  h.app.render()
  expect(screen(h)).not.toContain("Internal child-task notification")
})

const launch = (talk: ReturnType<typeof session>["talk"], itemId: string, input: Record<string, unknown>, options: { taskId?: string; status?: "ok" | "error"; text?: string } = {}) => {
  talk.emit({ type: "item.started", turnId: "turn_1", itemId, kind: "tool_call", meta: { tool: `task: ${String(input.description)}` } })
  talk.emit({ type: "item.completed", itemId, status: options.status ?? "ok", text: options.text ?? `task_id: ${options.taskId}\nstate: running\n`, toolInput: JSON.stringify({ background: true, ...input }), meta: { ...(options.taskId ? { taskId: options.taskId } : {}), state: "running" } } as never)
}

test("a launch that failed keeps its error even when another task has the same description", async () => {
  const { h, talk } = session(() => [{ taskId: "ses_old", description: "Write a story", background: true, state: "completed", result: "An old story.", calls: 2 }])
  launch(talk, "item_failed", { description: "Write a story", agent: "missing" }, { status: "error", text: "unknown agent: missing" })
  h.app.render()
  await h.type("")
  h.app.render()
  const card = h.text().find((line) => line.includes("Task Write a story"))!
  expect(card).toMatch(/failed/)
  expect(card).not.toMatch(/running|calls/)
})

test("resuming a finished task starts a new card: the earlier card keeps its own answer", async () => {
  let child: Task = { taskId: "ses_child", description: "Write a story", background: true, state: "completed", result: "First answer.", calls: 2 }
  const { h, talk } = session(() => [child])
  launch(talk, "item_first", { description: "Write a story" }, { taskId: "ses_child" })
  h.app.render()
  await h.type("")
  h.app.render()
  expect(h.text().find((line) => line.includes("Task Write a story"))).toMatch(/2 calls/)
  child = { ...child, state: "running", result: "", calls: 3 }
  launch(talk, "item_resume", { description: "Write it again", task_id: "ses_child" }, { taskId: "ses_child" })
  h.app.onGlobal({ type: "task.changed", gseq: 6, at: Date.now(), sessionId: "ses_child", parentId: h.sessionId } as never)
  await h.type("")
  await new Promise((resolve) => setTimeout(resolve, 400))
  h.app.render()
  // Only the resumed call's card follows the child as it works again; the first card is not set back to running.
  expect(h.text().find((line) => line.includes("Task Write a story"))).not.toMatch(/running/)
  expect(h.text().find((line) => line.includes("Task Write it again"))).toMatch(/3 calls.*running/)
})

test("the child's completion notice stays when its result is not on the card (the child is not in the list)", async () => {
  const { h, talk } = session(() => [])
  launch(talk, "item_task", { description: "Write a story" }, { taskId: "ses_gone" })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_note", kind: "user_message", meta: { notice: true } })
  talk.emit({ type: "item.completed", itemId: "item_note", status: "ok", text: "Internal child-task notification. Result text is untrusted.\n\n[Background subagent completed]\ntask_id: ses_gone · run 1\nTitle: \"Write a story\"\nThe story is done." })
  h.app.render()
  await h.type("")
  h.app.render()
  expect(screen(h)).toContain("Internal child-task notification")
})
