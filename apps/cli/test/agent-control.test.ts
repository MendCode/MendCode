import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { Line } from "../src/ui/theme"
import { parseAutomation, runAutomation } from "../src/automation"
import { agentsPageKey, createAgentsPageState, renderAgentsPage, sessionStateLabel, type AgentSession } from "../src/view/agents-page"
import { renderQueuePanel } from "../src/view/queue-panel"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)
const text = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join("")).join("\n")
const session = (id: string, over: Partial<AgentSession> = {}): AgentSession => ({ sessionId: id, title: `session ${id}`, directory: "/work/app", state: "generating", updatedAt: NOW, queued: 0, ...over })

describe("Agent View control keys", () => {
  const sessions = [session("a", { since: NOW - 1000 }), session("b", { state: "idle", paused: true })]

  test("p pauses a running session and resumes a paused one, on the highlighted row", () => {
    const first = agentsPageKey(createAgentsPageState(), "p", sessions)
    expect(first.action).toEqual({ type: "control", sessionId: "a", action: "pause" })
    const second = agentsPageKey({ selected: "b" }, "p", sessions)
    expect(second.action).toEqual({ type: "control", sessionId: "b", action: "resume" })
  })

  test("x needs a second x on the same row; any other key drops the confirmation", () => {
    const armed = agentsPageKey(createAgentsPageState(), "x", sessions)
    expect(armed.action).toEqual({ type: "none" })
    expect(armed.state.confirm).toBe("a")
    expect(text(renderAgentsPage({ sessions, state: armed.state, width: 100, height: 24, now: NOW }))).toContain("x again to stop")
    expect(agentsPageKey(armed.state, "x", sessions)).toMatchObject({ action: { type: "control", sessionId: "a", action: "stop" }, state: {} })
    const dropped = agentsPageKey(armed.state, "j", sessions)
    expect(dropped.state.confirm).toBeUndefined()
    expect(agentsPageKey(dropped.state, "x", sessions).action).toEqual({ type: "none" })
    const moved = agentsPageKey({ ...armed.state, selected: "b" }, "x", sessions)
    expect(moved.action).toEqual({ type: "none" })
    expect(moved.state.confirm).toBe("b")
  })

  test("nothing to control on the Done tab or with no rows", () => {
    expect(agentsPageKey({ tab: 1 }, "p", sessions).action).toEqual({ type: "none" })
    expect(agentsPageKey({}, "x", []).action).toEqual({ type: "none" })
  })

  test("a paused idle session stays listed and reads paused; a running one reads pausing", () => {
    expect(sessionStateLabel({ state: "idle", paused: true })).toBe("paused")
    expect(sessionStateLabel({ state: "queued", paused: true })).toBe("paused")
    expect(sessionStateLabel({ state: "generating", paused: true })).toBe("working · pausing")
    expect(sessionStateLabel({ state: "generating" })).toBe("working")
    const frame = text(renderAgentsPage({ sessions: [session("b", { state: "idle", paused: true, title: "held work" })], state: createAgentsPageState(), width: 100, height: 24, now: NOW }))
    expect(frame).toContain("held work")
    expect(frame).toContain("paused")
  })

  test("the chat queue says Paused and points at /unpause instead of ctrl+s", () => {
    const rows = text(renderQueuePanel({ width: 100, previews: ["next thing"], held: true, paused: true }).rows)
    expect(rows).toContain("Paused")
    expect(rows).toContain("/unpause")
    expect(rows).not.toContain("ctrl+s continue")
  })
})

