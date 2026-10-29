import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { ModelEvent, ModelMessage, ModelRequest } from "@mendcode/engine-native"
import type { Goal, SessionEvent, SessionId } from "@mendcode/protocol"
import { MAX_UNATTENDED_GOAL_TURNS } from "../src/goals"
import { answer, boot, callTool, hang, openSession, put, stop, until, type NativeHarness, type Step } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0).reverse()) await h.cleanup()
})

async function start(steps: Step[], options: { dir?: string; project?: string; cancelGraceMs?: number } = {}) {
  const h = await boot({ steps, ...options })
  harnesses.push(h)
  return h
}

/** A scripted call that answers only when opened (or fails when its turn is cancelled first). */
function gate(events: ModelEvent[]) {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  const step: Step = (request: ModelRequest) =>
    new Promise<ModelEvent[]>((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      void opened.then(() => resolve(events))
    })
  return { step, open }
}

const goalOf = (h: NativeHarness, sessionId: SessionId) => h.store.goals.current(sessionId)?.goal
const events = (h: NativeHarness, sessionId: SessionId) => h.store.readAfter(sessionId, 0, 10_000)
const started = (h: NativeHarness, sessionId: SessionId) => events(h, sessionId).filter((event) => event.type === "turn.started").length
const finished = (h: NativeHarness, sessionId: SessionId) => h.store.turns.list(sessionId).filter((turn) => turn.status !== "running").length
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
const lastUser = (request: ModelRequest) => (request.messages.findLast((message: ModelMessage) => message.role === "user") as { content: string }).content

/** The hidden messages that started goal turns: their `meta.goal` and the label the transcript shows. */
function steerings(h: NativeHarness, sessionId: SessionId) {
  const all = events(h, sessionId)
  const out: Array<{ goal: string; label: string }> = []
  for (const event of all) {
    if (event.type !== "item.started" || event.kind !== "user_message" || typeof event.meta?.goal !== "string") continue
    const done = all.find((candidate) => candidate.type === "item.completed" && candidate.itemId === event.itemId)
    out.push({ goal: event.meta.goal, label: done?.type === "item.completed" ? (done.text ?? "") : "" })
  }
  return out
}

const goalEvents = (h: NativeHarness, sessionId: SessionId) => events(h, sessionId).filter((event): event is Extract<SessionEvent, { type: "goal.changed" }> => event.type === "goal.changed")
const okResult = (reply: { ok: boolean; result?: Record<string, unknown> }) => reply as { ok: true; result: { goal: Goal; replaced?: Goal } }
const toolOutputs = (h: NativeHarness) => h.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool")) as Array<{ name: string; output: string; isError: boolean }>

