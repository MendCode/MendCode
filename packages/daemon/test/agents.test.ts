import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createIdFactory, type AgentsReport } from "@mendcode/protocol"
import type { ModelEvent } from "@mendcode/engine-native"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { boot, callTool, openSession, put, say, stop, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup()
})

async function start(steps: Parameters<typeof boot>[0] = {}) {
  const h = await boot(steps)
  harnesses.push(h)
  return h
}

const agentFile = (frontmatter: string, body = "Be helpful.") => `---\n${frontmatter}\n---\n${body}`
const report = (ack: { ok: boolean; result?: unknown }) => (ack as { ok: true; result: AgentsReport }).result
const error = (ack: { ok: boolean }) => (ack as { ok: false; error: { code: string; message: string } }).error

async function trust(h: NativeHarness, trusted = true) {
  await h.client.send({ type: "tools.trust", directory: h.project, trusted })
}

describe("agents.list", () => {
  test("lists the built-in agents, user agents, project agents with their trust, and files that cannot be used", async () => {
    const h = await start()
    put(path.join(h.dir, "agents", "reviewer.md"), agentFile("description: Reviews diffs\nmode: primary\ntools: read, grep\npermission: ask\nmodel: gpt-6-sol\neffort: high"))
    put(path.join(h.project, ".mendcode", "agents", "scout.md"), agentFile("description: Finds things\nmode: subagent"))
    put(path.join(h.dir, "agents", "broken.md"), agentFile("tools: read"))
    const before = report(await h.client.send({ type: "agents.list", directory: h.project }))
    expect(before.agents.map((a) => [a.name, a.source, a.mode, a.trusted])).toEqual([
      ["build", "builtin", "primary", true],
      ["plan", "builtin", "primary", true],
      ["general", "builtin", "subagent", true],
      ["explore", "builtin", "subagent", true],
      ["reviewer", "user", "primary", true],
      ["scout", "project", "subagent", false],
    ])
    expect(before.agents.find((a) => a.name === "reviewer")).toMatchObject({ tools: ["read", "grep"], permission: "ask", model: "gpt-6-sol", effort: "high" })
    expect(before.problems.map((p) => [path.basename(p.file), p.message.slice(0, 20)])).toEqual([["broken.md", "description is requi"]])
    expect(before.current).toBeUndefined()

    await trust(h)
    const after = report(await h.client.send({ type: "agents.list", directory: h.project }))
    expect(after.agents.find((a) => a.name === "scout")?.trusted).toBe(true)
  })

  test("needs a directory or a session", async () => {
    const h = await start()
    expect(error(await h.client.send({ type: "agents.list" })).code).toBe("invalid_command")
  })
})

describe("session.agent.set", () => {
  test("selects a primary agent for the session; null returns to build; the choice is per session", async () => {
    const h = await start()
    put(path.join(h.dir, "agents", "reviewer.md"), agentFile("description: Reviews\nmode: primary"))
    const one = await openSession(h)
    const two = await openSession(h)
    expect(report(await h.client.send({ type: "agents.list", sessionId: one })).current).toBe("build")
    const set = report(await h.client.send({ type: "session.agent.set", sessionId: one, agent: "reviewer" }))
    expect(set.current).toBe("reviewer")
    expect(h.store.sessionAgent(one)).toBe("reviewer")
    expect(report(await h.client.send({ type: "agents.list", sessionId: two })).current).toBe("build")
    expect(report(await h.client.send({ type: "session.agent.set", sessionId: one, agent: null })).current).toBe("build")
    expect(h.store.sessionAgent(one)).toBeUndefined()
  })

  test("refuses an unknown agent, a subagent-only one, and a project one until the project is trusted", async () => {
    const h = await start()
    put(path.join(h.dir, "agents", "scout.md"), agentFile("description: Finds\nmode: subagent"))
    put(path.join(h.project, ".mendcode", "agents", "theirs.md"), agentFile("description: The project's own\nmode: primary"))
    const sessionId = await openSession(h)
    const set = (agent: string) => h.client.send({ type: "session.agent.set", sessionId, agent })
    expect(error(await set("ghost"))).toMatchObject({ code: "target_mismatch", message: expect.stringContaining("unknown agent ghost") })
    expect(error(await set("scout"))).toMatchObject({ code: "target_mismatch", message: expect.stringContaining("is a subagent") })
    expect(error(await set("theirs"))).toMatchObject({ code: "target_mismatch", message: expect.stringContaining("not trusted") })
    expect(h.store.sessionAgent(sessionId)).toBeUndefined()
    await trust(h)
    expect(report(await set("theirs")).current).toBe("theirs")
    expect(error(await h.client.send({ type: "session.agent.set", sessionId: createIdFactory()("session"), agent: "theirs" })).code).toBe("unknown_session")
  })

  test("plan is plan mode: selecting it sets the permission, and any other agent leaves it", async () => {
    const h = await start()
    put(path.join(h.dir, "agents", "reviewer.md"), agentFile("description: Reviews\nmode: primary"))
    const sessionId = await openSession(h, "edits" as never)
    const planned = report(await h.client.send({ type: "session.agent.set", sessionId, agent: "plan" }))
    expect(planned.current).toBe("plan")
    const modes = () => h.events.filter((e) => e.type === "session.permission").map((e) => (e as { mode: string }).mode)
    // Every client sees the mode change as an event; plan is not stored, so the live session is the truth.
    expect(modes()).toEqual(["edits", "plan"])
    expect(report(await h.client.send({ type: "agents.list", sessionId })).current).toBe("plan")
    expect(report(await h.client.send({ type: "session.agent.set", sessionId, agent: "reviewer" })).current).toBe("reviewer")
    expect(modes()).toEqual(["edits", "plan", "ask"])
    await h.client.send({ type: "session.agent.set", sessionId, agent: "plan" })
    expect(report(await h.client.send({ type: "session.agent.set", sessionId, agent: "build" })).current).toBe("build")
    expect(modes()).toEqual(["edits", "plan", "ask", "plan", "ask"])
    // Choosing an agent while not in plan mode does not touch the mode the user chose.
    await h.client.send({ type: "session.permission.set", sessionId, mode: "full" })
    await h.client.send({ type: "session.agent.set", sessionId, agent: "reviewer" })
    expect(modes().at(-1)).toBe("full")
  })
})

