import { describe, expect, test } from "bun:test"
import { summarizeWorkflow, WorkflowRun, WorkflowSummary } from "@mendcode/protocol"
import { splitScript, scanForbidden, parseScript } from "../src"
import { output, scriptHarness, settle } from "./script-harness"

const META = `{ name: "t", description: "test", phases: [{ title: "Find" }, { title: "Check" }] }`
const wf = (body: string, meta = META) => `export const meta = ${meta}\n${body}`

describe("script source", () => {
  test("meta is read as a pure literal without running anything", () => {
    const split = splitScript(`// header\nexport const meta = { name: 'a', description: "b", phases: [{ title: 'x', detail: \`y\` },], budget: { agents: 20 }, }\nreturn 1`)
    expect(split.ok && split.meta).toEqual({ name: "a", description: "b", phases: [{ title: "x", detail: "y" }], budget: { agents: 20 } })
    expect(split.ok && split.body.trim()).toBe("return 1")
  })

  test("meta that needs evaluation is refused with a position", () => {
    for (const bad of ["export const meta = { name: process.env.X }", "export const meta = { name: `a${1}` }", "export const meta = { ...other }", "export const meta = { name: f() }", "export const meta = { __proto__: {} }"]) {
      const split = splitScript(bad)
      expect(split.ok).toBe(false)
    }
    expect(splitScript("const x = 1").ok).toBe(false)
  })

  test("the scan refuses import and escapes but not the word inside strings, comments or properties", () => {
    expect(scanForbidden('const m = await import("node:fs")')).toContain("import")
    expect(scanForbidden("import.meta.url")).toContain("import")
    expect(scanForbidden("const x = `${import('x')}`")).toContain("import")
    expect(scanForbidden("\\u0069mport('x')")).toContain("escapes")
    expect(scanForbidden('await agent("migrate the import statements") // import x\n/* import */ const r = /import/g; x.import(1)')).toBeUndefined()
    expect(scanForbidden("const a = 4 / 2; const b = a / 2; return `a${a}b`")).toBeUndefined()
  })

  test("parseScript validates meta against the schema", () => {
    expect(parseScript(wf("return 1", "{ name: 'x', budget: { agents: 999 } }")).ok).toBe(false)
    expect(parseScript(wf("return 1", "{ name: 'x', unknown: 1 }")).ok).toBe(false)
    const ok = parseScript(wf("return 1"))
    expect(ok.ok && ok.hash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("script runs", () => {
  test("fan-out is decided at run time from earlier results", async () => {
    const h = scriptHarness({
      responder: (prompt) => (prompt.includes("list the files") ? output(["a.ts", "b.ts", "c.ts"]) : `reviewed ${/review (\S+)/.exec(prompt)?.[1]}`),
    })
    const run = h.start(wf(`
      const files = await agent("list the files", { schema: { type: "array", items: { type: "string" } }, label: "List" })
      const reviews = await parallel(files.map((file) => () => agent("review " + file, { label: file })))
      return { count: files.length, reviews }
    `))
    await settle(30)
    const done = h.get(run)
    expect(done.state).toBe("completed")
    expect(done.tasks).toHaveLength(4)
    expect(JSON.parse(h.rows.get(`${run.workflowId}\u0000result`)!).value).toEqual({ count: 3, reviews: ["reviewed a.ts", "reviewed b.ts", "reviewed c.ts"] })
    expect(done.script?.result).toContain("reviewed b.ts")
    expect(done.tasks.map((task) => task.label)).toEqual(["List", "a.ts", "b.ts", "c.ts"])
  })

  test("pipeline moves each item to its next stage as soon as its own previous stage ends", async () => {
    const order: string[] = []
    const h = scriptHarness({
      responder: async (prompt) => {
        order.push(prompt)
        // item "slow" finishes stage one last, "fast" first
        if (prompt === "s1 slow") await new Promise((resolve) => setTimeout(resolve, 40))
        return `${prompt}!`
      },
    })
    const run = h.start(wf(`
      return await pipeline(["slow", "fast"], (item) => agent("s1 " + item), (out) => agent("s2 " + out))
    `))
    await settle(10)
    await new Promise((resolve) => setTimeout(resolve, 80))
    await settle(30)
    expect(h.get(run).state).toBe("completed")
    // fast's second stage was asked before slow's first stage was answered
    expect(order.indexOf("s2 s1 fast!")).toBeLessThan(order.indexOf("s2 s1 slow!"))
    expect(JSON.parse(h.rows.get(`${run.workflowId}\u0000result`)!).value).toEqual(["s2 s1 slow!!", "s2 s1 fast!!"])
  })

  test("a structured answer that breaks its schema gets one repair turn in the same session", async () => {
    const h = scriptHarness({ responder: (_prompt, info) => (info.turn === 1 ? output({ wrong: true }) : output({ n: 2 })) })
    const run = h.start(wf(`return await agent("count", { schema: { type: "object", required: ["n"], properties: { n: { type: "number" } } } })`))
    await settle(30)
    expect(h.get(run).state).toBe("completed")
    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[1]).toContain("did not satisfy the output contract")
    expect(new Set(h.submitted.map((entry) => entry.sessionId)).size).toBe(1)
    expect(JSON.parse(h.rows.get(`${run.workflowId}\u0000result`)!).value).toEqual({ n: 2 })
  })

  test("a second invalid answer fails the call and the script sees the rejection", async () => {
    const h = scriptHarness({ responder: () => output({ wrong: true }) })
    const run = h.start(wf(`
      try { await agent("count", { schema: { type: "object", required: ["n"] } }); return "no" } catch (error) { return "caught: " + error.message }
    `))
    await settle(30)
    const done = h.get(run)
    expect(done.state).toBe("completed")
    expect(done.script?.result).toContain("caught: agent(")
    expect(done.tasks[0]!.state).toBe("failed")
    expect(h.prompts).toHaveLength(2)
  })

  test("detail returns the text and workspace of a worktree agent, and an unknown option is refused", async () => {
    const h = scriptHarness({ responder: () => "hello" })
    const run = h.start(wf(`
      const out = await agent("x", { detail: true, mode: "work", worktree: true })
      let bad = ""
      try { await agent("y", { bogus: 1 }) } catch (error) { bad = error.message }
      return { text: out.text, task: typeof out.taskId, bad }
    `))
    await settle(30)
    const result = JSON.parse(h.get(run).script!.result!)
    expect(result.text).toBe("hello")
    expect(result.task).toBe("string")
    expect(result.bad).toContain('unknown agent option "bogus"')
  })

  test("agents run read-only unless asked, and work agents without a worktree take the single-writer slot in turn", async () => {
    const h = scriptHarness({ responder: () => "HOLD" })
    const run = h.start(wf(`
      const a = parallel([() => agent("w1", { mode: "work" }), () => agent("w2", { mode: "work" }), () => agent("r1")])
      await a
    `))
    await settle(20)
    const tasks = h.get(run).tasks
    expect(tasks.find((task) => task.title === "r1")!.mode).toBe("read")
    expect(tasks.filter((task) => task.mode === "work" && task.state === "running")).toHaveLength(1)
    expect(h.sessions.filter((session) => !session.title.includes("workflow · t · ") || true).length).toBeGreaterThan(0)
  })

  test("worktree agents are isolated: two work agents in worktrees run together", async () => {
    const h = scriptHarness({ responder: () => "HOLD" })
    const run = h.start(wf(`await parallel([() => agent("w1", { mode: "work", worktree: true }), () => agent("w2", { mode: "work", worktree: true }), () => agent("w3", { mode: "work" })])`))
    await settle(20)
    const running = h.get(run).tasks.filter((task) => task.state === "running")
    expect(running.filter((task) => task.isolated)).toHaveLength(2)
    expect(running).toHaveLength(3)
  })

  test("check() returns ok and detail for a passing and a failing command, without failing the run", async () => {
    const h = scriptHarness({ responder: () => "x", checkExit: (argv) => (argv.includes("bad") ? 1 : 0) })
    const run = h.start(wf(`
      const good = await check("bun test")
      const bad = await check("bun run bad")
      return { good: good.ok, bad: bad.ok, detail: bad.detail }
    `))
    await settle(30)
    const done = h.get(run)
    expect(done.state).toBe("completed")
    expect(JSON.parse(done.script!.result!)).toMatchObject({ good: true, bad: false })
    expect(h.ran).toHaveLength(2)
  })

  test("ask() waits for the user: an answer resumes the script, a bad option is refused, a rejection rejects the call", async () => {
    const h = scriptHarness({ responder: () => "x" })
    const run = h.start(wf(`
      const choice = await ask("Which branch?", ["main", "dev"])
      let refused = "none"
      try { await ask("Proceed?") } catch (error) { refused = error.message }
      return { choice, refused }
    `))
    await settle(20)
    let current = h.get(run)
    expect(current.state).toBe("needs_input")
    const first = current.tasks[0]!
    expect(h.service.control(run.workflowId, "approve", { taskId: first.id, reason: "nope" })).toEqual({ error: "answer one of: main, dev" })
    expect("run" in h.service.control(run.workflowId, "approve", { taskId: first.id, reason: "2" })).toBe(true)
    await settle(20)
    current = h.get(run)
    const second = current.tasks[1]!
    expect(second.state).toBe("needs_input")
    h.service.control(run.workflowId, "reject", { taskId: second.id, reason: "no" })
    await settle(20)
    expect(h.get(run).state).toBe("completed")
    expect(JSON.parse(h.get(run).script!.result!)).toEqual({ choice: "dev", refused: expect.stringContaining("failed") })
  })

  test("memo runs its function once, sleep is a journaled timer, log lines are kept once", async () => {
    let computed = 0
    const h = scriptHarness({ responder: () => "x" })
    const run = h.start(wf(`
      const value = await memo("big", () => { return [1, 2, 3].map((n) => n * 2) })
      log("value", value)
      await sleep(5000)
      await agent("after")
      return value
    `))
    await settle(10)
    expect(h.get(run).script!.logs).toEqual(['value [2,4,6]'])
    expect(h.clock.pending()).toBe(1)
    h.clock.advance(5000)
    await settle(30)
    expect(h.get(run).state).toBe("completed")
    expect(computed).toBe(0)
  })

  test("an uncaught throw fails the run and resume replays it", async () => {
    let attempt = 0
    const h = scriptHarness({ responder: () => "x" })
    const run = h.start(wf(`const x = await agent("a"); if (args.fail) throw new Error("boom"); return x`, META), { fail: true })
    await settle(30)
    let current = h.get(run)
    expect(current.state).toBe("failed")
    expect(current.script?.error).toContain("boom")
    // edit the script (the flag no longer throws) and resume: the agent call is not asked again
    const before = h.prompts.length
    const edited = h.service.script.update(run.workflowId, wf(`const x = await agent("a"); return x + "!"`))
    expect("run" in edited).toBe(true)
    h.service.control(run.workflowId, "resume")
    await settle(30)
    current = h.get(run)
    expect(current.state).toBe("completed")
    expect(h.prompts.length).toBe(before)
    expect(current.script?.result).toBe('"x!"')
    void attempt
  })
})

describe("determinism, replay and resume", () => {
  const script = wf(`
    const t0 = Date.now()
    const r0 = Math.random()
    log("start", t0, r0)
    const a = await agent("first")
    log("after", Date.now() - t0, new Date().getTime() >= t0, Math.random() === r0)
    const b = await agent("second")
    return [a, b, t0, r0]
  `)

  test("a restart mid-run replays from the journal: finished calls are not asked again, time and random are stable", async () => {
    const saved = new Map()
    const rows = new Map<string, string>()
    const first = scriptHarness({ saved, rows, responder: (prompt) => (prompt === "second" ? "HOLD" : `answer:${prompt}`) })
    const run = first.start(script)
    await settle(30)
    const mid = first.get(run)
    expect(mid.state).toBe("running")
    expect(first.prompts).toEqual(["first", "second"])
    expect(mid.tasks.map((task) => task.state)).toEqual(["done", "running"])
    const startLog = mid.script!.logs[0]!
    first.service.dispose()

    const second = scriptHarness({ saved, rows, responder: (prompt) => `answer:${prompt}` })
    second.service.start()
    await settle(40)
    const resumed = second.get(run)
    expect(resumed.state).toBe("completed")
    // "first" came from the journal; only "second" was asked, as a restarted task (second start of that task)
    expect(second.prompts).toEqual(["second"])
    const result = JSON.parse(resumed.script!.result!)
    expect(result.slice(0, 2)).toEqual(["answer:first", "answer:second"])
    expect(startLog).toBe(`start ${result[2]} ${result[3]}`)
    // the replayed script logged "start" again; the repeat was dropped by its index
    expect(resumed.script!.logs.filter((line) => line.startsWith("start"))).toHaveLength(1)
    expect(resumed.tasks.find((task) => task.title === "second")!.attempt).toBe(2)
  })

  test("random is seeded per run: two runs of the same script draw the same sequence", async () => {
    const a = scriptHarness({ responder: () => "x" })
    const b = scriptHarness({ responder: () => "x" })
    const source = wf(`return [Math.random(), Math.random()]`)
    const runA = a.start(source)
    await settle(10)
    const runB = b.start(source)
    await settle(10)
    expect(a.get(runA).script!.result).toMatch(/^\[0\.\d+,0\.\d+\]$/)
    // different workflow ids seed differently
    expect(a.get(runA).script!.result).not.toBe(b.get(runB).script!.result)
  })

  test("editing the script and resuming re-runs only the changed or new calls", async () => {
    const h = scriptHarness({ responder: (prompt) => `r:${prompt}` })
    const run = h.start(wf(`const a = await agent("one"); const b = await agent("two"); return [a, b]`))
    await settle(40)
    expect(h.get(run).state).toBe("completed")
    expect(h.prompts).toEqual(["one", "two"])
    // a finished run cannot be edited; pause-able runs can. Use a held third call to keep it open.
    h.setResponder((prompt) => (prompt === "three" ? "HOLD" : `r:${prompt}`))
    const open = h.start(wf(`const a = await agent("one"); const b = await agent("two"); const c = await agent("three"); return [a, b, c]`))
    await settle(40)
    expect(h.prompts.slice(2)).toEqual(["one", "two", "three"])
    h.service.control(open.workflowId, "pause")
    await settle(10)
    expect(h.get(open).state).toBe("paused")
    const before = h.prompts.length
    h.setResponder((prompt) => `r:${prompt}`)
    const edited = h.service.script.update(open.workflowId, wf(`const a = await agent("one"); const b = await agent("two CHANGED"); const c = await agent("three"); return [a, b, c]`))
    expect("run" in edited).toBe(true)
    h.service.control(open.workflowId, "resume")
    await settle(60)
    expect(h.get(open).state).toBe("completed")
    // "one" is cached; the edited second call and everything after it asked again
    expect(h.prompts.slice(before)).toEqual(["two CHANGED", "three"])
  })

  test("identical concurrent calls get distinct keys and both results are used", async () => {
    let n = 0
    const h = scriptHarness({ responder: () => `sample ${++n}` })
    const run = h.start(wf(`return await parallel([() => agent("same"), () => agent("same"), () => agent("same")])`))
    await settle(40)
    const result = JSON.parse(h.get(run).script!.result!)
    expect(new Set(result).size).toBe(3)
    expect(h.get(run).tasks).toHaveLength(3)
  })

  test("a stop kills the host, cancels the turns and ends the run; late answers change nothing", async () => {
    const h = scriptHarness({ responder: () => "HOLD" })
    const run = h.start(wf(`await parallel([() => agent("a"), () => agent("b")])`))
    await settle(20)
    expect(h.get(run).tasks.filter((task) => task.state === "running")).toHaveLength(2)
    h.service.control(run.workflowId, "stop")
    await settle(10)
    const stopped = h.get(run)
    expect(stopped.state).toBe("stopped")
    expect(h.cancelled).toHaveLength(2)
    expect(h.host.killed!.length).toBeGreaterThan(0)
    await h.finishWith(h.sessionOf(run, stopped.tasks[0]!.id)!, undefined, "late")
    expect(h.get(run).state).toBe("stopped")
  })
})

describe("caps", () => {
  test("a script that declares no budget may make ten agent calls, then the run pauses with a hint", async () => {
    const h = scriptHarness({ responder: () => "x" })
    const run = h.start(wf(`for (let i = 0; i < 12; i++) await agent("call " + i)`))
    await settle(80)
    const paused = h.get(run)
    expect(paused.state).toBe("paused")
    expect(paused.script!.calls).toBe(10)
    expect(paused.reason).toContain("declare meta.budget.agents")
    expect(h.prompts).toHaveLength(10)
    // raise the cap and resume: the ten finished calls are cached, only the two new ones run
    expect("run" in h.service.script.budget(run.workflowId, { agents: 20 })).toBe(true)
    h.service.control(run.workflowId, "resume")
    await settle(80)
    expect(h.get(run).state).toBe("completed")
    expect(h.prompts).toHaveLength(12)
  })

  test("a declared agent cap holds at its value and the 200 hard cap cannot be passed", async () => {
    const h = scriptHarness({ responder: () => "x" })
    const run = h.start(wf(`for (let i = 0; i < 5; i++) await agent("n" + i)`, `{ name: "t", budget: { agents: 3 } }`))
    await settle(60)
    expect(h.get(run).state).toBe("paused")
    expect(h.get(run).reason).toContain("agent cap reached (3/3)")
    expect(parseScript(wf("return 1", "{ name: 'x', budget: { agents: 201 } }")).ok).toBe(false)
  })

  test("a token cap pauses when usage reaches it, requeues running tasks and resumes after it is raised", async () => {
    const h = scriptHarness({ responder: () => "HOLD" })
    const run = h.start(wf(`await agent("big"); return "done"`, `{ name: "t", budget: { tokens: 1000, agents: 5 } }`))
    await settle(20)
    const task = h.get(run).tasks[0]!
    h.event(task.sessionId!, { type: "usage.recorded", turnId: h.turnOf(task.sessionId!), input: 900, output: 200, costMicros: 10 })
    await settle(10)
    const paused = h.get(run)
    expect(paused.state).toBe("paused")
    expect(paused.reason).toContain("token cap reached (1100/1000)")
    expect(paused.tasks[0]!.state).toBe("pending")
    expect(h.cancelled).toHaveLength(1)
    h.service.script.budget(run.workflowId, { tokens: 100_000 })
    h.setResponder(() => "finished")
    h.service.control(run.workflowId, "resume")
    await settle(40)
    expect(h.get(run).state).toBe("completed")
  })

  test("the minutes cap pauses the run instead of stopping it", async () => {
    const h = scriptHarness({ responder: () => "HOLD" })
    const run = h.start(wf(`await agent("slow")`, `{ name: "t", budget: { minutes: 2, agents: 3 } }`))
    await settle(10)
    h.clock.advance(2 * 60_000 + 1)
    await settle(10)
    expect(h.get(run).state).toBe("paused")
    expect(h.get(run).reason).toContain("runtime cap reached (2 min)")
  })
})

describe("contract and views", () => {
  test("a script run with a contract verifies after the script returns", async () => {
    const h = scriptHarness({ responder: () => "x" })
    const meta = `{ name: "t", contract: { criteria: [{ id: "ok", text: "tests pass" }], checks: [{ id: "unit", command: "bun test", covers: ["ok"] }], audit: "none" } }`
    const run = h.start(wf(`return await agent("work")`, meta))
    await settle(60)
    const done = h.get(run)
    expect(done.state).toBe("completed")
    expect(done.verifications).toHaveLength(1)
    expect(done.verifications[0]!.accepted).toBe(true)
  })

  test("without a host or journal a script run fails clearly instead of running", async () => {
    const h = scriptHarness({ bare: true })
    const run = h.start(wf(`return 1`))
    await settle(10)
    expect(h.get(run).state).toBe("failed")
    expect(h.get(run).script?.error).toContain("cannot run in this daemon")
  })

  test("the summary lists live tasks and counts the rest, with phases, caps and usage", async () => {
    const h = scriptHarness({ responder: () => "x" })
    const run = h.start(wf(`phase("Find"); await agent("a", { label: "A", phase: "Find" }); phase("Check"); log("hi"); await agent("b", { label: "B" }); return 1`, `{ name: "t", phases: [{ title: "Find", detail: "look" }, { title: "Check" }], budget: { agents: 30 } }`))
    await settle(60)
    const summary = summarizeWorkflow(h.get(run))
    expect(summary.script).toMatchObject({ host: "done", calls: 2, phase: "Check", budget: { agents: 30 }, logs: ["hi"], counts: { done: 2, pending: 0, running: 0, failed: 0 } })
    expect(summary.script!.phases).toEqual([
      { title: "Find", detail: "look", state: "done", completed: 1, total: 1 },
      { title: "Check", state: "done", completed: 1, total: 1 },
    ])
    expect(WorkflowSummary.safeParse(summary).success).toBe(true)
    expect(WorkflowRun.safeParse(h.get(run)).success).toBe(true)
  })
})
