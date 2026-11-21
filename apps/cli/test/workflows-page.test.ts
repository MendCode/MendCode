import { describe, expect, test } from "bun:test"
import { createIdFactory, type WorkflowSummary, type WorkflowTaskState, type WorkflowTaskSummary, type WorkflowVerification } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createWorkflowsPageState, needsTick, renderWorkflowsPage, selectedWorkflow, workflowLevels, workflowsPageKey, workflowTaskOrder, type WorkflowsPageState } from "../src/view/workflows-page"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const MIN = 60_000

function task(id: string, over: Partial<WorkflowTaskSummary> = {}): WorkflowTaskSummary {
  return { id, title: id, kind: "agent", mode: "work", needs: [], state: "pending", attempt: 0, ...over }
}

function workflow(over: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    workflowId: ids("workflow"),
    name: "api rewrite",
    directory: "/Users/dev/Code/app",
    objective: "Rewrite the API layer to use the new client",
    planHash: "a".repeat(64),
    permission: "edits",
    state: "running",
    rootSessionId: ids("session"),
    tasks: [task("survey", { state: "done", mode: "read", sessionId: ids("session"), startedAt: NOW - 5 * MIN, endedAt: NOW - 5 * MIN + 34_000 })],
    rounds: 0,
    repairs: 0,
    startedAt: NOW - 12 * MIN,
    updatedAt: NOW - 1000,
    ...over,
  }
}

type TaskSpec = { state?: WorkflowTaskState; needs?: string[]; over?: Partial<WorkflowTaskSummary> }
function tasksOf(specs: Array<[string, TaskSpec]>): WorkflowTaskSummary[] {
  return specs.map(([id, spec]) =>
    task(id, { state: spec.state ?? "pending", needs: spec.needs ?? [], ...(spec.state && spec.state !== "pending" ? { sessionId: ids("session"), startedAt: NOW - 4 * MIN } : {}), ...(spec.over ?? {}) }),
  )
}

/** survey (step 1) → impl-api, impl-ui (step 2) → tests (step 3). */
const graph = () =>
  tasksOf([
    ["survey", { state: "done", over: { mode: "read", endedAt: NOW - 4 * MIN + 34_000, modelId: "gpt-6-luna", engine: "codex" } }],
    ["impl-api", { state: "running", needs: ["survey"], over: { latest: "edit src/a.ts", startedAt: NOW - 4 * MIN - 10_000, modelId: "claude-sonnet", engine: "claude" } }],
    ["impl-ui", { state: "needs_input", needs: ["survey"] }],
    ["tests", { state: "pending", needs: ["impl-api", "impl-ui"], over: { kind: "check", mode: undefined } }],
  ])

const contract = { criteria: 4, checks: 2, audit: "independent" as const, maxRepairs: 2, maxAudits: 2 }

const sample: WorkflowSummary[] = [
  workflow({ name: "api rewrite", state: "needs_input", tasks: graph(), contract, maxConcurrent: 2 }),
  workflow({ name: "docs sweep", state: "running", tasks: tasksOf([["a", { state: "running" }], ["b", { needs: ["a"] }]]) }),
  workflow({ name: "audit deps", state: "completed", tasks: tasksOf([["a", { state: "done" }], ["b", { state: "done", needs: ["a"] }]]), endedAt: NOW - 20 * MIN, startedAt: NOW - 20 * MIN - 41_000 }),
  workflow({ name: "broken", state: "blocked", reason: "contract still failing after 2 repairs", contract, tasks: tasksOf([["a", { state: "done" }]]) }),
  workflow({ name: "flaky", state: "failed", tasks: tasksOf([["a", { state: "failed", over: { reason: "exit 2" } }], ["b", { state: "skipped", needs: ["a"] }]]) }),
  workflow({ name: "later", state: "paused", tasks: tasksOf([["a", { state: "pending" }]]) }),
  workflow({ name: "old", state: "stopped", tasks: tasksOf([["a", { state: "stopped" }]]) }),
]

