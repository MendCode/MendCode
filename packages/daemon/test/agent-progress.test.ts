import { expect, test } from "bun:test"
import type { SessionEvent, SessionId, TaskRecord } from "@mendcode/protocol"
import { boundAnswer, createAgentProgress, PROGRESS_LIMITS, PROGRESS_SYSTEM } from "../src/agent-progress"

const PARENT = "ses_parent" as SessionId
const NOW = 1_000_000_000
let seq = 0
const started = (sessionId: string, itemId: string, kind: string, at: number, meta?: Record<string, string | number | boolean>) => ({ type: "item.started", sessionId, seq: ++seq, at, turnId: "turn_1", itemId, kind, ...(meta ? { meta } : {}) }) as unknown as SessionEvent
const completed = (sessionId: string, itemId: string, at: number, text: string, extra: Record<string, unknown> = {}) => ({ type: "item.completed", sessionId, seq: ++seq, at, itemId, status: "ok", text, ...extra }) as unknown as SessionEvent
const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({ taskId: "ses_child_abc" as SessionId, parentId: PARENT, rootId: PARENT, depth: 1, generation: 1, description: "audit the parser", agent: "general", background: true, state: "running", result: "", createdAt: NOW - 120_000, startedAt: NOW - 120_000, updatedAt: NOW - 1_000, ...patch })

function nativeThread(childId: string, calls: number) {
  const events: SessionEvent[] = [started(childId, "u1", "user_message", NOW - 119_000), completed(childId, "u1", NOW - 119_000, "Audit every parser file under src/parse and list the bugs you find.")]
  for (let index = 0; index < calls; index++) {
    events.push(started(childId, `t${index}`, "tool_call", NOW - 100_000 + index, { tool: `read: src/parse/file${index}.ts` }), completed(childId, `t${index}`, NOW - 99_000 + index, "contents"))
  }
  events.push(started(childId, "a1", "agent_message", NOW - 5_000), completed(childId, "a1", NOW - 4_000, "Found two off-by-one errors so far."))
  events.push(started(childId, "todo1", "tool_call", NOW - 3_000, { tool: "todo" }), completed(childId, "todo1", NOW - 2_900, "[x] read files\n[ ] list bugs"))
  return events
}

function harness(input: { tasks?: TaskRecord[]; threads?: Record<string, SessionEvent[]>; answer?: string | undefined; fail?: boolean }) {
  const asked: Array<{ sessionId: string; system: string; prompt: string }> = []
  const threads = input.threads ?? {}
  const service = createAgentProgress({
    now: () => NOW,
    tasks: { get: (id) => input.tasks?.find((entry) => entry.taskId === id), list: (parent) => (input.tasks ?? []).filter((entry) => entry.parentId === parent) },
    events: { tail: (id, limit) => (threads[id] ?? []).slice(-limit), head: (id, limit) => (threads[id] ?? []).slice(0, limit) },
    ask: async (request) => {
      asked.push({ sessionId: request.sessionId, system: request.system, prompt: request.prompt })
      if (input.fail) throw new Error("provider down")
      return "answer" in input ? input.answer : "Done: read 3 files.\nNow: listing bugs.\nLeft: the report.\nEstimate: about 2 minutes (rough)."
    },
  })
  return { service, asked, run: (taskId?: string) => service.progress(PARENT, taskId, new AbortController().signal) }
}

test("a native child's progress goes to the cheap model with its prompt, elapsed time, tool count, latest steps and todo list", async () => {
  const h = harness({ tasks: [task()], threads: { ses_child_abc: nativeThread("ses_child_abc", 3) } })
  const text = await h.run()
  expect(h.asked).toHaveLength(1)
  const sent = h.asked[0]!
  expect(sent.system).toBe(PROGRESS_SYSTEM)
  expect(sent.sessionId).toBe(PARENT)
  expect(sent.prompt).toContain("Audit every parser file under src/parse")
  expect(sent.prompt).toContain("Running for: 2m 0s")
  expect(sent.prompt).toContain("Tool calls so far: 4")
  expect(sent.prompt).toContain("tool: read: src/parse/file2.ts")
  expect(sent.prompt).toContain("said: Found two off-by-one errors so far.")
  expect(sent.prompt).toContain("[ ] list bugs")
  expect(text).toContain("audit the parser (ses_child_abc, agent general)")
  expect(text).toContain("State: running · 2m 0s · 4 tool calls")
  expect(text).toContain("Estimate: about 2 minutes (rough).")
})