describe("goal continuation", () => {
  test("a goal keeps the session working: turn 2 continues on its own with the steering text, turn 3 completes it and stops", async () => {
    const h = await start([callTool("probe", {}), stop("step one done"), stop("still going"), callTool("update_goal", { status: "complete", note: "all done" }), stop("The goal is finished.")])
    const sessionId = await openSession(h)
    const set = okResult(await h.client.send({ type: "goal.set", sessionId, objective: "make the tests pass" }))
    expect(set.ok).toBe(true)
    expect(set.result.goal).toMatchObject({ status: "active", objective: "make the tests pass", tokensUsed: 0 })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    await until(() => finished(h, sessionId) >= 3)
    // The scripted provider throws when called more than scripted, so a fourth turn would have failed.
    await settle()
    expect(started(h, sessionId)).toBe(3)
    expect(h.steps.length).toBe(0)
    expect(steerings(h, sessionId)).toEqual([
      { goal: "continuation", label: "goal · continuing" },
      { goal: "continuation", label: "goal · continuing" },
      { goal: "continuation", label: "goal · continuing" },
    ])
    // The model saw the real steering text; the transcript only the label.
    const first = lastUser(h.requests[0]!)
    expect(first).toContain("<objective>\nmake the tests pass\n</objective>")
    expect(first).toContain("audit it against the actual current state")
    expect(events(h, sessionId).some((event) => event.type === "item.completed" && (event.text ?? "").includes("<objective>"))).toBe(false)
    expect(lastUser(h.requests[2]!)).toContain("<objective>")
    expect(goalOf(h, sessionId)).toMatchObject({ status: "complete", note: "all done" })
    // The turns read as system notices (undo treats them so): no user message was typed.
    expect(h.store.turns.list(sessionId).every((turn) => turn.notice)).toBe(true)
    expect(goalEvents(h, sessionId).some((event) => event.change === "status" && event.goal.status === "complete" && event.by === "agent")).toBe(true)
  })

  test("a queued user message goes before the next continuation; the goal goes on after it", async () => {
    const g = gate(stop("first turn"))
    const h = await start([g.step, stop("answer to the user"), stop("continued"), callTool("update_goal", { status: "complete" }), stop("done")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "tidy the repo" })
    await until(() => started(h, sessionId) >= 1)
    const queued = await h.client.send({ type: "user.submit", sessionId, text: "quick question", attachments: [] })
    expect(queued.ok).toBe(true)
    g.open()
    await until(() => goalOf(h, sessionId)?.status === "complete")
    const order = events(h, sessionId)
      .filter((event) => event.type === "item.started" && event.kind === "user_message")
      .map((event) => (event.type === "item.started" && typeof event.meta?.goal === "string" ? event.meta.goal : "user"))
    expect(order).toEqual(["continuation", "user", "continuation", "continuation"])
    expect(lastUser(h.requests[1]!)).toBe("quick question")
  })

  test("blocked needs the agent's own call and stops continuation; resume starts the next turn", async () => {
    const h = await start([callTool("update_goal", { status: "blocked", note: "needs the API key" }), stop("I am blocked: I need the API key."), stop("resumed work"), callTool("update_goal", { status: "complete" }), stop("done")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "call the live API" })
    await until(() => goalOf(h, sessionId)?.status === "blocked")
    await until(() => finished(h, sessionId) >= 1)
    await settle()
    expect(started(h, sessionId)).toBe(1)
    expect(goalOf(h, sessionId)).toMatchObject({ status: "blocked", note: "needs the API key" })
    const resumed = await h.client.send({ type: "goal.update", sessionId, status: "active" })
    expect(resumed).toMatchObject({ ok: true, result: { goal: { status: "active" } } })
    expect(goalOf(h, sessionId)?.note).toBeUndefined()
    await until(() => goalOf(h, sessionId)?.status === "complete")
    expect(started(h, sessionId)).toBe(3)
  })

  test("a goal with a token budget: crossing it marks budget_limited, sends the budget steering once, then stops", async () => {
    const h = await start([
      [callTool("probe", {})[0]!, { type: "usage", usage: { input: 50, output: 20, reasoning: 0, cacheRead: 900, cacheWrite: 0 } }, { type: "finish", reason: "tool_calls" }],
      answer("half done", { input: 40, output: 30 }),
      answer("Summary: two files changed, the rest is open. Next: raise the budget.", { input: 10, output: 10 }),
    ])
    const sessionId = await openSession(h)
    const set = okResult(await h.client.send({ type: "goal.set", sessionId, objective: "refactor everything", tokenBudget: 100 }))
    expect(set.result.goal.tokenBudget).toBe(100)
    await until(() => steerings(h, sessionId).some((entry) => entry.goal === "budget_limit") && finished(h, sessionId) >= 2)
    await settle()
    expect(started(h, sessionId)).toBe(2)
    expect(steerings(h, sessionId).map((entry) => entry.goal)).toEqual(["continuation", "budget_limit"])
    expect(steerings(h, sessionId)[1]!.label).toBe("goal · budget reached, wrapping up")
    // Cached tokens do not count; input + output of every model call do (the wrap-up turn included).
    expect(goalOf(h, sessionId)).toMatchObject({ status: "budget_limited", tokensUsed: 70 + 70 + 20 })
    expect(lastUser(h.requests[2]!)).toContain("reached its token budget")
    expect(lastUser(h.requests[2]!)).toContain("Do not start new substantive work")
    expect(goalEvents(h, sessionId).some((event) => event.change === "status" && event.goal.status === "budget_limited" && event.by === "system")).toBe(true)
    expect(h.steps.length).toBe(0)
  })

  test("raising the budget of a budget-limited goal reactivates it; resume alone is refused", async () => {
    const h = await start([answer("over budget", { input: 80, output: 40 }), stop("wrap-up"), stop("more work"), callTool("update_goal", { status: "complete" }), stop("done")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "spend", tokenBudget: 100 })
    await until(() => steerings(h, sessionId).some((entry) => entry.goal === "budget_limit") && finished(h, sessionId) >= 2)
    expect(goalOf(h, sessionId)?.status).toBe("budget_limited")
    expect(await h.client.send({ type: "goal.update", sessionId, status: "active" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "goal.update", sessionId, tokenBudget: 100_000 })).toMatchObject({ ok: true, result: { goal: { status: "active", tokenBudget: 100_000 } } })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    // A budget turned off leaves no limit at all.
    expect(await h.client.send({ type: "goal.set", sessionId, objective: "next", tokenBudget: 5 })).toMatchObject({ ok: true })
    expect(await h.client.send({ type: "goal.update", sessionId, tokenBudget: null })).toMatchObject({ ok: true })
    expect(goalOf(h, sessionId)?.tokenBudget).toBeUndefined()
    await h.client.send({ type: "goal.update", sessionId, status: "paused" })
  })

  test("the provider's usage limit marks the goal usage_limited; resume reactivates it", async () => {
    const h = await start([
      () => {
        throw new Error("[PROVIDER]: scripted 429 usage_limit_reached")
      },
      stop("back at it"),
      callTool("update_goal", { status: "complete" }),
      stop("done"),
    ])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "ship it" })
    await until(() => goalOf(h, sessionId)?.status === "usage_limited")
    await settle()
    expect(started(h, sessionId)).toBe(1)
    expect(events(h, sessionId).some((event) => event.type === "turn.failed")).toBe(true)
    expect(goalEvents(h, sessionId).some((event) => event.change === "status" && event.goal.status === "usage_limited" && event.by === "system")).toBe(true)
    expect(await h.client.send({ type: "goal.update", sessionId, status: "active" })).toMatchObject({ ok: true })
    await until(() => goalOf(h, sessionId)?.status === "complete")
  })

  test("pause stops continuation, editing tells the agent about the new objective once, resume restarts, clear keeps the history", async () => {
    const one = gate(stop("turn one"))
    const three = gate(stop("turn three"))
    const h = await start([one.step, stop("turn two"), three.step])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "write the docs" })
    await until(() => started(h, sessionId) >= 1)
    expect(await h.client.send({ type: "goal.update", sessionId, status: "paused" })).toMatchObject({ ok: true, result: { goal: { status: "paused" } } })
    one.open()
    await until(() => finished(h, sessionId) >= 1)
    await settle()
    expect(started(h, sessionId)).toBe(1)
    expect(goalOf(h, sessionId)?.status).toBe("paused")
    // Editing a paused goal keeps it paused; the new objective waits to be announced.
    expect(await h.client.send({ type: "goal.update", sessionId, objective: "write the docs and the changelog" })).toMatchObject({ ok: true, result: { goal: { status: "paused", objective: "write the docs and the changelog" } } })
    await settle()
    expect(started(h, sessionId)).toBe(1)
    await h.client.send({ type: "goal.update", sessionId, status: "active" })
    await until(() => started(h, sessionId) >= 3)
    expect(steerings(h, sessionId).map((entry) => entry.goal)).toEqual(["continuation", "objective_updated", "continuation"])
    expect(steerings(h, sessionId)[1]!.label).toBe("goal · objective updated")
    expect(lastUser(h.requests[1]!)).toContain("edited the objective")
    expect(lastUser(h.requests[1]!)).toContain("write the docs and the changelog")
    expect(lastUser(h.requests[2]!)).not.toContain("edited the objective")
    await h.client.send({ type: "goal.update", sessionId, status: "paused" })
    three.open()
    await until(() => finished(h, sessionId) >= 3)
    await settle()
    expect(started(h, sessionId)).toBe(3)
    expect(await h.client.send({ type: "goal.clear", sessionId })).toMatchObject({ ok: true, result: { cleared: true } })
    expect(goalOf(h, sessionId)).toBeUndefined()
    expect(await h.client.send({ type: "goal.get", sessionId })).toMatchObject({ ok: true, result: {} })
    const history = (await h.client.send({ type: "goal.get", sessionId, history: true })) as unknown as { result: { history: Goal[]; goal?: Goal } }
    expect(history.result.goal).toBeUndefined()
    expect(history.result.history.map((goal) => goal.objective)).toEqual(["write the docs and the changelog"])
    expect(goalEvents(h, sessionId).at(-1)).toMatchObject({ change: "cleared" })
    expect(await h.client.send({ type: "goal.update", sessionId, status: "active" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  })

  test("a failed turn stops automatic continuation and says why; the user's next message brings it back", async () => {
    const h = await start([
      () => {
        throw new Error("[PROVIDER]: scripted 500 boom")
      },
      stop("here is your answer"),
      stop("continuing after the answer"),
      callTool("update_goal", { status: "complete" }),
      stop("done"),
    ])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "fix the flaky test" })
    await until(() => goalOf(h, sessionId)?.stalled !== undefined)
    await settle()
    expect(started(h, sessionId)).toBe(1)
    expect(goalOf(h, sessionId)).toMatchObject({ status: "active", stalled: expect.stringContaining("the last turn failed") })
    expect(goalEvents(h, sessionId).some((event) => event.change === "stalled" && event.by === "system")).toBe(true)
    await h.client.send({ type: "user.submit", sessionId, text: "try again please", attachments: [] })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    expect(goalOf(h, sessionId)?.stalled).toBeUndefined()
  })

  test("two turns in a row with no output stop continuation", async () => {
    const h = await start([[{ type: "finish", reason: "stop" }], [{ type: "finish", reason: "stop" }], stop("never reached")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "do something" })
    await until(() => goalOf(h, sessionId)?.stalled !== undefined)
    await settle()
    expect(started(h, sessionId)).toBe(2)
    expect(h.steps.length).toBe(1)
    expect(goalOf(h, sessionId)).toMatchObject({ status: "active", stalled: expect.stringContaining("no output") })
  })

  test("three goal turns in a row that only report and call no tool stop continuation; the user's next message brings it back", async () => {
    // A ZeroBase goal ran 2,029 such turns, ten seconds apart: "No progress. The last gate was 47 % / STOP".
    const report = (percent: number) => stop(`No progress. The last quota gate was ${percent} % / STOP; I started nothing.`)
    const h = await start([report(47), callTool("probe", {}), stop("probed"), report(47), report(43), report(43), stop("ok, going on"), callTool("update_goal", { status: "complete" }), stop("done")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "build everything; spend all my usage" })
    await until(() => goalOf(h, sessionId)?.stalled !== undefined)
    await settle()
    // A turn that brought a new result (the probe) restarts the count: the stall comes three report-only turns after it.
    expect(started(h, sessionId)).toBe(5)
    expect(goalOf(h, sessionId)).toMatchObject({ status: "active", stalled: expect.stringContaining("no progress in 3 goal turns") })
    expect(goalOf(h, sessionId)?.stalled).toContain("43 % / STOP")
    await h.client.send({ type: "user.submit", sessionId, text: "ignore the quota, keep coding", attachments: [] })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    expect(h.steps.length).toBe(0)
  })

  test("a tool called every turn that gets the same answer again is no progress: continuation stops after three such turns", async () => {
    // The loop an agent falls into when it re-runs a check each turn ("gate: STOP") instead of only writing that it is stuck.
    const check = () => callTool("probe", {})
    const h = await start([check(), stop("checked: STOP"), check(), stop("checked again: STOP"), check(), stop("still STOP"), check(), stop("STOP"), stop("never reached")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "finish the batch" })
    await until(() => goalOf(h, sessionId)?.stalled !== undefined)
    await settle()
    // Turn 1 is the first time the probe answers; turns 2-4 repeat the same call and result.
    expect(started(h, sessionId)).toBe(4)
    expect(h.steps.length).toBe(1)
    expect(goalOf(h, sessionId)).toMatchObject({ status: "active", stalled: expect.stringContaining("no progress in 3 goal turns") })
  })

  test("turns whose calls bring new results keep the goal going past three turns, until the agent completes it", async () => {
    const h = await start([])
    for (let index = 1; index <= 6; index++) put(path.join(h.project, `part-${index}.txt`), `part ${index}`)
    for (let index = 1; index <= 6; index++) h.steps.push(callTool("read", { path: `part-${index}.txt` }), stop(`read part ${index}`))
    h.steps.push(callTool("update_goal", { status: "complete" }), stop("all parts read"))
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "read every part" })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    expect(started(h, sessionId)).toBe(7)
    expect(goalEvents(h, sessionId).some((event) => event.change === "stalled")).toBe(false)
  })

  test(`a loop whose every call looks new still stops after ${MAX_UNATTENDED_GOAL_TURNS} goal turns without the user; resume goes on`, async () => {
    const h = await start([])
    for (let index = 1; index <= MAX_UNATTENDED_GOAL_TURNS; index++) {
      put(path.join(h.project, `gate-${index}.txt`), `remaining ${index} % STOP`)
      h.steps.push(callTool("read", { path: `gate-${index}.txt` }), stop(`gate ${index}: STOP`))
    }
    h.steps.push(callTool("update_goal", { status: "complete" }), stop("done after resume"))
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "keep checking" })
    await until(() => goalOf(h, sessionId)?.stalled !== undefined, 30_000)
    await settle()
    expect(started(h, sessionId)).toBe(MAX_UNATTENDED_GOAL_TURNS)
    expect(goalOf(h, sessionId)?.stalled).toContain(`${MAX_UNATTENDED_GOAL_TURNS} goal turns in a row without you`)
    await h.client.send({ type: "goal.update", sessionId, status: "active" })
    await until(() => goalOf(h, sessionId)?.status === "complete")
  }, 60_000)

  test("cancelling a goal turn stops continuation; resume starts it again even though the cancel held the session", async () => {
    const h = await start([hang, stop("after resume"), callTool("update_goal", { status: "complete" }), stop("done")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "long job" })
    await until(() => started(h, sessionId) >= 1)
    const turn = events(h, sessionId).find((event) => event.type === "turn.started")
    await h.client.send({ type: "turn.cancel", sessionId, turnId: (turn as Extract<SessionEvent, { type: "turn.started" }>).turnId })
    await until(() => goalOf(h, sessionId)?.stalled !== undefined)
    await settle()
    expect(started(h, sessionId)).toBe(1)
    expect(goalOf(h, sessionId)?.stalled).toContain("cancelled")
    await h.client.send({ type: "goal.update", sessionId, status: "active" })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    expect(started(h, sessionId)).toBe(3)
  })

  test("the agent can also end a goal on an engine without goal tools: a last line GOAL_STATUS", async () => {
    const h = await start([stop("I checked every requirement.\nGOAL_STATUS: complete")])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "tiny" })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    await settle()
    expect(started(h, sessionId)).toBe(1)
    const other = await start([stop("Stuck.\nGOAL_STATUS: blocked - no network")])
    const otherSession = await openSession(other)
    await other.client.send({ type: "goal.set", sessionId: otherSession, objective: "tiny" })
    await until(() => goalOf(other, otherSession)?.status === "blocked")
    expect(goalOf(other, otherSession)?.note).toBe("no network")
  })
})

