import { expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import type { SessionRecallPort } from "@mendcode/tools"
import { createNativeEngine, memoryHistory } from "../src"
import { SUMMARY_PREFIX } from "../src/compaction-policy"
import { callTool, ids, scriptedProvider, stop, turn } from "./harness"

function port() {
  const calls: Array<{ name: string; input: unknown }> = []
  let version = 0
  let text = ""
  const recall: SessionRecallPort = {
    search: (input) => (calls.push({ name: "search", input }), { session_id: ids("session"), messages: [], more: false }),
    read: (input) => (calls.push({ name: "read", input }), { session_id: ids("session"), messages: [], more: false }),
    notes: (input) => {
      calls.push({ name: "notes", input })
      if (input.action === "write") { version++; text = input.text ?? "" }
      return { version, current_version: version, text }
    },
  }
  return { calls, recall }
}

const active: Settings = { experimental: { session_recall: true, continue_loop_on_deny: true } }
const results = (requests: ReturnType<typeof scriptedProvider>["requests"]) => requests.at(-1)!.messages.filter((message) => message.role === "tool")

test("recall tool catalog requires a port and live opt-in policy", async () => {
  const mock = port()
  let settings: Settings = {}
  const script = scriptedProvider([stop("Off"), stop("On"), stop("Off again")])
  const engine = createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => mock.recall, permissionPolicy: () => settings })
  const input = turn({ text: "Check tools" }).input
  await engine.runTurn(input)
  settings = active
  await engine.runTurn({ ...input, turnId: ids("turn") })
  settings = {}
  await engine.runTurn({ ...input, turnId: ids("turn") })
  const names = script.requests.map((request) => request.tools.map((tool) => tool.name))
  expect(names[0]).not.toContain("session_read")
  expect(names[1]).toEqual(expect.arrayContaining(["session_search", "session_read", "session_notes"]))
  expect(names[2]).not.toContain("session_notes")
  const noPort = scriptedProvider([stop("No port")])
  await createNativeEngine({ provider: noPort.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", permissionPolicy: () => active }).runTurn(turn({ text: "Hello" }).input)
  expect(noPort.requests[0]!.tools.map((tool) => tool.name)).not.toContain("session_search")
})

test("search and read dispatch through the current session's bound port", async () => {
  const mock = port()
  const sessionId = ids("session")
  const childId = ids("session")
  const origins: string[] = []
  const script = scriptedProvider([callTool("session_search", { query: "decision", session_id: childId }), callTool("session_read", { limit: 2 }), stop("Read")])
  const engine = createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: (id) => (origins.push(id), mock.recall), permissionPolicy: () => active })
  const current = turn({ text: "Recall the decision", sessionId })
  expect(await engine.runTurn(current.input)).toMatchObject({ status: "ok" })
  expect(origins).toEqual([sessionId, sessionId])
  expect(mock.calls).toEqual([{ name: "search", input: { query: "decision", session_id: childId } }, { name: "read", input: { limit: 2 } }])
  expect(current.asked).toEqual([])
  expect(results(script.requests).map((message) => message.role === "tool" && message.isError)).toEqual([false, false])
})

test("notes can be read in plan mode but writes require write authority", async () => {
  const mock = port()
  const script = scriptedProvider([callTool("session_notes", { action: "read" }), callTool("session_notes", { action: "write", version: 0, text: "Denied" }), stop("Proposed")])
  const engine = createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => mock.recall, permissionPolicy: () => active })
  const current = turn({ text: "Review working notes", mode: () => "plan" })
  await engine.runTurn(current.input)
  expect(mock.calls).toEqual([{ name: "notes", input: { action: "read" } }])
  expect(current.asked).toEqual([])
  expect(JSON.stringify(results(script.requests))).toContain("plan mode is read-only")
})

test("notes writes ask in ask mode, then return the new revision", async () => {
  const mock = port()
  const script = scriptedProvider([callTool("session_notes", { action: "write", version: 0, text: "Decision" }), stop("Saved")])
  const engine = createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => mock.recall, permissionPolicy: () => active })
  const current = turn({ text: "Save notes", answers: [{ kind: "approve", scope: "once" }] })
  await engine.runTurn(current.input)
  expect(current.asked).toMatchObject([{ kind: "approval", tool: "session_notes", permission: "write" }])
  expect(mock.calls).toHaveLength(1)
  expect(JSON.stringify(results(script.requests))).toContain("Decision")
})