const text = (line: Line) => line.map((span) => span.text).join("")
const screen = (lines: Line[]) => lines.map(text).join("\n")
const render = (runs: WorkflowSummary[], state: WorkflowsPageState, width = 140, height = 40) => renderWorkflowsPage({ runs, state, width, height, now: NOW })
const start = createWorkflowsPageState()
const byName = (name: string, runs = sample) => runs.find((run) => run.name === name)!
/** The list with the cursor on a run, or (`run: true`) that run opened. */
const at = (name: string, extra: Partial<WorkflowsPageState> = {}, runs = sample): WorkflowsPageState => ({ scope: "project", focus: "list", row: `r:${byName(name, runs).workflowId}`, ...extra })
const inside = (name: string, extra: Partial<WorkflowsPageState> = {}, runs = sample) => at(name, { focus: "run", ...extra }, runs)
const press = (state: WorkflowsPageState, keys: string[], runs = sample) => keys.reduce((current, key) => workflowsPageKey(current, key, runs).state, state)

describe("levels", () => {
  test("a task is one level above the highest task it needs, 1 without needs", () => {
    expect(Object.fromEntries(workflowLevels(graph()))).toEqual({ survey: 1, "impl-api": 2, "impl-ui": 2, tests: 3 })
  })

  test("unknown needs and cycles do not throw", () => {
    const levels = workflowLevels([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }, { id: "c", needs: ["zzz"] }])
    expect(levels.get("c")).toBe(1)
    expect(levels.size).toBe(3)
  })

  test("display order is by level, plan order within a level", () => {
    expect(workflowTaskOrder({ tasks: graph().reverse() }).map((entry) => entry.task.id)).toEqual(["survey", "impl-ui", "impl-api", "tests"])
  })
})