describe("goal tools", () => {
  test("create_goal works when the agent calls it and fails while an unfinished goal exists; get_goal reports the usage; update_goal needs a goal", async () => {
    const h = await start([
      callTool("update_goal", { status: "complete" }),
      stop("There is no goal yet."),
      callTool("create_goal", { objective: "migrate to bun", token_budget: 5000 }),
      stop("Goal created."),
      callTool("create_goal", { objective: "second goal" }),
      callTool("get_goal", {}),
      callTool("update_goal", { status: "complete", note: "migrated" }),
      stop("done, used few tokens"),
    ])
    const sessionId = await openSession(h)
    await h.client.send({ type: "user.submit", sessionId, text: "please wrap this up", attachments: [] })
    await until(() => finished(h, sessionId) >= 1)
    expect(toolOutputs(h).find((tool) => tool.name === "update_goal")).toMatchObject({ isError: true, output: "this session has no goal" })
    await h.client.send({ type: "user.submit", sessionId, text: "create a goal: migrate to bun, budget 5000 tokens", attachments: [] })
    await until(() => goalEvents(h, sessionId).some((event) => event.change === "created"))
    expect(goalEvents(h, sessionId).find((event) => event.change === "created")).toMatchObject({ by: "agent", goal: { objective: "migrate to bun", tokenBudget: 5000 } })
    // The continuation after that turn runs the rest of the script: a second create_goal fails, get_goal reads, update_goal completes.
    await until(() => goalOf(h, sessionId)?.status === "complete")
    const outputs = toolOutputs(h)
    expect(outputs.find((tool) => tool.name === "create_goal" && tool.isError)?.output).toContain("already has an unfinished goal")
    expect(JSON.parse(outputs.find((tool) => tool.name === "get_goal")!.output)).toMatchObject({ goal: { status: "active", objective: "migrate to bun", tokenBudget: 5000, remainingTokens: 5000 } })
    expect(outputs.find((tool) => tool.name === "update_goal" && !tool.isError)?.output).toContain("Report the final token usage")
    expect(h.requests[0]!.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_goal", "create_goal", "update_goal"]))
  })
})

describe("goal commands", () => {
  test("goal.set refuses to replace an unfinished goal without `replace`; bad input is refused", async () => {
    const h = await start([hang, hang])
    const sessionId = await openSession(h)
    expect(await h.client.send({ type: "goal.set", sessionId, objective: "   " })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "goal.set", sessionId, objective: "first", tokenBudget: 0 })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "goal.update", sessionId })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(await h.client.send({ type: "goal.update", sessionId, status: "active" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    await h.client.send({ type: "goal.set", sessionId, objective: "first" })
    await until(() => started(h, sessionId) >= 1)
    expect(await h.client.send({ type: "goal.set", sessionId, objective: "second" })).toMatchObject({ ok: false, error: { code: "busy" } })
    const replaced = okResult(await h.client.send({ type: "goal.set", sessionId, objective: "second", replace: true }))
    expect(replaced.result.replaced).toMatchObject({ objective: "first" })
    expect(goalOf(h, sessionId)?.objective).toBe("second")
    expect(goalEvents(h, sessionId).filter((event) => event.change === "created").map((event) => event.goal.objective)).toEqual(["first", "second"])
    expect(await h.client.send({ type: "goal.get", sessionId: "ses_00000000000000000000000000" as SessionId })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })

  test("a finished goal is replaced without asking", async () => {
    const h = await start([callTool("update_goal", { status: "complete" }), stop("done"), hang])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "first" })
    await until(() => goalOf(h, sessionId)?.status === "complete")
    await until(() => finished(h, sessionId) >= 1)
    const again = okResult(await h.client.send({ type: "goal.set", sessionId, objective: "second" }))
    expect(again.result.replaced).toMatchObject({ objective: "first", status: "complete" })
    await until(() => started(h, sessionId) >= 2)
  })

  test("a long objective is saved as a file the goal points at; editing it short removes the file; clearing removes it", async () => {
    const h = await start([stop("working"), hang])
    const sessionId = await openSession(h)
    const long = `${"requirement line\n".repeat(400)}THE END`
    const set = okResult(await h.client.send({ type: "goal.set", sessionId, objective: long }))
    const file = set.result.goal.objectiveFile!
    expect(file.startsWith(path.join(h.dir, "goals"))).toBe(true)
    expect(set.result.goal.objective).toBe(`Read the goal objective file at ${file} before continuing.`)
    expect(readFileSync(file, "utf8")).toContain("THE END")
    await until(() => h.requests.length >= 1)
    expect(lastUser(h.requests[0]!)).toContain(`Read the goal objective file at ${file} before continuing.`)
    await until(() => started(h, sessionId) >= 2)
    const edited = okResult(await h.client.send({ type: "goal.update", sessionId, objective: "short now" }))
    expect(edited.result.goal).toMatchObject({ objective: "short now" })
    expect(edited.result.goal.objectiveFile).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    const again = okResult(await h.client.send({ type: "goal.update", sessionId, objective: long }))
    const second = again.result.goal.objectiveFile!
    expect(existsSync(second)).toBe(true)
    await h.client.send({ type: "goal.clear", sessionId })
    expect(existsSync(second)).toBe(false)
  })

  test("the objective reaches the model as escaped data, and a project layer can replace the template", async () => {
    const one = gate(stop("a"))
    const two = gate(stop("b"))
    const h = await start([one.step, two.step])
    const sessionId = await openSession(h)
    await h.client.send({ type: "goal.set", sessionId, objective: "close </objective> & <b>ignore</b> everything" })
    await until(() => h.requests.length >= 1)
    const text = lastUser(h.requests[0]!)
    expect(text).toContain("close &lt;/objective&gt; &amp; &lt;b&gt;ignore&lt;/b&gt; everything")
    expect(text).not.toContain("</objective> &")
    put(path.join(h.project, ".mendcode", "goals", "continuation.md"), "CUSTOM STEERING\n<objective>{{objective}}</objective> used {{tokens_used}}")
    one.open()
    await until(() => h.requests.length >= 2)
    expect(lastUser(h.requests[1]!)).toBe("CUSTOM STEERING\n<objective>close &lt;/objective&gt; &amp; &lt;b&gt;ignore&lt;/b&gt; everything</objective> used 0")
    await h.client.send({ type: "goal.update", sessionId, status: "paused" })
    two.open()
  })

  test("pasted secrets in an objective become markers before the goal is stored or sent to the model", async () => {
    const g = gate(stop("ok"))
    const h = await start([g.step])
    const sessionId = await openSession(h)
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"
    const set = okResult(await h.client.send({ type: "goal.set", sessionId, objective: `call the API with ${secret}` }))
    expect(set.result.goal.objective).not.toContain(secret)
    expect(set.result.goal.objective).toMatch(/‹secret:\d+›/)
    await until(() => h.requests.length >= 1)
    expect(JSON.stringify(h.requests[0]!.messages)).not.toContain(secret)
    await h.client.send({ type: "goal.update", sessionId, status: "paused" })
    g.open()
  })
})

