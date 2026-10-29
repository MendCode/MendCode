import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHerdrReporter, createTuiosChildren, createTuiosMeta, herdrPane, paneState, tuiosPane, waitingChild, type PaneChild } from "../src/herdr"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** A herdr socket that answers every request line and keeps what it was sent. */
function fakeHerdr() {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-"))
  const socket = path.join(dir, "herdr.sock")
  const received: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  const server: Server = createServer((connection) => {
    let buffer = ""
    connection.on("data", (data) => {
      buffer += String(data)
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        received.push(request)
        connection.write(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`)
      }
    })
  })
  server.listen(socket)
  cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })
  return { socket, received }
}

describe("herdr pane reporting", () => {
  test("only inside a pane: herdr's socket and pane id, unless MENDCODE_HERDR=0 or HERDR_ENV says otherwise", () => {
    expect(herdrPane({ HERDR_SOCKET_PATH: "/tmp/h.sock", HERDR_PANE_ID: "w1:p2" })).toEqual({ socket: "/tmp/h.sock", pane: "w1:p2" })
    expect(herdrPane({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h.sock", HERDR_PANE_ID: "w1:p2" })).toBeDefined()
    expect(herdrPane({ HERDR_SOCKET_PATH: "/tmp/h.sock" })).toBeUndefined()
    expect(herdrPane({ HERDR_SOCKET_PATH: "/tmp/h.sock", HERDR_PANE_ID: "w1:p2", MENDCODE_HERDR: "0" })).toBeUndefined()
    expect(herdrPane({ HERDR_ENV: "0", HERDR_SOCKET_PATH: "/tmp/h.sock", HERDR_PANE_ID: "w1:p2" })).toBeUndefined()
  })

  test("a turn at work is working, an approval is blocked, the rest is idle", () => {
    expect(["generating", "tool", "compacting", "cancelling"].map(paneState)).toEqual(["working", "working", "working", "working"])
    expect(paneState("waiting_approval")).toBe("blocked")
    expect(["idle", "queued", "error"].map(paneState)).toEqual(["idle", "idle", "idle"])
  })

  test("each change is one pane.report_agent with a growing seq and the resume command; repeats send nothing; quitting releases the pane", async () => {
    const herdr = fakeHerdr()
    let now = 1_000
    const reporter = createHerdrReporter({ socket: herdr.socket, pane: "w1:p2", program: "mendcode", now: () => now })
    await reporter.report({ state: "working", sessionId: "ses_1" })
    await reporter.report({ state: "working", sessionId: "ses_1" })
    await reporter.report({ state: "blocked", message: "approve  shell:\n git push", sessionId: "ses_1" })
    now = 500
    await reporter.report({ state: "idle", sessionId: "ses_1" })
    await reporter.release()
    await reporter.release()
    expect(herdr.received.map((request) => request.method)).toEqual(["pane.report_agent", "pane.report_agent", "pane.report_agent", "pane.release_agent"])
    expect(herdr.received[0]!.params).toEqual({ pane_id: "w1:p2", source: "mendcode", agent: "mendcode", seq: 1_000, state: "working", agent_session_id: "ses_1", resume_argv: ["mendcode", "--session", "ses_1"] })
    expect(herdr.received[1]!.params).toMatchObject({ state: "blocked", message: "approve shell: git push" })
    // The clock went back: the number still grows, so herdr does not ignore the report.
    expect(herdr.received.map((request) => request.params.seq)).toEqual([1_000, 1_001, 1_002, 1_003])
    expect(herdr.received[3]!.params).toEqual({ pane_id: "w1:p2", source: "mendcode", agent: "mendcode", seq: 1_003 })
  })

  test("a socket that is gone costs nothing: the report gives up without an error", async () => {
    const reporter = createHerdrReporter({ socket: path.join(tmpdir(), "no-herdr-here.sock"), pane: "w1:p2", program: "mendcode", now: () => 1 })
    await expect(reporter.report({ state: "working" })).resolves.toBeUndefined()
  })
})

describe("tuios agent metadata", () => {
  test("only in a tuios pane: its socket, pane and session, unless MENDCODE_HERDR=0", () => {
    const env = { TUIOS_ENV: "1", TUIOS_SOCKET: "/tmp/t.sock", TUIOS_PANE_ID: "abc", TUIOS_SESSION: "work" }
    expect(tuiosPane(env)).toEqual({ socket: "/tmp/t.sock", window: "abc", session: "work" })
    expect(tuiosPane({ ...env, TUIOS_ENV: undefined })).toBeUndefined()
    expect(tuiosPane({ ...env, MENDCODE_HERDR: "0" })).toBeUndefined()
  })

  test("model, context and cost reach tuios's rail when they change, and a fact that goes away is removed", async () => {
    const tuios = fakeHerdr()
    const meta = createTuiosMeta({ socket: tuios.socket, window: "abc", session: "work" })
    await meta.set({ model: "GPT-6.1 Sol", contextPercent: 42, costMicros: 123_456 })
    await meta.set({ model: "GPT-6.1 Sol", contextPercent: 42, costMicros: 123_456 })
    await meta.set({ model: "GPT-6.1 Sol", contextPercent: 43 })
    const verbs = (tuios.received as unknown as Array<{ verb: string; params: Record<string, unknown> }>).map((request) => request.verb)
    expect(verbs).toEqual(["hello", "set-agent-meta", "hello", "set-agent-meta"])
    const sets = (tuios.received as unknown as Array<{ verb: string; params: Record<string, unknown> }>).filter((request) => request.verb === "set-agent-meta").map((request) => request.params)
    expect(sets[0]).toEqual({ clear: false, source: "mendcode", tokens: { model: "GPT-6.1 Sol", context: "42%", cost: "$0.12" }, window: "abc", session: "work" })
    expect(sets[1]!.tokens).toEqual({ model: "GPT-6.1 Sol", context: "43%", cost: "" })
  })

  test("a socket nobody answers does not hold MendCode", async () => {
    const started = Date.now()
    await createTuiosMeta({ socket: path.join(tmpdir(), `missing-${Date.now()}.sock`), window: "abc" }).set({ model: "m" })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("sub-agents reach tuios's rail: each starts once, says what it does, ends as it ended; a new session forgets the old children", async () => {
    const tuios = fakeHerdr()
    const children = createTuiosChildren({ socket: tuios.socket, window: "abc", session: "work" })
    const activities = () => (tuios.received as unknown as Array<{ verb: string; params: { activity?: Record<string, unknown>; harness?: string; agent_session_id?: string } }>).filter((request) => request.verb === "report-agent-activity")
    const explore: PaneChild = { id: "ses_1", type: "explore · Sonnet 5.5 · claude", description: "Map the auth flow\nand more", state: "running" }
    const fix: PaneChild = { id: "item/2", type: "general-purpose", description: "Fix the test", state: "running" }
    await children.sync("ses_root", [explore, fix])
    await children.sync("ses_root", [explore, fix])
    await children.sync("ses_root", [{ ...explore, tool: "read src/auth.ts" }, fix])
    await children.sync("ses_root", [{ ...explore, state: "done", result: "Three entry points\nsrc/a.ts" }, { ...fix, state: "failed", result: "model error" }])
    expect(activities().every((request) => request.params.harness === "mendcode" && request.params.agent_session_id === "ses_root")).toBe(true)
    expect(activities().map((request) => request.params.activity)).toEqual([
      { event: "session_start" },
      { event: "subagent_start", agent_id: "ses_1", agent_type: "explore · Sonnet 5.5 · claude" },
      { event: "subagent_update", agent_id: "ses_1", text: "Map the auth flow" },
      { event: "subagent_start", agent_id: "item-2", agent_type: "general-purpose" },
      { event: "subagent_update", agent_id: "item-2", text: "Fix the test" },
      { event: "subagent_update", agent_id: "ses_1", text: "Map the auth flow", tool: "read src/auth.ts" },
      { event: "subagent_stop", agent_id: "ses_1", text: "Three entry points" },
      { event: "subagent_update", agent_id: "item-2", outcome: "failed", text: "model error" },
    ])
    tuios.received.splice(0)
    await children.sync("ses_root", [{ id: "ses_3", type: "general", description: "Long job", state: "running" }])
    await children.sync("ses_other", [])
    expect(activities().map((request) => [request.params.agent_session_id, request.params.activity!.event])).toEqual([["ses_root", "subagent_start"], ["ses_root", "subagent_update"], ["ses_other", "session_start"]])
  })

  test("a child gone from the list while running is stopped, one already ended when first seen is not reported, and leaving clears the rest", async () => {
    const tuios = fakeHerdr()
    const children = createTuiosChildren({ socket: tuios.socket, window: "abc" })
    const events = () => (tuios.received as unknown as Array<{ verb: string; params: { activity?: { event: string; agent_id?: string } } }>).filter((request) => request.verb === "report-agent-activity").map((request) => `${request.params.activity!.event}${request.params.activity!.agent_id ? ` ${request.params.activity!.agent_id}` : ""}`)
    await children.sync("ses_root", [{ id: "old", type: "general", description: "Done before", state: "done" }, { id: "a", type: "general", description: "A", state: "waiting", pending: "Allow shell" }, { id: "b", type: "general", description: "B", state: "running" }])
    await children.sync("ses_root", [{ id: "a", type: "general", description: "A", state: "waiting", pending: "Allow shell" }])
    await children.clear()
    await children.clear()
    expect(events()).toEqual(["session_start", "subagent_start a", "subagent_update a", "subagent_start b", "subagent_update b", "subagent_stop b", "session_start"])
    expect(waitingChild([{ id: "a", type: "general", description: "Fix the build", state: "waiting", pending: "Allow shell" }])).toBe("Fix the build: Allow shell")
    expect(waitingChild([{ id: "a", type: "general", description: "A", state: "running" }])).toBeUndefined()
  })
})