test("an extension rewrite from notes read to write is rechecked", async () => {
  const mock = port()
  const script = scriptedProvider([callTool("session_notes", { action: "read" }), stop("Refused")])
  const engine = createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => mock.recall, permissionPolicy: () => active, hooks: { has: (event) => event === "tool.before", toolBefore: async () => ({ args: { action: "write", version: 0, text: "Escalated" } }) } })
  await engine.runTurn(turn({ text: "Read", mode: () => "plan" }).input)
  expect(mock.calls).toEqual([])
  expect(JSON.stringify(results(script.requests))).toContain("rewritten call denied")
})

test("disabled calls, permission denies and invalid inputs cannot reach recall", async () => {
  for (const settings of [{}, { ...active, permission: { session_read: "deny" as const } }]) {
    const mock = port()
    const script = scriptedProvider([callTool("session_read", {}), stop("Denied")])
    const engine = createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => mock.recall, permissionPolicy: () => settings })
    await engine.runTurn(turn({ text: "Read" }).input)
    expect(mock.calls).toEqual([])
  }
  const mock = port()
  const script = scriptedProvider([callTool("session_search", { query: "" }), stop("Invalid")])
  await createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => mock.recall, permissionPolicy: () => active }).runTurn(turn({ text: "Search" }).input)
  expect(mock.calls).toEqual([])
  expect(JSON.stringify(results(script.requests))).toContain("invalid arguments")
})

test("recall isolation and revision errors return model-visible tool failures", async () => {
  const mock = port()
  mock.recall.notes = () => { throw new Error("Notes changed; read current notes before writing") }
  const script = scriptedProvider([callTool("session_notes", { action: "write", version: 0, text: "Stale" }), stop("Read again")])
  await createNativeEngine({ provider: script.provider, tools: [], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => mock.recall, permissionPolicy: () => active }).runTurn(turn({ text: "Save", mode: () => "full" }).input)
  expect(JSON.stringify(results(script.requests))).toContain("Notes changed")
  expect(results(script.requests)[0]).toMatchObject({ isError: true })
})

test("auto_recall: after a compaction the matching packed-away turns follow the request as a session_search result", async () => {
  const sessionId = ids("session")
  const history = memoryHistory()
  await history.save(sessionId, [
    { role: "user", content: `${SUMMARY_PREFIX}\nWe set up the deploy pipeline.` },
    { role: "user", content: "Kept tail: rename the deploy job" },
    { role: "assistant", content: "Renamed.", toolCalls: [] },
  ])
  const queries: string[] = []
  const recall: SessionRecallPort = {
    ...port().recall,
    relevant: ({ query }) => (queries.push(query), [
      { turn: 4, at: Date.now() - 3 * 3_600_000, user: "Why did the deploy fail?", assistant: "The token expired; rotated it.", score: 5 },
      { turn: 9, at: Date.now(), user: "Kept tail: rename the deploy job", assistant: "Renamed.", score: 2 },
    ]),
  }
  const script = scriptedProvider([stop("Done")])
  const engine = createNativeEngine({ provider: script.provider, tools: [], history, cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => recall, permissionPolicy: () => ({}) })
  const current = turn({ text: "The deploy token expired again", sessionId })
  expect(await engine.runTurn(current.input)).toMatchObject({ status: "ok" })
  expect(queries).toEqual(["The deploy token expired again"])
  const sent = script.requests[0]!.messages
  const request = sent.findIndex((message) => message.role === "user" && message.content === "The deploy token expired again")
  expect(sent[request + 1]).toMatchObject({ role: "assistant", toolCalls: [{ name: "session_search" }] })
  const output = (sent[request + 2] as { output: string }).output
  expect(output).toContain("## Turn 4 · 3 h ago\nUser: Why did the deploy fail?\nAssistant: The token expired; rotated it.")
  expect(output).not.toContain("Turn 9")
  expect(current.events.filter((event) => event.type === "item.started" && event.meta?.injected)).toHaveLength(1)
})

test("auto_recall: nothing is added before any compaction, or when the port recalls nothing", async () => {
  const relevant: string[] = []
  const recall: SessionRecallPort = { ...port().recall, relevant: ({ query }) => (relevant.push(query), []) }
  const script = scriptedProvider([stop("One"), stop("Two")])
  const sessionId = ids("session")
  const history = memoryHistory()
  const engine = createNativeEngine({ provider: script.provider, tools: [], history, cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", recall: () => recall, permissionPolicy: () => ({}) })
  await engine.runTurn(turn({ text: "First request", sessionId }).input)
  expect(relevant).toEqual([])
  await history.save(sessionId, [{ role: "user", content: `${SUMMARY_PREFIX}\nEarlier work.` }])
  await engine.runTurn(turn({ text: "Second request", sessionId }).input)
  expect(relevant).toEqual(["Second request"])
  expect(script.requests[1]!.messages.some((message) => message.role === "tool")).toBe(false)
})