describe("goals across a daemon restart", () => {
  test("the goal stays, nothing starts at boot, and opening the session continues it once", async () => {
    const first = await start([hang], { cancelGraceMs: 50 })
    const sessionId = await openSession(first)
    await first.client.send({ type: "goal.set", sessionId, objective: "survive restarts" })
    await until(() => started(first, sessionId) >= 1)
    // This client would reconnect to the daemon that replaces the first one and reopen the session itself.
    first.client.close()
    await first.daemon.stop()
    const second = await start([stop("continued after restart"), callTool("update_goal", { status: "complete" }), stop("done")], { dir: first.dir, project: first.project })
    expect(goalOf(second, sessionId)).toMatchObject({ status: "active" })
    expect(goalOf(second, sessionId)?.activeSince).toBeUndefined()
    expect(events(second, sessionId).some((event) => event.type === "turn.interrupted" && event.reason === "restart")).toBe(true)
    await settle(250)
    expect(second.requests.length).toBe(0)
    expect(started(second, sessionId)).toBe(1)
    // Two clients opening the session at once must not start two turns.
    await Promise.all([second.client.subscribe(sessionId, 0), second.client.subscribe(sessionId, 0)])
    await until(() => goalOf(second, sessionId)?.status === "complete")
    await settle()
    expect(started(second, sessionId)).toBe(1 + 2)
    expect(second.steps.length).toBe(0)
  })
})
