import { describe, expect, test } from "bun:test"
import type { WorkflowContract } from "@mendcode/protocol"
import { MAX_PLAN_PROBLEMS, MAX_PLAN_PROMPT_CHARS, levels, resolveContract, validateContract, validatePlan } from "../src"

type Task = Record<string, unknown>
const agent = (id: string, needs: string[] = [], extra: Task = {}): Task => ({ kind: "agent", id, title: id, prompt: `do ${id}`, needs, ...extra })
const check = (id: string, command: string, needs: string[] = []): Task => ({ kind: "check", id, title: id, command, needs })
const plan = (tasks: Task[], extra: Task = {}) => ({ name: "wf", objective: "Do the thing.", tasks, ...extra })

function problemsOf(value: unknown) {
  const result = validatePlan(value)
  if (result.ok) throw new Error("expected the plan to be rejected")
  return result.problems
}

describe("validatePlan", () => {
  test("accepts a plan and returns it with defaults filled in", () => {
    const result = validatePlan({ name: "wf", objective: "x", tasks: [{ kind: "agent", id: "a", title: "A", prompt: "go" }] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.tasks[0]).toMatchObject({ needs: [], mode: "work" })
  })

  test("accepts a diamond graph with checks and an inline contract", () => {
    const result = validatePlan(
      plan([agent("a"), agent("b", ["a"]), agent("c", ["a"]), check("unit", "bun test", ["b", "c"])], {
        contract: {
          criteria: [{ id: "tests", text: "Tests pass", owners: ["b", "c"] }],
          checks: [{ id: "unit", command: 'bun test --grep "a b"', covers: ["tests"], owners: ["b"] }],
        },
      }),
    )
    expect(result.ok).toBe(true)
  })

  test("a contract given by name passes through unresolved", () => {
    expect(validatePlan(plan([agent("a")], { contract: "release-gate" })).ok).toBe(true)
  })

  test("shape errors name the task by id and come back as problems", () => {
    const problems = problemsOf(plan([agent("a"), { kind: "agent", id: "broken", title: "B" }]))
    expect(problems.some((problem) => problem.includes('task "broken"') && problem.includes("prompt"))).toBe(true)
  })

  test("shape errors before the plan is an object do not throw", () => {
    expect(problemsOf(null).length).toBeGreaterThan(0)
    expect(problemsOf("plan").length).toBeGreaterThan(0)
    expect(problemsOf({}).length).toBeGreaterThan(0)
  })

  test("rejects duplicate task ids", () => {
    expect(problemsOf(plan([agent("a"), agent("a")]))).toEqual(['task id "a" is used more than once'])
  })

  test("rejects a need that does not exist", () => {
    expect(problemsOf(plan([agent("a", ["ghost"])]))).toEqual(['task "a" needs unknown task "ghost"'])
  })

  test("rejects a task that needs itself or lists a need twice", () => {
    expect(problemsOf(plan([agent("a", ["a"])]))).toContain('task "a" needs itself')
    expect(problemsOf(plan([agent("a"), agent("b", ["a", "a"])]))).toEqual(['task "b" lists "a" twice'])
  })

  test("rejects cycles and names the tasks on it", () => {
    const problems = problemsOf(plan([agent("a", ["c"]), agent("b", ["a"]), agent("c", ["b"]), agent("free")]))
    expect(problems).toEqual(["tasks form a cycle: a needs c needs b needs a"])
  })

  test("a cycle downstream of a valid chain is still found", () => {
    const problems = problemsOf(plan([agent("root"), agent("x", ["root", "y"]), agent("y", ["x"])]))
    expect(problems).toEqual(["tasks form a cycle: x needs y needs x"])
  })

  test("rejects more than 32 tasks and more than 8 needs through the shape", () => {
    expect(problemsOf(plan(Array.from({ length: 33 }, (_, i) => agent(`t${i}`)))).length).toBeGreaterThan(0)
    const many = Array.from({ length: 9 }, (_, i) => `n${i}`)
    expect(problemsOf(plan([...many.map((id) => agent(id)), agent("z", many)])).length).toBeGreaterThan(0)
  })

  test("caps the total prompt size at 48 000 characters and names the longest task", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => agent(`t${i}`, [], { prompt: "x".repeat(i === 3 ? 8_000 : 7_000) }))
    const total = 6 * 7_000 + 8_000
    expect(total).toBeGreaterThan(MAX_PLAN_PROMPT_CHARS)
    expect(problemsOf(plan(tasks))).toEqual([`prompts total ${total} characters but the limit is ${MAX_PLAN_PROMPT_CHARS}; the longest is task "t3" (8000)`])
    const fits = Array.from({ length: 6 }, (_, i) => agent(`t${i}`, [], { prompt: "x".repeat(8_000) }))
    expect(validatePlan(plan(fits)).ok).toBe(true)
  })

  test("check tasks and contract checks must be plain argv", () => {
    for (const command of ["bun test | tee out", "bun test && rm -rf x", "cat < in", "echo $HOME", "bun 'test"]) {
      expect(problemsOf(plan([check("c", command)]))[0]).toContain('check task "c"')
      const contract = { criteria: [{ id: "k", text: "x" }], checks: [{ id: "gate", command }] }
      expect(problemsOf(plan([agent("a")], { contract }))[0]).toContain('contract check "gate"')
    }
  })

  test("contract ids must be unique", () => {
    const contract = { criteria: [{ id: "k", text: "x" }, { id: "k", text: "y" }], checks: [{ id: "g", command: "bun test" }, { id: "g", command: "bun test" }] }
    expect(problemsOf(plan([agent("a")], { contract }))).toEqual(['criterion id "k" is used more than once', 'contract check id "g" is used more than once'])
  })

  test("covers must name criteria and owners must name tasks", () => {
    const contract = {
      criteria: [{ id: "k", text: "x", owners: ["nobody"] }],
      checks: [{ id: "g", command: "bun test", covers: ["k", "missing"], owners: ["a", "ghost"] }],
    }
    expect(problemsOf(plan([agent("a")], { contract }))).toEqual([
      'criterion "k" names unknown owner task "nobody"',
      'contract check "g" covers unknown criterion "missing"',
      'contract check "g" names unknown owner task "ghost"',
    ])
  })

  test("reports at most five problems", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => agent(`t${i}`, [`ghost${i}`]))
    const problems = problemsOf(plan(tasks))
    expect(problems).toHaveLength(MAX_PLAN_PROBLEMS)
    expect(problems[0]).toBe('task "t0" needs unknown task "ghost0"')
  })
})

