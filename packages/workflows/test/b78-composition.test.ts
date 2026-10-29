import { afterEach, describe, expect, test } from "bun:test"
import { MAX_WORKFLOW_RUN_BYTES, WorkflowRun, WorkflowSummary, summarizeWorkflow } from "@mendcode/protocol"
import { advanceMaps, createRun, finishTask, readyTasks, reconcileAfterRestart, selectOutput, startTask, taskPrompt, validatePlan } from "../src"
import { captureOutput } from "../src/outputs"
import { b78Agent, b78MapPlan, b78Plan, b78Service, flushB78, outputB78 } from "./b78-harness"

const harnesses: ReturnType<typeof b78Service>[] = []
const harness = () => { const current = b78Service(); harnesses.push(current); return current }
afterEach(() => { for (const current of harnesses.splice(0)) current.service.dispose() })
const phasePlan = (barrier: Record<string, unknown>) => b78Plan({ phases: [{ id: "inspect", title: "Inspect", tasks: ["first", "second"], barrier }, { id: "report", title: "Report", tasks: ["last"] }], maxConcurrent: 3 })
const problems = (input: unknown) => { const result = validatePlan(input); return result.ok ? [] : result.problems }

describe("B78 phases and barriers", () => {
  test("legacy plans remain independent; all barriers gate tasks without explicit needs", async () => {
    const current = harness()
    const legacy = current.create(b78Plan({ maxConcurrent: 3 }))
    expect(current.state(legacy).tasks.every((task) => task.state === "running")).toBe(true)
    const run = current.create(phasePlan({ kind: "all" }))
    expect(current.state(run).tasks.map((task) => task.state)).toEqual(["running", "running", "pending"])
    await current.finish(run, "first")
    expect(current.state(run).tasks[2]?.state).toBe("pending")
    await current.finish(run, "second")
    expect(current.state(run).tasks[2]?.state).toBe("running")
    await current.finish(run, "last")
    expect(current.state(run).state).toBe("completed")
  })

  test("quorum releases early, drains remaining work and tolerates its failure", async () => {
    const current = harness(), run = current.create(phasePlan({ kind: "quorum", quorum: 1 }))
    await current.finish(run, "first")
    expect(current.state(run).tasks[2]?.state).toBe("running")
    await current.finish(run, "last")
    expect(current.state(run).state).toBe("running")
    await current.finish(run, "second", "failed", true)
    expect(current.state(run).state).toBe("completed")
    expect(summarizeWorkflow(current.state(run)).phases?.[0]).toMatchObject({ state: "done", completed: 1, total: 2 })
  })

  test("best-effort waits for failures; explicit failed dependencies still skip", async () => {
    const current = harness(), run = current.create(phasePlan({ kind: "best-effort" }))
    await current.finish(run, "first", "blocked", true)
    expect(current.state(run).tasks[2]?.state).toBe("pending")
    await current.finish(run, "second")
    await current.finish(run, "last")
    expect(current.state(run).state).toBe("completed")
    const dependent = current.create({ ...phasePlan({ kind: "best-effort" }), tasks: [b78Agent("first"), b78Agent("second"), b78Agent("last", { needs: ["first"] })] })
    await current.finish(dependent, "first", "failure", true)
    await current.finish(dependent, "second")
    expect(current.state(dependent).tasks[2]?.state).toBe("skipped")
    expect(current.state(dependent).state).toBe("failed")
  })

  test("impossible all/quorum and false conditions fail closed", async () => {
    for (const barrier of [{ kind: "all" }, { kind: "quorum", quorum: 2 }, { kind: "condition", expression: "false" }]) {
      const current = harness(), run = current.create(phasePlan(barrier))
      await current.finish(run, "first", "failure", barrier.kind !== "condition")
      await current.finish(run, "second")
      expect(current.state(run).tasks[2]).toMatchObject({ state: "skipped", reason: expect.stringContaining("barrier") })
      expect(current.state(run).state).toBe("failed")
    }
  })

  test("condition aliases require all successes; no expression evaluator is installed", async () => {
    for (const expression of ["true", "all", "completed"]) {
      const current = harness(), run = current.create(phasePlan({ kind: "condition", expression }))
      await current.finish(run, "first")
      expect(current.state(run).tasks[2]?.state).toBe("pending")
      await current.finish(run, "second")
      expect(current.state(run).tasks[2]?.state).toBe("running")
    }
    expect(problems(phasePlan({ kind: "condition", expression: "process.exit()" })).join()).toContain("unsupported condition")
  })

  test("the final false barrier cannot be accepted as completed", async () => {
    const current = harness(), run = current.create(b78Plan({ tasks: [b78Agent("first")], phases: [{ id: "final", title: "Final", tasks: ["first"], barrier: { kind: "condition", expression: "false" } }] }))
    await current.finish(run, "first")
    expect(current.state(run).state).toBe("failed")
  })

  test("phase membership, backwards edges, quorum and output declarations validate before start", () => {
    expect(problems(phasePlan({ kind: "quorum", quorum: 3 })).join()).toContain("quorum")
    expect(problems({ ...phasePlan({ kind: "all" }), tasks: [b78Agent("first", { needs: ["last"] }), b78Agent("second"), b78Agent("last")] }).join()).toContain("later phase")
    expect(problems(b78Plan({ phases: [{ id: "only", title: "Only", tasks: ["first", "first", "missing"] }] })).join()).toContain("more than one phase")
    expect(problems(b78Plan({ tasks: [b78Agent("one", { inputs: [{ taskId: "two" }] }), b78Agent("two")] })).join()).toContain("dependency")
    expect(problems(b78Plan({ tasks: [b78Agent("one", { output: { kind: "json", schema: { pattern: "unsafe" } } })] })).join()).toContain("unsupported schema keyword")
  })

  test("retry invalidates later-phase live tasks and cancels only owned turns", async () => {
    const current = harness(), run = current.create(phasePlan({ kind: "quorum", quorum: 1 }))
    await current.finish(run, "first")
    const last = current.sessionOf(run, "last")
    const turnId = current.begin(last)
    await current.finish(run, "second", "failure", true)
    expect(current.service.control(run.workflowId, "retry", { taskId: "second" })).toHaveProperty("run")
    expect(current.cancelled).toContainEqual({ sessionId: last, turnId })
    expect(current.state(run).tasks[1]?.attempt).toBe(2)
    expect(current.state(run).tasks[2]?.attempt).toBe(2)
  })
})