describe("the page frame", () => {
  test.each([[60, 20], [90, 24], [109, 30], [110, 30], [140, 40], [169, 40], [170, 50], [220, 60], [50, 6], [60, 1]])("returns exactly height lines within width at %ix%i, on every run, listed and opened", (width, height) => {
    for (const run of sample) for (const state of [at(run.name), inside(run.name), inside(run.name, { info: true }), at(run.name, { keys: true })]) {
      const lines = render(sample, state, width, height)
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
  })

  test("the keys sit on the title row, right, and none at the bottom; the tabs name the scopes with the count", () => {
    const lines = render(sample, start, 140, 30)
    expect(text(lines[1]!)).toMatch(/Workflows · this project .*enter open.*\? keys · esc back/)
    expect(text(lines[2]!)).toContain("1 This project 7")
    expect(text(lines[2]!)).toContain("2 All projects")
    expect(lines.slice(-3).map(text).join("")).not.toMatch(/esc|enter/)
  })

  test("the keys follow what the cursor is on: a run waiting for the user offers approve and reject", () => {
    const run = workflow({ state: "needs_input", tasks: tasksOf([["gate", { state: "needs_input", over: { kind: "human", mode: undefined } }]]) })
    expect(text(render([run], inside("api rewrite", {}, [run]))[1]!)).toMatch(/y approve · n reject · .*esc list/)
    expect(text(render([sample[4]!], inside("flaky"))[1]!)).toMatch(/t retry/)
  })

  test("? lists every key as the first rows of the body", () => {
    const out = screen(render(sample, { ...start, keys: true }))
    for (const key of ["pause · resume", "approve · reject", "evidence", "fold · checks"]) expect(out).toContain(key)
    expect(workflowsPageKey(start, "?", sample).state.keys).toBe(true)
    expect(workflowsPageKey({ ...start, keys: true }, "\x1b", sample)).toEqual({ state: { ...start, keys: false }, action: { type: "none" } })
  })

  test("below 110 columns the list fills the page and enter shows the run alone; from 110 the run sits beside the list; from 170 its facts too", () => {
    const narrow = screen(render(sample, at("api rewrite"), 100))
    expect(narrow).toContain("docs sweep")
    expect(narrow).not.toContain("impl-api")
    const opened = screen(render(sample, inside("api rewrite"), 100))
    expect(opened).toContain("impl-api")
    expect(opened).not.toContain("docs sweep")
    const wide = screen(render(sample, at("api rewrite"), 140))
    expect(wide).toContain("docs sweep")
    expect(wide).toContain("impl-api")
    expect(wide).not.toContain("Models")
    expect(screen(render(sample, at("api rewrite"), 200, 50))).toMatch(/Models[\s\S]*claude-sonnet +claude · 1 agent/)
  })

  test("a confirmation replaces the keys with the question", () => {
    const state = workflowsPageKey(at("docs sweep"), "x", sample).state
    expect(text(render(sample, state)[1]!)).toContain('stop "docs sweep"? x/y confirm')
  })

  test("empty: the commands that start a run", () => {
    const out = screen(render([], start))
    expect(out).toContain("No workflows in this project")
    expect(out).toContain("/workflows run <file.js> --yes")
  })
})

describe("the list", () => {
  test("rows say where a run is or how it ended instead of a count; live runs come first", () => {
    const out = screen(render(sample, start, 100))
    expect(out).toMatch(/api rewrite +Step 2 2\/3/)
    expect(out).toMatch(/audit deps +done/)
    expect(out).toMatch(/later +paused/)
    expect(out.indexOf("later")).toBeLessThan(out.indexOf("audit deps"))
  })

  test("runs about the same item are one group; the live group is open, a finished one is closed until space", () => {
    const item = (over: Partial<WorkflowSummary>) => workflow({ subject: "cu-vault-probe", name: "mend", ...over })
    const runs = [
      item({ state: "running", startedAt: NOW - MIN, tasks: graph() }),
      item({ state: "completed", startedAt: NOW - 30 * MIN }),
      workflow({ subject: "cu-other", name: "mend", state: "completed", startedAt: NOW - 50 * MIN, updatedAt: NOW - 40 * MIN }),
      workflow({ subject: "cu-other", name: "mend", state: "failed", startedAt: NOW - 60 * MIN, updatedAt: NOW - 50 * MIN }),
    ]
    const out = screen(render(runs, start, 100))
    expect(out).toMatch(/● cu-vault-probe +Step 2 2\/3/)
    expect(out.match(/  ✓ mend +done/g)?.length).toBe(1)
    expect(out).toMatch(/✓ cu-other +done .*2 runs/)
    const groupRow = { ...start, row: `g:/Users/dev/Code/app\0s:cu-other` }
    expect(screen(render(runs, workflowsPageKey(groupRow, " ", runs).state, 100)).match(/  ✗ mend/g)?.length).toBe(1)
  })

  test("runs of one name started together are a batch, `name ×N`, with how many failed", () => {
    const review = (model: string, state: WorkflowSummary["state"]) => workflow({ name: "mend-council", subject: "patch", state, startedAt: NOW - 10 * MIN, tasks: [task("r", { label: `review ${model}`, state: state === "failed" ? "failed" : "done", modelId: model })] })
    const runs = [review("claude-opus", "completed"), review("gpt-6-astra", "failed"), workflow({ name: "mend", subject: "patch", state: "completed", startedAt: NOW - 30 * MIN })]
    const out = screen(render(runs, { ...start, row: `g:/Users/dev/Code/app\0s:patch`, opened: [`g:/Users/dev/Code/app\0s:patch`] }, 140))
    expect(out).toMatch(/✗ mend-council ×2 +1 of 2 fail/)
    const batch = screen(render(runs, { ...start, row: `b:${runs[0]!.workflowId}`, opened: [`g:/Users/dev/Code/app\0s:patch`] }, 140))
    expect(batch).toMatch(/review claude-opus +claude-opus/)
    expect(batch).toMatch(/review gpt-6-astra +gpt-6-astra/)
  })

  test("the all-projects scope heads each folder with its run count", () => {
    const runs = [workflow({ directory: "/w/one" }), workflow({ directory: "/w/two" }), workflow({ directory: "/w/two" })]
    const out = screen(render(runs, createWorkflowsPageState("all"), 100))
    expect(out).toContain("one · 1")
    expect(out).toContain("two · 2")
  })

  test("the cursor moves over rows by key, skips headings and stays when runs arrive", () => {
    const moved = press(start, ["\x1b[B", "\x1b[B"])
    expect(selectedWorkflow(moved, sample)?.name).toBe("broken")
    expect(selectedWorkflow(moved, [workflow({ name: "new one" }), ...sample])?.name).toBe("broken")
    expect(press(start, ["\x1b[A"]).row).toBeUndefined()
    // The oldest finished run is the last row.
    expect(press(at("audit deps"), ["\x1b[B"])).toEqual(at("audit deps"))
  })

  test("many runs scroll so the cursor stays in sight", () => {
    const runs = Array.from({ length: 60 }, (_, index) => workflow({ name: `run ${index}`, state: "completed", updatedAt: NOW - index * 1000 }))
    expect(screen(render(runs, at("run 50", {}, runs), 100, 20))).toContain("❯ ✓ run 50")
  })
})

describe("one run", () => {
  test("the header names the run and its state; the phases read as a stepper and a timeline with each step's model", () => {
    const out = screen(render(sample, inside("api rewrite"), 140))
    expect(out).toMatch(/\? api rewrite .*needs input · 12m/)
    expect(out).toContain("✓ Step 1 ── ")
    expect(out).toContain("phase 2 of 3")
    expect(out).toMatch(/│ ✓ survey +gpt-6-luna · codex +34s/)
    expect(out).toMatch(/│ ● impl-api +claude-sonnet · claude +4m 10s/)
    expect(out).toContain("▸ edit src/a.ts")
  })

  test("a failed step shows why and the notice names it with the retry key", () => {
    const out = screen(render(sample, inside("flaky"), 140))
    expect(out).toContain("Stopped in Step 1: a failed · t retry")
    expect(out).toMatch(/│ ✗ a[\s\S]*│ +exit 2/)
  })

  test("a step waiting out its retry backoff shows why", () => {
    const run = workflow({ tasks: tasksOf([["a", { state: "pending", over: { attempt: 1, reason: "retrying after transient failure: the turn failed" } }]]) })
    expect(screen(render([run], inside("api rewrite", {}, [run])))).toContain("retrying after transient failure")
  })

  test("a retried step shows its attempt", () => {
    const run = workflow({ tasks: [task("a", { state: "running", attempt: 2, modelId: "m1", startedAt: NOW - MIN })] })
    expect(screen(render([run], inside("api rewrite", {}, [run])))).toContain("attempt 2")
  })

  test("the cursor step is highlighted; with none chosen it stands on what waits, then what runs", () => {
    expect(screen(render(sample, inside("docs sweep"), 140))).toMatch(/❯ │ ● a/)
    expect(screen(render(sample, inside("api rewrite", { step: "t:survey" }), 140))).toMatch(/❯ │ ✓ survey/)
  })

  test("i shows the identity and limits in place of the timeline", () => {
    const out = screen(render(sample, inside("api rewrite", { info: true }), 140))
    expect(out).toMatch(/Identity[\s\S]*plan hash/)
    expect(out).toMatch(/Limits[\s\S]*contract +2 checks · independent audit · 4 criteria/)
    expect(out).not.toContain("▸ edit src/a.ts")
    expect(workflowsPageKey(inside("api rewrite"), "i", sample).state.info).toBe(true)
  })
})

describe("verification", () => {
  const run = (over: Partial<WorkflowSummary> = {}) => workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification: verificationRound(), ...over })
  const view = (one: WorkflowSummary) => screen(render([one], inside("api rewrite", {}, [one]), 140, 60))

  test("no contract draws no block; a contract not started says round 0", () => {
    expect(view(workflow())).not.toContain("Verify")
    expect(view(workflow({ contract }))).toContain("round 0 — not started")
  })

  test("an audit that did not finish says so and names the keys to continue", () => {
    const out = view(workflow({ state: "blocked", contract, rounds: 0, reason: "audit stalled" }))
    expect(out).toContain("round 1 — did not finish")
    expect(out).toContain("v verify again · b evidence · a accept")
  })

  test("the block lists checks, the audit and per-criterion rows", () => {
    const out = view(run())
    expect(out).toContain("round 1 — rejected")
    expect(out).toContain("✓ bun test")
    expect(out).toMatch(/✗ tsc -b +exit 2/)
    expect(out).toContain("audit fail")
    expect(out).toMatch(/✗ docs +README does not mention the flag/)
    expect(out).toContain("! 1 unverified")
    expect(out).toContain("docs missing")
  })

  test("a void audit says the workspace changed; an accepted round reads accepted; a hand acceptance shows the reason", () => {
    expect(view(run({ verification: verificationRound({ workspaceChanged: true, verdict: "pass" }) }))).toContain("void: workspace changed")
    expect(view(run({ state: "completed", verification: verificationRound({ accepted: true, verdict: "pass" }) }))).toContain("round 1 — accepted")
    expect(view(run({ state: "completed", override: { reason: "flaky gate", at: NOW } }))).toContain("accepted by you  flaky gate")
  })
})