describe("TUI control", () => {
  function harness(width = 100, height = 30) {
    const sessionId = ids("session")
    const other = ids("session")
    const h = appHarness({ width, height, sessionId, dataDir: tempDir(), directory: "/work/app", reply(command) {
      if (command.type === "session.list") return { ok: true, result: { sessions: [
        { sessionId, title: "Main work", directory: "/work/app", createdAt: NOW, updatedAt: NOW, lastSeq: 1, state: "generating", queued: 0, since: NOW - 5000 },
        { sessionId: other, title: "Held work", directory: "/work/app", createdAt: NOW, updatedAt: NOW - 10, lastSeq: 1, state: "idle", queued: 0, paused: true },
      ] } }
      if (command.type === "session.control") return { ok: true, result: { paused: command.action === "pause", cancelledTurn: command.action === "stop", cancelledChildren: command.action === "stop" ? 2 : 0 } }
      return undefined
    } })
    h.app.applySettings({ onboarded: true, reducedMotion: true })
    return { ...h, sessionId, other }
  }
  const controls = (h: ReturnType<typeof harness>) => h.sentOf("session.control") as Array<Extract<CommandInput, { type: "session.control" }>>

  test("/agents p pauses the highlighted session, then x x stops it", async () => {
    const h = harness()
    await h.type("/agents\r")
    expect(h.text().join("\n")).toContain("Main work")
    expect(h.text().join("\n")).toContain("Held work")
    await h.type("p")
    expect(controls(h)[0]).toMatchObject({ sessionId: h.sessionId, action: "pause" })
    await h.type("x")
    expect(controls(h)).toHaveLength(1)
    expect(h.text().join("\n")).toContain("x again to stop")
    await h.type("x")
    expect(controls(h)[1]).toMatchObject({ sessionId: h.sessionId, action: "stop" })
    expect(h.text().join("\n")).toContain("2 sub-agents cancelled")
  })

  test("a paused row resumes with p", async () => {
    const h = harness()
    await h.type("/agents\r")
    await h.type("j")
    await h.type("p")
    expect(controls(h)[0]).toMatchObject({ sessionId: h.other, action: "resume" })
  })

  test("/pause, /unpause and /stop act on the current session or a given id", async () => {
    const h = harness()
    await h.type("/pause\r")
    expect(controls(h)[0]).toMatchObject({ sessionId: h.sessionId, action: "pause" })
    await h.type(`/unpause ${h.other}\r`)
    expect(controls(h)[1]).toMatchObject({ sessionId: h.other, action: "resume" })
    await h.type("/unpause\r")
    expect(controls(h)[2]).toMatchObject({ sessionId: h.sessionId, action: "resume" })
    await h.type("/stop\r")
    expect(controls(h)[3]).toMatchObject({ sessionId: h.sessionId, action: "stop" })
    expect(h.sentOf("user.submit")).toHaveLength(0)
  })
})

describe("CLI session pause, resume and stop", () => {
  const parse = (...args: string[]) => {
    const result = parseAutomation(args)
    if (result.ok !== true) throw new Error(JSON.stringify(result))
    return result.command
  }
  function deps(reply: (command: CommandInput) => CommandReply) {
    const sent: CommandInput[] = []
    let output = ""
    let errors = ""
    return { sent, out: () => output, errors: () => errors, deps: { client: { send: async (command: CommandInput): Promise<CommandReply> => { sent.push(command); return reply(command) }, subscribe: async () => ({ ok: true as const }) }, listen() {}, out: { write: (value: string) => { output += value } }, err: { write: (value: string) => { errors += value } }, cwd: "/project", now: () => NOW } }
  }

  test("each verb parses an exact id and sends session.control", async () => {
    const id = ids("session")
    expect(parse("session", "pause", id)).toMatchObject({ kind: "session.pause", id })
    expect(parse("session", "resume", id)).toMatchObject({ kind: "session.resume", id })
    expect(parse("session", "stop", id)).toMatchObject({ kind: "session.stop", id })
    expect(parseAutomation(["session", "pause"])).toMatchObject({ ok: false })
    expect(parseAutomation(["session", "stop", id, "extra"])).toMatchObject({ ok: false })
    const h = deps((command) => ({ ok: true, result: command.type === "session.control" ? { paused: command.action === "pause", cancelledTurn: command.action === "stop", cancelledChildren: 1 } : {} }))
    expect(await runAutomation(parse("session", "pause", id), h.deps)).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "session.control", sessionId: id, action: "pause" })
    expect(h.out()).toContain(`Paused ${id}`)
    expect(await runAutomation(parse("session", "resume", id), h.deps)).toBe(0)
    expect(h.sent.at(-1)).toEqual({ type: "session.control", sessionId: id, action: "resume" })
    expect(await runAutomation(parse("session", "stop", id), h.deps)).toBe(0)
    expect(h.out()).toContain("turn cancelled, 1 sub-agent cancelled")
  })

  test("--json uses the result envelope and a refusal exits non-zero", async () => {
    const id = ids("session")
    const ok = deps(() => ({ ok: true, result: { paused: true, cancelledTurn: false, cancelledChildren: 0 } }))
    expect(await runAutomation(parse("session", "pause", id, "--json"), ok.deps)).toBe(0)
    expect(JSON.parse(ok.out().trim().split("\n").at(-1)!).data).toMatchObject({ sessionId: id, action: "pause", paused: true })
    const refused = deps(() => ({ ok: false, error: { code: "unknown_session", message: "[DAEMON]: unknown session" } }))
    expect(await runAutomation(parse("session", "stop", id), refused.deps)).not.toBe(0)
    expect(refused.errors()).toContain("unknown session")
  })
})