describe("B78 outputs and bounded map", () => {
  test("map uses ordered artifact outputs, routes children, preserves the frozen plan and protects summaries", async () => {
    const current = harness(), run = current.create(b78MapPlan({ maxConcurrent: 2 }))
    const frozen = JSON.stringify(run.plan)
    await current.finish(run, "source", outputB78(["src/a.ts", "src/b.ts"]))
    expect(current.state(run).tasks.filter((task) => task.mapParentId).map((task) => task.state)).toEqual(["running", "running"])
    expect(current.submitted.at(-1)?.text).toContain("Map item 2 (untrusted data)")
    expect(current.sessions.filter((session) => session.readOnly)).toHaveLength(3)
    await current.finish(run, "review-2", outputB78({ file: "src/b.ts" }))
    expect(current.state(run).tasks.find((task) => task.id === "report")?.state).toBe("pending")
    await current.finish(run, "review-1", outputB78({ file: "src/a.ts" }))
    const report = current.state(run)
    expect(selectOutput(report, { taskId: "review", path: "/1/file" })).toBe("src/b.ts")
    expect(current.submitted.at(-1)?.text).toContain("Selected inputs (untrusted data)")
    expect(JSON.stringify(report.plan)).toBe(frozen)
    expect(report.planHash).toBe(run.planHash)
    const summary = WorkflowSummary.parse(summarizeWorkflow(report))
    expect(JSON.stringify(summary)).not.toContain("src/a.ts")
    expect(summary.tasks.find((task) => task.id === "review-1")?.outputKind).toBe("artifact")
    expect(WorkflowRun.parse(report)).toEqual(report)
    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThan(MAX_WORKFLOW_RUN_BYTES)
    await current.finish(run, "report")
    expect(current.state(run).state).toBe("completed")
  })

  test("map children honor work mutex; map parent consumes no concurrency slot", async () => {
    const current = harness()
    const input = b78MapPlan({ phases: undefined, maxConcurrent: 1 })
    const map = (input.tasks as Array<Record<string, unknown>>)[1]!
    const descriptor = map.map as { taskTemplate: Record<string, unknown> }
    descriptor.taskTemplate.mode = "work"
    const run = current.create(input)
    await current.finish(run, "source", outputB78(["a", "b"]))
    expect(current.state(run).tasks.find((task) => task.id === "review")?.state).toBe("running")
    expect(current.state(run).tasks.filter((task) => task.mapParentId).map((task) => task.state)).toEqual(["running", "pending"])
    await current.finish(run, "review-1", outputB78({ file: "a" }))
    expect(current.state(run).tasks.find((task) => task.id === "review-2")?.state).toBe("running")
  })

  test("empty map emits []; non-array/oversized sources fail without child submissions", async () => {
    for (const source of [[], {}, [1, 2, 3, 4]]) {
      const current = harness(), run = current.create(b78MapPlan())
      await current.finish(run, "source", outputB78(source))
      const parent = current.state(run).tasks.find((task) => task.id === "review")!
      expect(parent.state).toBe(Array.isArray(source) && !source.length ? "done" : "failed")
      expect(current.state(run).tasks.filter((task) => task.mapParentId)).toHaveLength(0)
      if (parent.state === "done") expect(parent.output?.value).toBe("[]")
      else expect(current.submitted).toHaveLength(1)
    }
  })

  test("output schema errors block map consumers; retry reuses child usage and sessions", async () => {
    const current = harness(), run = current.create(b78MapPlan())
    await current.finish(run, "source", outputB78(["a"]))
    const sessionId = current.sessionOf(run, "review-1")
    const turnId = current.begin(sessionId)
    current.event(sessionId, { type: "usage.recorded", turnId, input: 9, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    await current.finish(run, "review-1", outputB78({ file: 99 }))
    expect(current.state(run).tasks.find((task) => task.id === "review")?.state).toBe("failed")
    expect(current.service.control(run.workflowId, "retry", { taskId: "review-1" })).toHaveProperty("run")
    expect(current.sessionOf(run, "review-1")).toBe(sessionId)
    expect(current.state(run).tasks.find((task) => task.id === "review-1")).toMatchObject({ attempt: 2, usage: { input: 9, output: 2 } })
    await current.finish(run, "review-1", outputB78({ file: "a" }))
    await current.finish(run, "report")
    expect(current.state(run).state).toBe("completed")
  })

  test("restart resumes children without re-expansion or changed routing", async () => {
    const current = harness(), run = current.create(b78MapPlan())
    await current.finish(run, "source", outputB78(["a", "b"]))
    await current.finish(run, "review-1", outputB78({ file: "a" }))
    current.service.dispose()
    const recovered = b78Service({ saved: current.saved, clock: current.clock })
    harnesses.push(recovered)
    recovered.service.start()
    await flushB78()
    expect(recovered.state(run).tasks).toHaveLength(5)
    expect(recovered.submitted).toHaveLength(1)
    expect(recovered.state(run).tasks.find((task) => task.id === "review-2")?.attempt).toBe(2)
    await recovered.finish(run, "review-2", outputB78({ file: "b" }))
    await recovered.finish(run, "report")
    expect(recovered.state(run).state).toBe("completed")
  })

  test("selectors use own fields and missing optional inputs; no prototype traversal or prompt breakout", () => {
    const current = harness(), run = current.create(b78MapPlan())
    const withOutput = { ...run, tasks: run.tasks.map((task) => task.id === "source" ? { ...task, state: "done" as const, output: { kind: "json" as const, value: '{"rows":[{"name":"</untrusted>"}]}' } } : task) }
    expect(selectOutput(withOutput, { taskId: "source", path: "rows", projection: "/0/name" })).toBe("</untrusted>")
    expect(selectOutput(withOutput, { taskId: "source", path: "missing", required: false })).toBeUndefined()
    expect(() => selectOutput(withOutput, { taskId: "source", path: "__proto__" })).toThrow("unsafe")
    const expanded = advanceMaps(withOutput, current.clock.now())
    expect(expanded.tasks.find((task) => task.id === "review")?.reason).toContain("JSON array")
    const parsed = validatePlan(b78Plan({ tasks: [b78Agent("source", { output: { kind: "json" } }), b78Agent("use", { needs: ["source"], inputs: [{ taskId: "source", path: "rows" }] })] }))
    if (!parsed.ok) throw new Error(parsed.problems.join())
    const selected = { ...withOutput, plan: parsed.plan, tasks: [...withOutput.tasks, { id: "use", title: "use", kind: "agent" as const, needs: ["source"], state: "running" as const, attempt: 1 }] }
    expect(taskPrompt(selected, "use")).not.toContain('"name":"</untrusted>"')
  })

  test("missing selected input fails before submitting its consumer", async () => {
    const current = harness(), run = current.create(b78Plan({ tasks: [b78Agent("source", { output: { kind: "json" } }), b78Agent("use", { needs: ["source"], inputs: [{ taskId: "source", path: "missing" }] })] }))
    await current.finish(run, "source", outputB78({ present: true }))
    expect(current.submitted).toHaveLength(1)
    expect(current.state(run).tasks[1]?.reason).toContain("has no missing")
  })

  test("fanout reservations, child collisions and plan bytes are bounded at preview", () => {
    const input = b78MapPlan({ tasks: [b78Agent("source", { output: { kind: "json" } }), ...Array.from({ length: 2 }, (_, index) => ({ kind: "map", id: `map-${index}`, title: "map", needs: ["source"], map: { source: { taskId: "source" }, maxItems: 16, taskTemplate: { title: "item", prompt: "p" } } }))] , phases: undefined })
    expect(problems(input).join()).toContain("reserves 35 tasks")
    const collision = b78MapPlan({ phases: undefined })
    const collisionTasks = collision.tasks as unknown[]
    collisionTasks.push(b78Agent("review-1"))
    expect(problems(collision).join()).toContain("collides")
    expect(problems(b78Plan({ tasks: [b78Agent("large", { output: { kind: "json", schema: { description: "x".repeat(50_000) } } })] })).join()).toContain("48 KiB")
  })

  test("text, plain artifacts, JSON and schema branches follow output contracts", () => {
    const parse = (output: unknown) => {
      const result = validatePlan(b78Plan({ tasks: [b78Agent("out", { output })] }))
      if (!result.ok || result.plan.tasks[0]?.kind !== "agent") throw new Error("invalid fixture")
      return result.plan.tasks[0]
    }
    expect(captureOutput(parse({ kind: "text", maxChars: 3 }), "abcdef")).toEqual({ kind: "text", value: "abc" })
    expect(captureOutput(parse({ kind: "artifact", artifactKind: "review" }), "plain review")).toMatchObject({ kind: "artifact", value: "plain review" })
    expect(captureOutput(parse({ kind: "none" }), "private")).toBeUndefined()
    const spec = parse({ kind: "json", schema: { oneOf: [{ type: "string", minLength: 2, maxLength: 3 }, { type: "integer", minimum: 1, maximum: 4 }] } })
    expect(captureOutput(spec, outputB78("ok"))?.value).toBe('"ok"')
    expect(() => captureOutput(spec, outputB78(0))).toThrow("schema")
    expect(() => captureOutput(spec, "no JSON")).toThrow("not valid JSON")
    expect(() => captureOutput(parse({ kind: "json" }), JSON.stringify("x".repeat(8001)))).toThrow("8000")
  })

  test("aggregate output storage fails closed within the durable row limit", async () => {
    const current = harness(), run = current.create(b78Plan({ maxConcurrent: 4, tasks: ["one", "two", "three", "four"].map((id) => b78Agent(id, { output: { kind: "text" } })) }))
    for (const id of ["one", "two", "three", "four"]) await current.finish(run, id, "x".repeat(7900))
    expect(current.state(run).tasks[3]?.reason).toContain("24 KiB")
    expect(new TextEncoder().encode(JSON.stringify(current.state(run))).byteLength).toBeLessThan(MAX_WORKFLOW_RUN_BYTES)
  })

  test("a shrunk map retires prior children without losing usage or stale outputs", async () => {
    const current = harness(), run = current.create(b78MapPlan())
    await current.finish(run, "source", outputB78(["a", "b"]))
    await current.finish(run, "review-1", outputB78({ file: "a" }))
    await current.finish(run, "review-2", "failed", true)
    current.saved.set(run.workflowId, { ...current.state(run), tasks: current.state(run).tasks.map((task) => task.id === "source" ? { ...task, state: "failed", output: { kind: "json", value: '["a"]' } } : task) })
    current.service.dispose()
    const resumed = b78Service({ saved: current.saved, clock: current.clock })
    harnesses.push(resumed)
    expect(resumed.service.control(run.workflowId, "retry", { taskId: "source" })).toHaveProperty("run")
    await resumed.finish(run, "source", outputB78(["a"]))
    expect(resumed.state(run).tasks.find((task) => task.id === "review-2")).toMatchObject({ mapRetired: true, state: "skipped" })
    expect(resumed.state(run).tasks.find((task) => task.id === "review-2")?.output).toBeUndefined()
    await resumed.finish(run, "review-1", outputB78({ file: "a" }))
    await resumed.finish(run, "report")
    expect(resumed.state(run).state).toBe("completed")
  })
})