describe("needsTick", () => {
  test("only while a run has a live clock", () => {
    expect(needsTick([byName("docs sweep")])).toBe(true)
    expect(needsTick([byName("later"), byName("audit deps")])).toBe(false)
  })
})

describe("workflowsPageKey", () => {
  test("enter opens a run, esc and ← go back to the list, esc on the list and q close", () => {
    expect(workflowsPageKey(at("docs sweep"), "\r", sample).state.focus).toBe("run")
    expect(workflowsPageKey(inside("docs sweep"), "\x1b", sample).state.focus).toBe("list")
    expect(workflowsPageKey(inside("docs sweep"), "\x1b[D", sample).state.focus).toBe("list")
    expect(workflowsPageKey(at("docs sweep"), "\x1b", sample).action).toEqual({ type: "close" })
    expect(workflowsPageKey(inside("docs sweep"), "q", sample).action).toEqual({ type: "close" })
    expect(workflowsPageKey(start, "\r", []).action).toEqual({ type: "none" })
  })

  test("in a run ↑↓ move over phases and steps; enter opens the step's session, else the latest step's", () => {
    const run = byName("api rewrite")
    expect(press(inside("api rewrite"), ["\x1b[A"]).step).toBe("t:impl-api")
    expect(press(inside("api rewrite", { step: "t:survey" }), ["\x1b[B"]).step).toBe("p:2")
    expect(workflowsPageKey(inside("api rewrite", { step: "t:survey" }), "\r", sample).action).toEqual({ type: "open", sessionId: run.tasks[0]!.sessionId! })
    expect(workflowsPageKey(inside("api rewrite"), "\r", sample).action).toEqual({ type: "open", sessionId: run.tasks[2]!.sessionId! })
    const bare = workflow({ tasks: [task("a")] })
    expect(workflowsPageKey(inside("api rewrite", {}, [bare]), "\r", [bare]).action).toEqual({ type: "open", sessionId: bare.rootSessionId })
  })

  test("enter on the verification block opens the auditor session", () => {
    const verification = verificationRound()
    const run = workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification })
    expect(workflowsPageKey(inside("api rewrite", { step: "v" }, [run]), "\r", [run]).action).toEqual({ type: "open", sessionId: verification.audit!.sessionId })
  })

  test("space on a phase with checks lists them grouped by label", () => {
    const run = workflow({ script: scriptOf(), tasks: [
      task("c1", { kind: "check", label: "bun test", phase: "Checks", state: "done", startedAt: NOW - MIN, endedAt: NOW - MIN + 2000 }),
      task("c2", { kind: "check", label: "bun test", phase: "Checks", state: "done", startedAt: NOW - MIN, endedAt: NOW - MIN + 3000 }),
      task("a1", { label: "audit", phase: "Audit", state: "running", modelId: "claude-opus", startedAt: NOW - MIN }),
    ] })
    const opened = workflowsPageKey(inside("api rewrite", { step: "p:Checks" }, [run]), " ", [run]).state
    expect(screen(render([run], inside("api rewrite", { step: "p:Checks" }, [run]), 140))).not.toMatch(/2 × bun test/)
    expect(screen(render([run], opened, 140))).toMatch(/✓  2 × bun test +5s/)
  })

  test("p pauses running, waiting and verifying runs and resumes paused and blocked ones", () => {
    const control = (name: string) => workflowsPageKey(at(name), "p", sample).action
    expect(control("docs sweep")).toEqual({ type: "control", workflowId: byName("docs sweep").workflowId, action: "pause" })
    expect(control("api rewrite")).toMatchObject({ action: "pause" })
    expect(control("later")).toMatchObject({ action: "resume" })
    expect(control("broken")).toMatchObject({ action: "resume" })
    expect(control("audit deps")).toEqual({ type: "none" })
  })

  test("actions need a run's own row: a group acts only once opened", () => {
    const runs = [workflow({ subject: "x", state: "running" }), workflow({ subject: "x", state: "completed", startedAt: NOW - 30 * MIN })]
    expect(workflowsPageKey({ ...start, row: `g:/Users/dev/Code/app\0s:x` }, "p", runs).action).toEqual({ type: "none" })
  })

  test("v verifies a blocked run with a contract; a asks for a reason when acceptance makes sense", () => {
    expect(workflowsPageKey(at("broken"), "v", sample).action).toMatchObject({ action: "verify" })
    expect(workflowsPageKey(at("docs sweep"), "v", sample).action).toEqual({ type: "none" })
    expect(workflowsPageKey(at("broken"), "a", sample).action).toEqual({ type: "accept", workflowId: byName("broken").workflowId })
    expect(workflowsPageKey(at("docs sweep"), "a", sample).action).toEqual({ type: "none" })
  })

  test("t retries the cursor's failed step, or the first failed one", () => {
    expect(workflowsPageKey(at("flaky"), "t", sample).action).toEqual({ type: "retry", workflowId: byName("flaky").workflowId, taskId: "a" })
    expect(workflowsPageKey(at("docs sweep"), "t", sample).action).toEqual({ type: "none" })
  })

  test("y and n answer the human step that waits", () => {
    const run = workflow({ state: "needs_input", tasks: tasksOf([["a", { state: "done" }], ["gate", { state: "needs_input", needs: ["a"], over: { kind: "human", mode: undefined, latest: "Approve the release" } }]]) })
    expect(workflowsPageKey(at("api rewrite", {}, [run]), "y", [run]).action).toEqual({ type: "answer", workflowId: run.workflowId, taskId: "gate", decision: "approve" })
    expect(workflowsPageKey(at("api rewrite", {}, [run]), "n", [run]).action).toEqual({ type: "answer", workflowId: run.workflowId, taskId: "gate", decision: "reject" })
    const out = screen(render([run], inside("api rewrite", {}, [run]), 140))
    expect(out).toContain("Waiting for you: gate · y approve · n reject")
    expect(out).toContain("Approve the release")
  })

  test("x and d ask first; the same key or y confirms, any other key cancels; finished runs cannot stop", () => {
    const stopping = workflowsPageKey(at("docs sweep"), "x", sample).state
    expect(stopping.confirm).toEqual({ kind: "stop", workflowId: byName("docs sweep").workflowId })
    expect(workflowsPageKey(stopping, "y", sample).action).toMatchObject({ action: "stop" })
    expect(workflowsPageKey(stopping, "z", sample)).toEqual({ state: at("docs sweep"), action: { type: "none" } })
    const deleting = workflowsPageKey(at("old"), "d", sample).state
    expect(workflowsPageKey(deleting, "d", sample).action).toMatchObject({ action: "delete" })
    expect(workflowsPageKey(at("old"), "x", sample).state.confirm).toBeUndefined()
  })

  test("tab and 1/2 change the scope, reset the cursor and report it", () => {
    expect(workflowsPageKey(at("docs sweep"), "\t", sample)).toEqual({ state: createWorkflowsPageState("all"), action: { type: "scope", scope: "all" } })
    expect(workflowsPageKey(start, "1", sample).state).toBe(start)
  })

  test("a run opened from elsewhere starts on its run view, its group opened", () => {
    const runs = [workflow({ subject: "x", state: "completed" }), workflow({ subject: "x", state: "completed", startedAt: NOW - 30 * MIN })]
    const state = createWorkflowsPageState("all", runs[1]!.workflowId)
    expect(selectedWorkflow(state, runs)).toBe(runs[1])
    expect(screen(render(runs, state, 140))).toMatch(/❯ +✓ api rewrite/)
  })

  test("unknown keys change nothing", () => {
    const result = workflowsPageKey(start, "z", sample)
    expect(result.state).toBe(start)
    expect(result.action).toEqual({ type: "none" })
  })
})