test("a Claude Code sub-agent thread is read from the main session's items marked with its call, and only those", async () => {
  const call = "item_agent_1"
  const other = "item_agent_2"
  const events = [
    started(PARENT, call, "tool_call", NOW - 90_000, { tool: "agent review the API", subagent: true, background: true }),
    started(PARENT, other, "tool_call", NOW - 80_000, { tool: "agent write docs", subagent: true, background: true }),
    started(PARENT, "p1", "user_message", NOW - 89_000, { agentParent: call }), completed(PARENT, "p1", NOW - 89_000, "Review the public API for breaking changes."),
    started(PARENT, "x1", "tool_call", NOW - 70_000, { tool: "Grep: export", agentParent: call }), completed(PARENT, "x1", NOW - 69_000, "found"),
    started(PARENT, "x2", "tool_call", NOW - 60_000, { tool: "Read: docs/index.md", agentParent: other }), completed(PARENT, "x2", NOW - 59_000, "docs"),
    started(PARENT, "x3", "tool_call", NOW - 10_000, { tool: "Bash: git diff", agentParent: call }),
  ]
  const h = harness({ threads: { [PARENT]: events } })
  // Two run: the main agent must say which.
  const ambiguous = await h.run()
  expect(h.asked).toHaveLength(0)
  expect(ambiguous).toContain("2 sub-agents are running")
  expect(ambiguous).toContain(call)
  const text = await h.run(call)
  expect(h.asked).toHaveLength(1)
  const prompt = h.asked[0]!.prompt
  expect(prompt).toContain("Review the public API for breaking changes.")
  expect(prompt).toContain("tool: Grep: export")
  expect(prompt).toContain("tool: Bash: git diff (running)")
  expect(prompt).not.toContain("docs/index.md")
  expect(prompt).toContain("Tool calls so far: 2")
  expect(text).toContain("State: running · 1m 30s · 2 tool calls")
  // By its description too.
  await h.run("write docs")
  expect(h.asked[1]!.prompt).toContain("docs/index.md")
})

test("a Claude Code sub-agent woken after its end is running again, with no report of the earlier run", async () => {
  const call = "item_agent_3"
  const events = [
    started(PARENT, call, "tool_call", NOW - 90_000, { tool: "agent resumed one", subagent: true }),
    started(PARENT, "e1", "agent_message", NOW - 50_000, { agentParent: call }),
    completed(PARENT, "e1", NOW - 50_000, "First run done.", { meta: { agentParent: call, agentEnd: true } }),
    started(PARENT, "r1", "tool_call", NOW - 10_000, { tool: "Read: second.ts", agentParent: call }),
  ]
  const h = harness({ threads: { [PARENT]: events } })
  const text = await h.run()
  expect(text).not.toContain("It has finished")
  expect(h.asked).toHaveLength(1)
  expect(h.asked[0]!.prompt).toContain("tool: Read: second.ts (running)")
})

test("a finished Claude Code sub-agent whose end marker has no text reports its last message", async () => {
  const call = "item_agent_4"
  const events = [
    started(PARENT, call, "tool_call", NOW - 90_000, { tool: "agent quiet end", subagent: true }),
    started(PARENT, "s1", "agent_message", NOW - 6_000, { agentParent: call }),
    completed(PARENT, "s1", NOW - 6_000, "Two bugs found in the parser."),
    started(PARENT, "e1", "agent_message", NOW - 5_000, { agentParent: call }),
    completed(PARENT, "e1", NOW - 5_000, "", { meta: { agentParent: call, agentEnd: true } }),
  ]
  events[2] = completed(PARENT, "s1", NOW - 6_000, "Two bugs found in the parser.", { meta: { agentParent: call } })
  const h = harness({ threads: { [PARENT]: events } })
  expect(await h.run(call)).toContain("It has finished. Result: Two bugs found in the parser.")
  expect(h.asked).toHaveLength(0)
})

