import { describe, expect, test } from "bun:test"
import { parseScript } from "../../../packages/workflows/src"
import { output, scriptHarness, settle } from "../../../packages/workflows/test/script-harness"
import { planToScript } from "../src/view/workflow-convert"
import { parseRunArguments, workflowStarter } from "../src/view/workflow-script"
import { parseWorkflowCommand } from "../src/view/workflow-command"

describe("script helpers of the terminal client", () => {
  test("run arguments are a JSON object or key=value pairs", () => {
    expect(parseRunArguments("")).toEqual({ ok: true, args: undefined })
    expect(parseRunArguments('{"a":1,"b":["x"]}')).toEqual({ ok: true, args: { a: 1, b: ["x"] } })
    expect(parseRunArguments('topic="the retry logic" depth=3 deep=true name=plain')).toEqual({ ok: true, args: { topic: "the retry logic", depth: 3, deep: true, name: "plain" } })
    expect(parseRunArguments("[1]").ok).toBe(false)
    expect(parseRunArguments("{bad").ok).toBe(false)
    expect(parseRunArguments("novalue").ok).toBe(false)
    expect(parseRunArguments("__proto__=1").ok).toBe(false)
  })

  test("the starter is a valid script, declares a budget, and runs end to end", async () => {
    const source = workflowStarter("my-flow")
    const parsed = parseScript(source)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.meta).toMatchObject({ name: "my-flow", budget: { agents: 8, usd: 2, minutes: 30 }, phases: [{ title: "Explore" }, { title: "Summarize" }] })
    const h = scriptHarness({ responder: (prompt) => (prompt.startsWith("List three") ? output({ angles: ["a", "b"] }) : "notes") })
    const run = h.start(source, { topic: "retries" })
    await settle(60)
    expect(h.get(run).state).toBe("completed")
    expect(h.get(run).tasks).toHaveLength(4)
  })
})

describe("workflow convert", () => {
  const plan = {
    name: "ship",
    objective: "Build and verify",
    phases: [{ id: "build", title: "Build", tasks: ["research", "design"], barrier: { kind: "all" } }, { id: "verify", title: "Verify", tasks: ["implement", "test"], barrier: { kind: "all" } }],
    tasks: [
      { kind: "agent", id: "research", title: "Research", prompt: "look around", mode: "read", needs: [] },
      { kind: "agent", id: "design", title: "Design", prompt: "sketch it", mode: "read", needs: [] },
      { kind: "agent", id: "implement", title: "Implement", prompt: "write the code", mode: "work", needs: ["research", "design"], model: { model: "openai:gpt-x", effort: "high" }, retry: { maxAttempts: 2 }, output: { kind: "json", schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } } } },
      { kind: "check", id: "test", title: "Test", command: "bun test", needs: ["implement"] },
      { kind: "human", id: "signoff", title: "Sign off", prompt: "ship it?", needs: ["test"] },
    ],
    contract: { criteria: [{ id: "tests", text: "tests pass", required: true }], checks: [{ id: "unit", command: "bun test", covers: ["tests"] }], audit: "none" },
    permission: "edits",
  }

  test("a plan becomes a script that validates, with levels in parallel, results passed on and the contract in meta", () => {
    const converted = planToScript(plan, "ship.json")
    expect(converted.ok).toBe(true)
    if (!converted.ok) return
    const parsed = parseScript(converted.script)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.meta).toMatchObject({ name: "ship", permission: "edits", contract: { checks: [{ command: "bun test" }] }, phases: [{ title: "Build" }, { title: "Verify" }] })
    expect(converted.script).toContain("const [r_research, r_design] = await parallel([")
    expect(converted.script).toContain("Results of the tasks you depend on:")
    expect(converted.script).toContain('mode: "work"')
    expect(converted.script).toContain('model: "openai:gpt-x", effort: "high"')
    expect(converted.script).toContain("retry: {\"maxAttempts\":2}")
  })

  test("the converted script runs: level order, results flow into later prompts, a failing check stops the run", async () => {
    const converted = planToScript(plan)
    if (!converted.ok) throw new Error(converted.problems.join())
    const h = scriptHarness({ checkExit: () => 0, responder: (prompt) => (prompt.startsWith("write the code") ? output({ files: ["a.ts"] }) : "R:" + prompt.slice(0, 12)) })
    const run = h.start(converted.script)
    await settle(80)
    // two read agents in parallel, then the implementation with their results, then the check, then the human gate
    const implement = h.submitted.find((entry) => entry.text.includes("write the code"))!.text
    expect(implement).toContain("## research")
    expect(implement).toContain("R:look around")
    expect(h.get(run).state).toBe("needs_input")
    expect(h.ran).toEqual([["bun", "test"]])

    const failing = scriptHarness({ checkExit: () => 1, responder: (prompt) => (prompt.startsWith("write the code") ? output({ files: [] }) : "ok") })
    const failed = failing.start(converted.script)
    await settle(80)
    expect(failing.get(failed).state).toBe("failed")
    expect(failing.get(failed).script?.error).toContain("check test failed")
  })

  test("map tasks are refused with the reason; an empty or non-object plan is refused", () => {
    expect(planToScript({ name: "m", tasks: [{ kind: "map", id: "each", title: "Each", map: {}, needs: [] }] })).toMatchObject({ ok: false, problems: [expect.stringContaining("map task")] })
    expect(planToScript({ name: "m", tasks: [] }).ok).toBe(false)
    expect(planToScript("nope").ok).toBe(false)
  })
})