function scriptOf(): NonNullable<WorkflowSummary["script"]> {
  return {
    hash: "ab".repeat(32), origin: "file", host: "running", calls: 3,
    phases: [{ title: "Checks", state: "done", completed: 2, total: 2 }, { title: "Audit", state: "running", completed: 0, total: 1 }],
    budget: { agents: 16 }, usage: { agents: 1, tokens: 0 }, counts: { pending: 0, running: 1, done: 2, failed: 0 }, omitted: 0, logs: [],
  }
}

/** One rejected round: a passing and a failing check, a failing audit with three judged criteria, and one criterion nobody verified. */
function verificationRound(over: { evidence?: string; workspaceChanged?: boolean; verdict?: "pass" | "fail"; accepted?: boolean } = {}): WorkflowVerification {
  return {
    round: 1,
    at: NOW - MIN,
    gates: [{ id: "bun test", status: "pass" }, { id: "tsc -b", status: "fail", detail: "exit 2" }],
    audit: {
      verdict: over.verdict ?? "fail",
      sessionId: ids("session"),
      inspections: 4,
      ...(over.workspaceChanged ? { workspaceChanged: true } : {}),
      findings: "docs missing",
      criteria: [
        { id: "builds", status: "pass", evidence: over.evidence ?? "compiles cleanly" },
        { id: "docs", status: "fail", evidence: "README does not mention the flag" },
        { id: "perf", status: "unsure", evidence: "could not measure" },
      ],
    },
    criteria: [
      { id: "builds", status: "pass", by: "audit" },
      { id: "docs", status: "fail", by: "audit" },
      { id: "perf", status: "unsure", by: "audit" },
      { id: "lint", status: "unverified", by: "none" },
    ],
    accepted: over.accepted ?? false,
  }
}
