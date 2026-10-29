import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory, questionTool, todoTool, type ModelEvent, type ModelRequest } from "@mendcode/engine-native"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { callTool, stop, until } from "./native-harness"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const questions = [
  { question: "Which store?", header: "Store", options: [{ label: "SQLite, local" }, { label: "Postgres" }], custom: false },
  { question: "Which checks?", header: "Checks", options: [{ label: "Types" }, { label: "Tests" }], multiple: true },
  { question: "Any notes?", header: "Notes", options: [] },
]

async function boot(steps: ModelEvent[][]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-b57-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const requests: ModelRequest[] = []
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: () => createNativeEngine({
    provider: { id: "scripted", model: "script-1", async *stream(request) { requests.push({ ...request, messages: structuredClone(request.messages) }); yield* steps.shift() ?? stop("Done") } },
    tools: [questionTool, todoTool], history: memoryHistory(), cwdFor: () => dir, system: () => "BASE", compactionPrompt: "SUMMARIZE",
  }) })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "batch", onEvent: (event) => events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const reply = await client.send({ type: "session.create", directory: dir })
  if (!reply.ok) throw new Error(reply.error.message)
  const sessionId = reply.result!.sessionId as SessionId
  await client.subscribe(sessionId, 0)
  await client.send({ type: "user.submit", sessionId, text: "Plan the service", attachments: [] })
  return { daemon, client, sessionId, events, requests }
}

test("daemon replay and typed client preserve question batches and ordered answers with commas; first resolution wins", async () => {
  const h = await boot([callTool("question", { questions }), stop("Done")])
  await until(() => h.events.some((event) => event.type === "server.request"))
  const request = h.events.find((event) => event.type === "server.request")!
  expect(request.questions).toEqual(questions)
  const replay = await h.client.loadWindow(h.sessionId)
  expect(replay.ok && replay.window.events.find((event) => event.type === "server.request")).toMatchObject({ questions })
  const answers = [["SQLite, local"], ["Types", "Tests", "Lint, format"], ["Keep API"]]
  expect((await h.client.answerQuestions(h.sessionId, request.requestId, answers)).ok).toBe(true)
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", output: expect.stringContaining('"Which checks?"="Types, Tests, Lint, format"'), isError: false })
  expect(await h.client.answerQuestions(h.sessionId, request.requestId, answers)).toMatchObject({ ok: false, error: { code: "request_already_resolved" } })
})

test("invalid answer count, multiple picks on a single question, duplicate labels and closed custom answers leave the request pending", async () => {
  const h = await boot([callTool("question", { questions }), stop("Done")])
  await until(() => h.events.some((event) => event.type === "server.request"))
  const request = h.events.find((event) => event.type === "server.request")!
  for (const answers of [[["SQLite, local"]], [["SQLite, local", "Postgres"], [], []], [["SQLite, local"], ["Types", "Types"], []], [["Custom"], [], []]]) expect(await h.client.answerQuestions(h.sessionId, request.requestId, answers)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(h.requests).toHaveLength(1)
  expect((await h.client.answerQuestions(h.sessionId, request.requestId, [[], [], []])).ok).toBe(true)
  await until(() => h.requests.length === 2)
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ output: expect.stringContaining('"Which store?"="Unanswered"') })
})

test("rejecting a question batch resumes the model with the refusal", async () => {
  const h = await boot([callTool("question", { questions }), stop("Done")])
  await until(() => h.events.some((event) => event.type === "server.request"))
  const request = h.events.find((event) => event.type === "server.request")!
  expect((await h.client.send({ type: "request.resolve", sessionId: h.sessionId, requestId: request.requestId, decision: { kind: "deny", reason: "Need another approach" } })).ok).toBe(true)
  await until(() => h.requests.length === 2)
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ isError: true, output: "not answered: Need another approach" })
})

test("TODO priorities, cancelled/completed states and empty replacement persist in daemon events", async () => {
  const h = await boot([
    callTool("todo", { items: [{ text: "Verify", status: "in_progress", priority: "high" }, { text: "Retire", status: "cancelled", priority: "low" }, { text: "Read", status: "completed", priority: "medium" }] }),
    callTool("todo", { items: [] }), stop("Done"),
  ])
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  expect(h.requests[1]!.messages.at(-1)).toMatchObject({ output: "[~] (high) Verify\n[-] (low) Retire\n[x] (medium) Read", isError: false })
  expect(h.requests[2]!.messages.at(-1)).toMatchObject({ output: "", isError: false })
  const replay = await h.client.loadWindow(h.sessionId)
  if (!replay.ok) throw new Error(replay.error.message)
  const results = replay.window.events.filter((event) => event.type === "item.completed" && event.meta?.total !== undefined && event.meta?.done !== undefined)
  expect(results).toHaveLength(2)
  expect(results.at(-1)).toMatchObject({ text: "", meta: { done: 0, total: 0 } })
})
