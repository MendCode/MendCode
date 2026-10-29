import { afterEach, describe, expect, test } from "bun:test"
import type { AgentInfo, AgentsReport } from "@mendcode/protocol"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

function harness(options: { width?: number; current?: string; refuse?: boolean } = {}) {
  const directory = tempDir("agent-picker-")
  const agent = (name: string, description: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({ name, description, mode: "primary", source: "builtin", trusted: true, ...extra })
  const report: AgentsReport = {
    directory,
    current: options.current ?? "build",
    agents: [agent("build", "General agent"), agent("plan", "Read-only planning"), agent("reviewer", "Reviews changes"), agent("child", "Subagent", { mode: "subagent" }), agent("untrusted", "Project agent", { trusted: false })],
    problems: [],
  }
  const h = appHarness({ directory, width: options.width ?? 100, reply(command) {
    if (command.type === "agents.list") return { ok: true, result: report }
    if (command.type === "session.agent.set") {
      if (options.refuse) return { ok: false, error: { code: "target_mismatch", message: "[DAEMON]: agent is no longer trusted" } }
      report.current = command.agent ?? "build"
      return { ok: true, result: report }
    }
    return undefined
  } })
  const run = async (command: string) => { await h.type(command); await h.type("\r") }
  const text = () => h.text().join("\n")
  return { ...h, run, text }
}

describe("session agent picker in the app", () => {
  test("/agent opens the list with the current agent and descriptions; Enter selects", async () => {
    const h = harness()
    await h.run("/agent")
    expect(h.app.page).toBe("agent")
    expect(h.sentOf("agents.list")).toEqual([{ type: "agents.list", sessionId: h.sessionId }])
    expect(h.text()).toContain("build (current)")
    expect(h.text()).toContain("Reviews changes")
    expect(h.text()).not.toContain("Subagent")
    expect(h.text()).not.toContain("untrusted")
    await h.type("\x1b[B")
    await h.type("\x1b[B")
    await h.type("\r")
    expect(h.sentOf("session.agent.set")).toEqual([{ type: "session.agent.set", sessionId: h.sessionId, agent: "reviewer" }])
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("agent: reviewer")
  })

  test("selection starts at current; Esc closes without selecting", async () => {
    const h = harness({ current: "reviewer" })
    await h.run("/agent")
    expect(h.text()).toContain("reviewer (current)")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    expect(h.sentOf("session.agent.set")).toEqual([])
    await h.run("/agent")
    await h.type("\r")
    expect(h.sentOf("session.agent.set")[0]).toMatchObject({ agent: "reviewer" })
  })

  test("/agent <name> sets directly and toasts the acknowledged current agent", async () => {
    const h = harness()
    await h.run("/agent plan")
    expect(h.sentOf("session.agent.set")).toEqual([{ type: "session.agent.set", sessionId: h.sessionId, agent: "plan" }])
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("agent: plan")
  })

  test("an unknown name shows only the requested error and does not set an agent", async () => {
    const h = harness()
    await h.run("/agent missing")
    expect(h.sentOf("session.agent.set")).toEqual([])
    const error = h.text().split("\n").find((row) => row.includes("unknown agent:"))!
    expect(error).toContain("unknown agent: missing")
    expect(error).not.toMatch(/build|plan|reviewer|available/)
    expect(h.app.page).toBe("chat")
  })

  test("a refused selection stays in the picker and shows the daemon error", async () => {
    const h = harness({ refuse: true })
    await h.run("/agent")
    await h.type("\r")
    expect(h.app.page).toBe("agent")
    expect(h.text()).toContain("agent is no longer trusted")
    expect(h.text()).not.toContain("agent: build")
  })

  test("help and slash suggestions include /agent", async () => {
    const h = harness({ width: 140 })
    await h.type("/agen")
    expect(h.text()).toContain("Switch session agent")
    await h.type("\x15")
    await h.run("/help")
    expect(h.text()).toContain("Switch session agent")
  })

  test("picker frames fit narrow and wide terminals", async () => {
    for (const width of [40, 80, 140]) {
      const h = harness({ width })
      await h.run("/agent")
      for (const row of h.frames.at(-1)!) expect(textWidth(row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
      await h.type("\x1b")
    }
  })
})