describe("/workflows command for scripts", () => {
  test("run takes a script file or a saved name with arguments", () => {
    expect(parseWorkflowCommand("run examples/workflows/research.js question=\"how?\" --yes")).toEqual({ ok: true, spec: { kind: "run", source: { file: "examples/workflows/research.js" }, args: { question: "how?" }, confirmed: true } })
    expect(parseWorkflowCommand('run research {"question":"x"}')).toEqual({ ok: true, spec: { kind: "run", source: { ref: "research" }, args: { question: "x" }, confirmed: false } })
    expect(parseWorkflowCommand("run")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("run a.js --permission edits")).toMatchObject({ ok: true, spec: { kind: "run", permission: "edits" } })
  })

  test("a .js file without run is a script too; .json and names keep their meaning", () => {
    expect(parseWorkflowCommand("flow.js")).toMatchObject({ ok: true, spec: { kind: "run", source: { file: "flow.js" } } })
    expect(parseWorkflowCommand("plan.json")).toEqual({ ok: true, spec: { kind: "start", source: { file: "plan.json" }, confirmed: false } })
    expect(parseWorkflowCommand("saved-plan --yes")).toEqual({ ok: true, spec: { kind: "start", source: { ref: "saved-plan" }, confirmed: true } })
  })

  test("new, convert, budget, update and resume", () => {
    expect(parseWorkflowCommand("new my-flow")).toEqual({ ok: true, spec: { kind: "new", name: "my-flow" } })
    expect(parseWorkflowCommand("new")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("new Bad Name")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("convert plan.json")).toEqual({ ok: true, spec: { kind: "convert", file: "plan.json" } })
    expect(parseWorkflowCommand("budget wf_1 agents=60 tokens=2000000 usd=5 minutes=90")).toEqual({ ok: true, spec: { kind: "budget", workflowId: "wf_1", budget: { agents: 60, tokens: 2_000_000, usd: 5, minutes: 90 } } })
    expect(parseWorkflowCommand("budget wf_1")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("budget wf_1 agents=lots")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("budget wf_1 bogus=3")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("update wf_1 flow.js")).toEqual({ ok: true, spec: { kind: "update", workflowId: "wf_1", file: "flow.js" } })
    expect(parseWorkflowCommand("resume wf_1")).toEqual({ ok: true, spec: { kind: "resume", workflowId: "wf_1" } })
    expect(parseWorkflowCommand("accept wf_1 done")).toMatchObject({ ok: true, spec: { kind: "accept" } })
  })
})
