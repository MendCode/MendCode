import { afterEach, expect, test } from "bun:test"
import { createContinuity } from "../src/ui/app/continuity"
import { createTranscript } from "../src/view/transcript"
import { createTurnState } from "../src/view/turn-state"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
import type { ContinuitySummary, SessionEvent } from "@mendcode/protocol"
import type { AppContext } from "../src/ui/app/context"

afterEach(cleanTemps)
const questions = [{ header: "Database", question: "Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }], custom: false }]

test("async questions remain answerable after their originating turn completes at all supported sizes", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project" })
    const chat = conversation(h.sessionId, h.app.onEvent), turnId = ids("turn"), requestId = ids("request")
    chat.exchange("Research the service", "I can inspect files while you choose the store.")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "server.request", turnId, requestId, kind: "question", async: true, title: "Asked 1 question", detail: "", questions })
    chat.emit({ type: "turn.completed", turnId })
    h.app.render()
    expect(h.text().join("\n")).toContain("Which store?")
    expect(h.text().every((line) => textWidth(line) <= width)).toBe(true)
    expect(h.frames.at(-1)).toHaveLength(height)
    await h.app.onKey("2")
    expect(h.sentOf("request.resolve")).toEqual([{ type: "request.resolve", sessionId: h.sessionId, requestId, decision: { kind: "answer", text: "Postgres", answers: [["Postgres"]] } }])
    chat.emit({ type: "server.request.resolved", requestId, resolution: "answered" })
    await h.app.onKey("\x03")
  }
})

test("persisted tool-job state reaches the bordered Jobs dock and updates without changing chat content", async () => {
  for (const [width, height] of [[100, 30], [180, 50]]) {
    const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project" })
    const chat = conversation(h.sessionId, h.app.onEvent), turnId = ids("turn")
    chat.exchange("Read project files", "Independent work is complete.")
    const record: ContinuitySummary = { id: "job_read", sessionId: h.sessionId, turnId, kind: "job", tool: "read", status: "running", generation: 0, createdAt: NOW - 5000, updatedAt: NOW }
    chat.emit({ type: "continuity.updated", record })
    await h.app.onKey("\x14")
    expect(h.text().join("\n")).toContain("Jobs")
    expect(h.text().join("\n")).toContain("1 running")
    chat.emit({ type: "continuity.updated", record: { ...record, status: "completed", updatedAt: NOW + 1 } })
    h.app.render()
    expect(h.text().join("\n")).toContain("completed")
    expect(h.text().join("\n")).toContain("Independent work is complete.")
    expect(h.text().every((line) => textWidth(line) <= width)).toBe(true)
    await h.app.onKey("\x03")
  }
})

test("snapshot restoration loads older jobs/questions through CLI factories and late snapshots never resurrect resolved requests", async () => {
  const sessionId = ids("session"), turnId = ids("turn"), requestId = ids("request")
  const transcript = createTranscript(), turnState = createTurnState()
  const records: ContinuitySummary[] = [
    { id: "job_old", sessionId, turnId, kind: "job", tool: "grep", status: "running", generation: 0, createdAt: NOW - 5000, updatedAt: NOW - 5000 },
    { id: "question_old", sessionId, turnId, requestId, kind: "question", status: "pending", generation: 0, createdAt: NOW - 5000, updatedAt: NOW - 5000 },
  ]
  const commands: string[] = []
  const state = { sessionId, transcript, turnState }
  const factory = createContinuity({ state, requestFrame() {}, input: { async send(command: { type: string }) {
    commands.push(command.type)
    return { ok: true, result: command.type === "continuity.list" ? { records } : { record: { ...records[1], questions } } }
  } } } as unknown as AppContext)
  await factory.load()
  expect(commands).toEqual(["continuity.list", "continuity.get"])
  expect(transcript.continuityJobs).toMatchObject([{ tool: "grep", status: "running" }])
  expect(transcript.pendingRequests).toMatchObject([{ requestId }])
  expect(turnState.extras(requestId)).toMatchObject({ questions })
  const resolution: SessionEvent = { type: "server.request.resolved", sessionId, requestId, resolution: "answered", seq: 100, at: NOW }
  transcript.apply(resolution)
  turnState.apply(resolution)
  await factory.load()
  expect(transcript.pendingRequests).toHaveLength(0)
  expect(turnState.extras(requestId)).toEqual({})
  transcript.apply({ type: "continuity.updated", sessionId, seq: 101, at: NOW, record: { ...records[0]!, status: "completed", updatedAt: NOW } })
  await factory.load()
  expect(transcript.continuityJobs[0]!.status).toBe("completed")
})