test("with a single running Claude Code sub-agent no id is needed", async () => {
  const call = "item_agent_1"
  const h = harness({ threads: { [PARENT]: [started(PARENT, call, "tool_call", NOW - 30_000, { tool: "agent check", subagent: true }), started(PARENT, "x1", "tool_call", NOW - 20_000, { tool: "Read: a.ts", agentParent: call }), completed(PARENT, "x1", NOW - 19_000, "ok")] } })
  expect(await h.run()).toContain("Estimate:")
  expect(h.asked[0]!.prompt).toContain("tool: Read: a.ts")
})

test("an unknown or finished sub-agent is answered plainly and never reaches the model", async () => {
  const done = task({ taskId: "ses_done" as SessionId, description: "old job", state: "completed", result: "Fixed the parser.", updatedAt: NOW - 60_000 })
  const call = "item_agent_9"
  const ended = [
    started(PARENT, call, "tool_call", NOW - 90_000, { tool: "agent finished one", subagent: true }),
    started(PARENT, "e1", "agent_message", NOW - 5_000, { agentParent: call }),
    completed(PARENT, "e1", NOW - 5_000, "All checked.", { meta: { agentParent: call, agentEnd: true, toolCalls: 3 } }),
  ]
  const h = harness({ tasks: [done], threads: { [PARENT]: ended } })
  const unknown = await h.run("ses_missing")
  expect(unknown).toContain("Unknown sub-agent ses_missing")
  expect(unknown).toContain("ses_done · completed · old job")
  const finished = await h.run("ses_done")
  expect(finished).toContain("It has finished. Result: Fixed the parser.")
  const engineDone = await h.run(call)
  expect(engineDone).toContain("It has finished. Result: All checked.")
  expect(engineDone).toContain("State: completed")
  expect(await h.run()).toContain("No sub-agent is running")
  expect(h.asked).toHaveLength(0)
  expect(await harness({}).run()).toContain("This conversation has started none")
})

test("too little data is said, not summarized; a missing or failing model gives the recorded steps, never a guess", async () => {
  const fresh = harness({ tasks: [task()], threads: { ses_child_abc: [] } })
  expect(await fresh.run()).toContain("no step yet")
  expect(fresh.asked).toHaveLength(0)
  const thread = { ses_child_abc: nativeThread("ses_child_abc", 3) }
  for (const input of [{ answer: undefined }, { fail: true }, { answer: "  \n " }]) {
    const text = await harness({ tasks: [task()], threads: thread, ...input }).run()
    expect(text).toContain("No helper model was available")
    expect(text).toContain("tool: read: src/parse/file2.ts")
  }
})

test("what goes to the model and what comes back are bounded, and secrets never go", async () => {
  const events = nativeThread("ses_child_abc", 200)
  events.push(started("ses_child_abc", "s1", "tool_call", NOW - 1_000, { tool: "shell: curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' x" }))
  const long = "word ".repeat(10_000)
  events.splice(1, 1, completed("ses_child_abc", "u1", NOW - 119_000, long))
  const h = harness({ tasks: [task()], threads: { ses_child_abc: events }, answer: Array.from({ length: 12 }, (_, index) => `line ${index} ${"x".repeat(300)}`).join("\n") })
  const text = await h.run()
  const prompt = h.asked[0]!.prompt
  expect(prompt.length).toBeLessThanOrEqual(PROGRESS_LIMITS.inputChars)
  expect(prompt.match(/^\d+\. /gm)).toHaveLength(PROGRESS_LIMITS.steps)
  expect(prompt).toContain("file199.ts")
  expect(prompt).not.toContain("file100.ts")
  expect(prompt).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")
  expect(prompt.includes(long)).toBe(false)
  expect(text.split("\n").length).toBeLessThanOrEqual(2 + PROGRESS_LIMITS.answerLines)
  expect(boundAnswer("a\n\n b \n").split("\n")).toEqual(["a", " b"])
})