describe("agents in a session's turns", () => {
  test("the selected agent shapes the next model call: prompt, tools and model; an edit to its file applies to the next turn", async () => {
    const h = await start({ steps: [stop("one"), stop("two"), stop("three")] })
    const file = path.join(h.dir, "agents", "reviewer.md")
    put(file, agentFile("description: Reviews\nmode: primary\ntools: read, probe\nmodel: gpt-6-sol\neffort: low", "Review only."))
    const sessionId = await openSession(h)
    const other = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId, agent: "reviewer" })
    await say(h, sessionId, "review this")
    expect(h.requests[0]!.system).toBe("BASE\n\n# Agent: reviewer\n\nReview only.")
    // plan_submit, the secrets tool and the goal tools stay whatever the agent lists.
    expect(h.requests[0]!.tools.map((t) => t.name)).toEqual(["read", "probe", "secrets", "plan_submit", "get_goal", "create_goal", "update_goal", "plan_review", "plan_exit"])
    expect([h.requests[0]!.model, h.requests[0]!.effort]).toEqual(["gpt-6-sol", "low"])
    put(file, agentFile("description: Reviews\nmode: primary\ntools: read", "Review harder."))
    await say(h, sessionId, "again")
    expect(h.requests[1]!.system).toContain("Review harder.")
    expect(h.requests[1]!.tools.map((t) => t.name)).toEqual(["read", "secrets", "plan_submit", "get_goal", "create_goal", "update_goal", "plan_review", "plan_exit"])
    await say(h, other, "plain session")
    expect(h.requests[2]!.system).toBe("BASE")
    expect(h.requests[2]!.tools.map((t) => t.name)).toEqual(["read", "write", "probe", "task_status", "secrets", "plan_submit", "task", "get_goal", "create_goal", "update_goal", "plan_review", "plan_exit"])
  })

  test("a project agent selected while trusted stops applying when the trust is taken back", async () => {
    const h = await start({ steps: [stop("one"), stop("two")] })
    put(path.join(h.project, ".mendcode", "agents", "theirs.md"), agentFile("description: d\nmode: primary", "Project rules."))
    await trust(h)
    const sessionId = await openSession(h)
    await h.client.send({ type: "session.agent.set", sessionId, agent: "theirs" })
    await say(h, sessionId, "go")
    expect(h.requests[0]!.system).toContain("Project rules.")
    await trust(h, false)
    await say(h, sessionId, "again")
    expect(h.requests[1]!.system).toBe("BASE")
    expect(report(await h.client.send({ type: "agents.list", sessionId })).current).toBe("build")
  })

  test("task calls a sub-agent by name; an untrusted project sub-agent is not offered", async () => {
    const h = await start({
      steps: [
        callTool("task", { description: "look", prompt: "Look around.", agent: "scout" }),
        stop("scouted"),
        stop("done"),
        callTool("task", { description: "look", prompt: "Look around.", agent: "theirs" }),
        stop("done again"),
      ],
    })
    put(path.join(h.dir, "agents", "scout.md"), agentFile("description: Finds things\nmode: subagent\ntools: read\nmodel: gpt-6-luna", "You scout."))
    put(path.join(h.project, ".mendcode", "agents", "theirs.md"), agentFile("description: Theirs\nmode: subagent", "Project sub-agent."))
    const sessionId = await openSession(h)
    await say(h, sessionId, "go")
    const task = h.requests[0]!.tools.find((t) => t.name === "task")!
    expect(task.description).toContain("- scout: Finds things")
    expect(task.description).not.toContain("theirs")
    expect(h.requests[1]!.system).toBe("BASE\n\n# Agent: scout\n\nYou scout.")
    expect([h.requests[1]!.model, h.requests[1]!.tools.map((t) => t.name)]).toEqual(["gpt-6-luna", ["read", "secrets"]])
    // The sub-agent's record says what it ran on.
    const listed = await h.client.send({ type: "task.list", sessionId })
    expect((listed as { result?: { tasks?: Array<{ run?: unknown }> } }).result?.tasks?.[0]?.run).toMatchObject({ model: "gpt-6-luna", engine: "native" })
    await say(h, sessionId, "now the project's")
    expect(h.requests[3]!.messages.at(-1)).toMatchObject({ role: "user" })
    const refused = h.requests[4]!.messages.at(-1)
    expect(refused).toMatchObject({ role: "tool", name: "task", isError: true, output: expect.stringContaining('unknown agent "theirs"; available: general, explore, scout') })
  })

  test("the task description names a bounded catalog however many agents are installed; agent \"?\" lists the rest", async () => {
    const h = await start({ steps: [callTool("task", { description: "which", prompt: "x", agent: "?" }), callTool("task", { description: "run", prompt: "Go.", agent: "helper-9" }), stop("helped"), stop("done")] })
    for (let i = 0; i < 12; i++) put(path.join(h.dir, "agents", `helper-${i}.md`), agentFile(`description: Helper number ${i} ${"with a long description ".repeat(10)}\nmode: subagent`, `Secret prompt ${i}.`))
    const sessionId = await openSession(h)
    await say(h, sessionId, "go")
    const task = h.requests[0]!.tools.find((t) => t.name === "task")!
    // general and explore first, then four helpers (by name); the other eight are counted, not described, and no prompt is sent.
    expect(task.description).toContain("- general: ")
    expect(task.description).toContain("- helper-11: Helper number 11")
    expect(task.description).not.toContain("helper-2")
    expect(task.description).toContain('+8 more: agent "?" lists them')
    expect(task.description).not.toContain("Secret prompt")
    expect(task.description.split("\n").every((line) => line.length < 100 || !line.startsWith("- "))).toBe(true)
    const listing = h.requests[1]!.messages.at(-1)
    expect(listing).toMatchObject({ role: "tool", name: "task", isError: false, output: expect.stringContaining("- helper-9: Helper number 9") })
    expect(JSON.stringify(listing)).not.toContain("Secret prompt")
    expect(h.store.tasks.list()).toHaveLength(1)
    expect(h.requests[2]!.system).toContain("Secret prompt 9.")
    await h.client.send({ type: "settings.set", patch: { subagentCatalog: 0 } })
    await say(h, sessionId, "again")
    expect(h.requests[4]!.tools.find((t) => t.name === "task")!.description).toContain('14 agents: agent "?" lists them')
  })

  test("explore is read-only and gets the code graph tools the session offers", async () => {
    const fake = (name: string) => defineTool({ name, description: name, permission: "read", args: z.object({}), execute: async () => ({ output: name, title: name, isError: false, truncated: false }) })
    const h = await start({ extraTools: [fake("graph_find"), fake("graph_callers"), fake("graph_impact"), fake("code_search")], steps: [stop("found")] })
    const sessionId = await openSession(h)
    expect((await h.client.send({ type: "task.run", sessionId, input: { description: "Find", prompt: "Where is main?", agent: "explore" } })).ok).toBe(true)
    const names = h.requests[0]!.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["read", "graph_find", "graph_callers", "code_search"]))
    // graph_impact is about edits a read-only agent never makes.
    for (const name of ["write", "graph_impact"]) expect(names).not.toContain(name)
    expect(h.requests[0]!.system).toContain("not an inventory")
  })

  test("the parent model receives the sub-agent's answer however long it streamed", async () => {
    const story: ModelEvent[] = [...Array.from({ length: 400 }, (_, i): ModelEvent => ({ type: "text", delta: `w${i} ` })), { type: "finish", reason: "stop" }]
    const h = await start({ steps: [callTool("task", { description: "tell", prompt: "Tell a story." }), story, stop("done")] })
    const sessionId = await openSession(h)
    await say(h, sessionId, "go")
    expect(h.requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", name: "task", output: expect.stringMatching(/w0 w1 w2[\s\S]*w399/) })
  })
})