describe("validateContract", () => {
  const base: WorkflowContract = { criteria: [{ id: "k", text: "x", required: true, owners: ["impl"] }], checks: [{ id: "g", command: "bun test", covers: ["k"], owners: ["impl"] }], audit: "auto", maxRepairs: 2, maxAudits: 2 }

  test("without the plan's tasks it checks ids, covers and commands but not owners", () => {
    expect(validateContract(base)).toEqual([])
    expect(validateContract({ ...base, checks: [{ id: "g", command: "bun test > out" }] })[0]).toContain('contract check "g"')
  })

  test("with the plan's tasks it also checks owners", () => {
    expect(validateContract(base, new Set(["impl"]))).toEqual([])
    expect(validateContract(base, new Set(["other"]))).toEqual(['criterion "k" names unknown owner task "impl"', 'contract check "g" names unknown owner task "impl"'])
  })
})

describe("levels", () => {
  const level = (tasks: Task[]) => Object.fromEntries(levels({ tasks: tasks as Array<{ id: string; needs: string[] }> }))

  test("independent tasks share level 1", () => {
    expect(level([agent("a"), agent("b"), agent("c")])).toEqual({ a: 1, b: 1, c: 1 })
  })

  test("a task sits one level below its deepest need", () => {
    expect(level([agent("a"), agent("b", ["a"]), agent("c", ["a"]), agent("d", ["b", "c"]), agent("e", ["a", "d"])])).toEqual({ a: 1, b: 2, c: 2, d: 3, e: 4 })
  })

  test("plan order does not matter and is kept in the result", () => {
    const result = levels({ tasks: [agent("late", ["early"]), agent("early")] as Array<{ id: string; needs: string[] }> })
    expect([...result]).toEqual([["late", 2], ["early", 1]])
  })

  test("an unknown need is ignored and a cycle does not hang", () => {
    expect(level([agent("a", ["ghost"])])).toEqual({ a: 1 })
    const cyclic = level([agent("a", ["b"]), agent("b", ["a"])])
    expect(Object.keys(cyclic)).toEqual(["a", "b"])
  })
})

describe("resolveContract", () => {
  const contract: WorkflowContract = {
    criteria: [{ id: "tests", text: "Tests pass", required: true, owners: ["impl"] }],
    checks: [{ id: "unit", command: "bun test", covers: ["tests"] }],
    audit: "auto",
    maxRepairs: 2,
    maxAudits: 2,
  }
  const named = (name: string) => {
    const result = validatePlan(plan([agent("impl")], { contract: name }))
    if (!result.ok) throw new Error(result.problems.join("; "))
    return result.plan
  }

  test("replaces the name with the contract found", () => {
    const result = resolveContract(named("release-gate"), (name) => (name === "release-gate" ? contract : undefined))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.contract).toEqual(contract)
  })

  test("reports a name no layer provides", () => {
    expect(resolveContract(named("nope"), () => undefined)).toEqual({ ok: false, problems: ['contract "nope" was not found in any extension layer'] })
  })

  test("validates the frozen contract against this plan's tasks", () => {
    const stray: WorkflowContract = { ...contract, criteria: [{ id: "tests", text: "Tests pass", required: true, owners: ["other-task"] }] }
    expect(resolveContract(named("release-gate"), () => stray)).toEqual({ ok: false, problems: ['criterion "tests" names unknown owner task "other-task"'] })
  })

  test("an inline contract or none passes through unchanged", () => {
    const inline = validatePlan(plan([agent("impl")], { contract }))
    if (!inline.ok) throw new Error("inline plan should be valid")
    expect(resolveContract(inline.plan, () => undefined)).toEqual({ ok: true, plan: inline.plan })
    const bare = validatePlan(plan([agent("impl")]))
    if (!bare.ok) throw new Error("bare plan should be valid")
    expect(resolveContract(bare.plan, () => undefined)).toEqual({ ok: true, plan: bare.plan })
  })
})
