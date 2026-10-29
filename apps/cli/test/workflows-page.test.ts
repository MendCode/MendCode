import { describe, expect, test } from "bun:test"
import { createIdFactory, type WorkflowSummary, type WorkflowTaskState, type WorkflowTaskSummary, type WorkflowVerification } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createWorkflowsPageState, needsTick, renderWorkflowsPage, workflowLevels, workflowsPageKey, workflowTaskOrder, type WorkflowsPageState } from "../src/view/workflows-page"
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

function tasksOf(specs: Array<[string, TaskSpec]>): WorkflowTaskSummary[] {
  return specs.map(([id, spec]) =>
    task(id, { state: spec.state ?? "pending", needs: spec.needs ?? [], ...(spec.state && spec.state !== "pending" ? { sessionId: ids("session"), startedAt: NOW - 4 * MIN } : {}), ...(spec.over ?? {}) }),
  )
}
type TaskSpec = { state?: WorkflowTaskState; needs?: string[]; over?: Partial<WorkflowTaskSummary> }

/** survey (L1) → impl-api, impl-ui (L2) → tests (L3), the mock of the spec. */
const graph = () =>
  tasksOf([
    ["survey", { state: "done", over: { mode: "read", endedAt: NOW - 4 * MIN + 34_000 } }],
    ["impl-api", { state: "running", needs: ["survey"], over: { latest: "edit src/a.ts", startedAt: NOW - 4 * MIN - 10_000 } }],
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
const plain = (lines: Line[]) => lines.map((line) => text(line).replaceAll("│", ""))
const render = (runs: WorkflowSummary[], state: WorkflowsPageState, width = 140, height = 40) => renderWorkflowsPage({ runs, state, width, height, now: NOW })
const titleRow = (lines: Line[]) => lines[1]!
const start = createWorkflowsPageState()
const byName = (name: string) => sample.find((run) => run.name === name)!
const on = (name: string, key: string, extra: Partial<WorkflowsPageState> = {}) => workflowsPageKey({ selected: sample.indexOf(byName(name)), scope: "project", ...extra }, key, sample)

describe("levels", () => {
  test("a task is one level above the highest task it needs, 1 without needs", () => {
    const levels = workflowLevels(graph())
    expect([...levels]).toEqual([["survey", 1], ["impl-api", 2], ["impl-ui", 2], ["tests", 3]])
  })
  test("a long chain and a diamond", () => {
    const levels = workflowLevels([
      { id: "d", needs: ["b", "c"] },
      { id: "c", needs: ["a"] },
      { id: "b", needs: ["a"] },
      { id: "a", needs: [] },
      { id: "e", needs: ["d"] },
    ])
    expect(Object.fromEntries(levels)).toEqual({ a: 1, b: 2, c: 2, d: 3, e: 4 })
  })
  test("unknown needs and cycles do not throw", () => {
    expect(workflowLevels([{ id: "a", needs: ["ghost"] }]).get("a")).toBe(1)
    const cyclic = workflowLevels([{ id: "a", needs: ["b"] }, { id: "b", needs: ["a"] }])
    expect(cyclic.size).toBe(2)
  })
  test("display order is by level, plan order within a level", () => {
    const shuffled = [...graph()].reverse()
    expect(workflowTaskOrder({ tasks: shuffled }).map((entry) => entry.task.id)).toEqual(["survey", "impl-ui", "impl-api", "tests"])
  })
})

describe("renderWorkflowsPage", () => {
  test.each([
    [60, 20],
    [90, 24],
    [90, 40],
    [119, 30],
    [120, 30],
    [140, 40],
    [160, 50],
    [50, 6],
    [60, 1],
  ])("returns exactly height lines within width at %ix%i", (width, height) => {
    for (let selected = 0; selected < sample.length; selected++) {
      const lines = render(sample, { selected, scope: "project" }, width, height)
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
  })

  test("fills exactly the width in every layout, with the confirm row and the cursor on every slot", () => {
    const withVerification = workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification: verificationRound() })
    for (const [width, height] of [[60, 20], [90, 24], [140, 40]] as const) {
      for (const task of [undefined, 0, 2, 4]) {
        const state: WorkflowsPageState = { selected: 0, scope: "project", ...(task === undefined ? {} : { task }), confirm: { kind: "stop", workflowId: withVerification.workflowId } }
        const lines = render([withVerification], state, width, height)
        expect(lines).toHaveLength(height)
        for (const line of lines) expect(textWidth(text(line))).toBe(width)
      }
    }
  })

  test("many tasks and many runs stay within the frame", () => {
    const wide = Array.from({ length: 32 }, (_, i) => task(`task-${i}`, { needs: i ? [`task-${i - 1}`] : [], state: "pending" }))
    const runs = Array.from({ length: 40 }, (_, i) => workflow({ name: `run-${i}`, tasks: wide, contract, verification: verificationRound() }))
    for (const [width, height] of [[60, 20], [100, 30], [140, 40]] as const) {
      const lines = render(runs, { selected: 25, scope: "project", task: 20 }, width, height)
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
  })

  test("the title is 'Workflows · scope' with counts computed from the runs shown", () => {
    const title = text(titleRow(render(sample, start))).trim()
    expect(title).toStartWith("Workflows · this project")
    expect(title).toContain("1 blocked · 1 failed · 1 needs input")
    expect(text(titleRow(render(sample.slice(2, 3), start))).trim()).toContain("1 completed")
    expect(text(titleRow(render(sample.slice(2, 3), start))).trim()).not.toContain("needs input")
    expect(text(titleRow(render(sample, { selected: 0, scope: "all" })))).toContain("Workflows · all projects")
  })

  test("header status: Confirm, then Blocked, then Needs input, then Live", () => {
    const status = (runs: WorkflowSummary[], state: WorkflowsPageState = start) => titleRow(render(runs, state))
    const confirm = status(sample, { selected: 0, scope: "project", confirm: { kind: "delete", workflowId: sample[0]!.workflowId } })
    expect(confirm.find((span) => span.text === "Confirm")).toMatchObject({ fg: "warning", bold: true })
    expect(confirm.find((span) => span.text === "Blocked")).toBeUndefined()
    expect(status(sample).find((span) => span.text === "Blocked")).toMatchObject({ fg: "error", bold: true })
    const noBlocked = sample.filter((run) => run.state !== "blocked")
    expect(status(noBlocked).find((span) => span.text === "Needs input")).toMatchObject({ fg: "warning", bold: true })
    const live = sample.filter((run) => run.state === "running" || run.state === "completed")
    const calm = text(status(live))
    expect(calm).not.toContain("Blocked")
    expect(calm).not.toContain("Needs input")
    expect(calm).toContain("1 running")
  })

  test("hints live in one header row with every key at wide sizes", () => {
    const rows = plain(render(sample, start))
    const keys = rows[0]!
    expect(keys).toContain("esc back")
    expect(rows.slice(1).join("\n")).not.toContain("esc back")
    for (const hint of ["↑↓ run", "←→ task", "enter open", "p pause/resume", "x stop", "t retry", "v verify", "a accept", "d delete", "tab scope"]) expect(keys).toContain(hint)
  })

  test("list rows show state, done/total and elapsed; verifying reads 'in review'", () => {
    const rows = plain(render(sample, start))
    const row = (name: string) => rows.find((line) => line.includes(name))!
    expect(row("api rewrite")).toContain("needs input")
    expect(row("api rewrite")).toContain("1/4")
    expect(row("api rewrite")).toContain("12m 0s")
    expect(row("docs sweep")).toContain("running")
    expect(row("audit deps")).toContain("completed")
    expect(row("audit deps")).toContain("2/2")
    expect(row("audit deps")).toContain("41s")
    const reviewing = plain(render([workflow({ name: "checking", state: "verifying", contract })], start)).find((line) => line.includes("checking"))!
    expect(reviewing).toContain("in review")
    expect(reviewing).toContain("verifying")
  })

  test("each run state has its label and color", () => {
    const spans = render(sample, start).flat()
    const badge = (label: string) => spans.find((span) => span.text.trim() === label)
    expect(badge("needs input")).toMatchObject({ fg: "warning" })
    expect(badge("• running")).toMatchObject({ fg: "text" })
    expect(badge("completed")).toMatchObject({ fg: "success" })
    expect(badge("blocked")).toMatchObject({ fg: "error" })
    expect(badge("failed")).toMatchObject({ fg: "error" })
    expect(badge("paused")).toMatchObject({ fg: "muted" })
    expect(badge("stopped")).toMatchObject({ fg: "muted" })
  })

  test("narrow rows drop columns from the right but keep name and state", () => {
    const row = plain(render(sample, start, 44, 30)).find((line) => line.includes("api rewrite"))!
    expect(row).toContain("needs input")
    expect(row).toContain("1/4")
    expect(row).not.toContain("12m")
    const narrower = plain(render(sample, start, 34, 30)).find((line) => line.includes("api rewrite"))!
    expect(narrower).toContain("needs input")
    expect(narrower).not.toContain("1/4")
  })

  test("only the selected row has the pointer", () => {
    const rows = plain(render(sample, { selected: 3, scope: "project" }, 100, 40))
    const pointers = rows.filter((line) => line.trimStart().startsWith("❯"))
    expect(pointers).toHaveLength(1)
    expect(pointers[0]).toContain("broken")
  })

  test("selection scrolls the list and stays visible", () => {
    const many = Array.from({ length: 30 }, (_, i) => workflow({ name: `flow-${i}` }))
    for (const width of [100, 140]) {
      const rows = plain(render(many, { selected: 25, scope: "project" }, width, 30))
      const pointers = rows.filter((line) => line.includes("❯"))
      expect(pointers).toHaveLength(1)
      expect(pointers[0]).toContain("flow-25")
    }
  })

  test("wide layout has Workflows and Detail sections side by side; narrow stacks them", () => {
    const wide = plain(render(sample, start, 140, 40))
    const titles = wide.find((line) => line.includes("Detail"))!
    expect(titles).toContain("Workflows")
    expect(titles.indexOf("Workflows")).toBeLessThan(titles.indexOf("Detail"))
    expect(wide.join("\n")).toMatch(/[┌┐└┘]/)
    const stacked = plain(render(sample, start, 100, 40)).join("\n")
    expect(stacked).toContain("Detail")
    expect(stacked).toContain("objective")
    // The wide breakpoint is 110 columns of terminal width (ui/breakpoints.ts), no longer 120 columns of inner width.
    expect(plain(render(sample, start, 110, 40)).join("\n")).toContain("Detail")
    expect(plain(render(sample, start, 109, 40)).find((line) => line.includes("Detail"))).not.toContain("Workflows")
  })

  test("detail shows directory, objective, contract, perms and the tasks by level", () => {
    const out = plain(render(sample, start, 140, 40)).join("\n")
    expect(out).toContain("/Users/dev/Code/app")
    expect(out).toContain("objective  Rewrite the API layer")
    expect(out).toContain("contract   2 checks · independent audit · 4 criteria")
    expect(out).toContain("perms      edits · concurrency 2 · repairs 0/2")
    expect(out).toMatch(/L1 +✓ survey +read +34s/)
    expect(out).toMatch(/L2 +• impl-api +work +4m 10s +▸ edit src\/a\.ts/)
    expect(out).toMatch(/\? impl-ui +work +4m 0s +needs input/)
    expect(out).toMatch(/L3 +· tests +check +waits impl-api, impl-ui/)
  })

  test("a level label shows once per level", () => {
    const out = plain(render(sample, start, 140, 40)).join("\n")
    expect(out.match(/L2/g)).toHaveLength(1)
    expect(out.match(/L1/g)).toHaveLength(1)
  })

  test("task glyphs and colors per state", () => {
    const run = workflow({
      state: "failed",
      tasks: tasksOf([
        ["ok", { state: "done" }],
        ["run", { state: "running" }],
        ["ask", { state: "needs_input" }],
        ["bad", { state: "failed", over: { reason: "exit 1" } }],
        ["skip", { state: "skipped", needs: ["bad"], over: { reason: "needs bad" } }],
        ["halt", { state: "stopped" }],
        ["wait", { state: "pending", needs: ["ok"] }],
      ]),
    })
    const lines = render([run], start, 140, 40)
    const glyphOf = (id: string) => {
      const row = lines.slice(4).find((line) => text(line).includes(` ${id} `))!
      const index = row.findIndex((span) => span.text.trim() === id)
      return row[index - 2]!
    }
    expect(glyphOf("ok")).toMatchObject({ text: "✓", fg: "success" })
    expect(glyphOf("run")).toMatchObject({ text: "•", fg: "text" })
    expect(glyphOf("ask")).toMatchObject({ text: "?", fg: "warning" })
    expect(glyphOf("bad")).toMatchObject({ text: "✗", fg: "error" })
    expect(glyphOf("skip")).toMatchObject({ text: "–", fg: "muted" })
    expect(glyphOf("halt")).toMatchObject({ text: "–", fg: "muted" })
    expect(glyphOf("wait")).toMatchObject({ text: "·", fg: "muted" })
    const out = plain(lines).join("\n")
    expect(out).toContain("exit 1")
    expect(out).toContain("needs bad")
    expect(out).toContain("queued")
  })

  test("a retried task shows its attempt", () => {
    const run = workflow({ tasks: tasksOf([["a", { state: "done", over: { attempt: 3 } }]]) })
    expect(plain(render([run], start)).join("\n")).toContain("attempt 3")
  })

  test("the cursor task is highlighted; with no cursor the default target is", () => {
    const highlightedIds = (state: WorkflowsPageState) =>
      render([sample[0]!], state)
        .filter((line) => line.some((span) => span.bg === "element"))
        .map((line) => text(line).trim())
    expect(highlightedIds(start).join("|")).toContain("impl-ui")
    expect(highlightedIds({ selected: 0, scope: "project", task: 0 }).join("|")).toContain("survey")
    expect(highlightedIds({ selected: 0, scope: "project", task: 3 }).join("|")).toContain("impl-api")
  })

  test("no verification: 'none' without a contract, 'not started' with one", () => {
    expect(plain(render([sample[1]!], start)).join("\n")).toMatch(/verification +none/)
    expect(plain(render([sample[0]!], start)).join("\n")).toMatch(/verification +round 0 — not started/)
  })

  test("an audit that did not finish says so and names the keys to continue, not 'not started'", () => {
    const run = workflow({ state: "blocked", reason: "audit stalled: no activity for 10 min (3 attempts)", contract, tasks: graph(), rounds: 0 })
    const out = plain(render([run], start, 140, 50)).join("\n")
    expect(out).toMatch(/verification +round 1 — did not finish/)
    expect(out).toContain("v verify again · b evidence · a accept")
    expect(out).not.toContain("not started")
  })

  test("the verification block lists checks, the audit and per-criterion rows", () => {
    const run = workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification: verificationRound() })
    const out = plain(render([run], start, 140, 50)).join("\n")
    expect(out).toContain("round 1 — rejected")
    expect(out).toContain("✓ bun test")
    expect(out).toMatch(/✗ tsc -b +exit 2/)
    expect(out).toContain("audit fail")
    expect(out).toMatch(/✓ builds +compiles cleanly/)
    expect(out).toMatch(/✗ docs +README does not mention the flag/)
    expect(out).toMatch(/\? perf +could not measure/)
    expect(out).toContain("! 1 unverified")
    expect(out).toContain("rejected")
    expect(out).toContain("docs missing")
  })

  test("criterion evidence wraps to two lines and then ends with an ellipsis", () => {
    const long = verificationRound({ evidence: "word ".repeat(80) })
    const run = workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification: long })
    const rows = plain(render([run], start, 100, 60)).map((line) => line.trim())
    const at = rows.findIndex((line) => line.startsWith("✓ builds word"))
    expect(at).toBeGreaterThan(0)
    expect(rows[at + 1]).toContain("word")
    expect(rows[at + 1]).toContain("…")
    expect(rows[at + 2]).not.toContain("word")
  })

  test("a void audit says the workspace changed", () => {
    const run = workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification: verificationRound({ workspaceChanged: true, verdict: "pass" }) })
    const out = plain(render([run], start, 140, 50)).join("\n")
    expect(out).toContain("audit void: workspace changed")
    expect(out).not.toContain("audit pass")
    const spans = render([run], start, 140, 50).flat()
    expect(spans.find((span) => span.text === "void: workspace changed")).toMatchObject({ fg: "error" })
  })

  test("an accepted round reads accepted; a hand acceptance shows 'accepted by you' and the reason", () => {
    const accepted = workflow({ state: "completed", contract, tasks: graph(), rounds: 1, verification: verificationRound({ accepted: true, verdict: "pass" }) })
    expect(plain(render([accepted], start, 140, 50)).join("\n")).toContain("round 1 — accepted")
    const byHand = workflow({ state: "completed", contract, tasks: graph(), override: { reason: "checked by hand", at: NOW } })
    const out = plain(render([byHand], start, 140, 50))
    expect(out.some((line) => line.includes("accepted by you  checked by hand"))).toBe(true)
  })

  test("a verifying run shows the previous round while the next one runs, without 'rejected' feedback", () => {
    const run = workflow({ state: "verifying", contract, tasks: graph(), rounds: 1, verification: verificationRound() })
    const out = plain(render([run], start, 140, 50)).join("\n")
    expect(out).toContain("next round running")
    expect(out).not.toMatch(/^\s*rejected$/m)
  })

  test("the reason is shown, red when blocked", () => {
    const rows = render([byName("broken")], start, 140, 40)
    const reason = rows.find((line) => text(line).includes("contract still failing"))!
    expect(reason.find((span) => span.text.includes("contract still failing"))).toMatchObject({ fg: "error" })
  })

  test("the verification block keeps its rows when there are many tasks", () => {
    const wide = Array.from({ length: 32 }, (_, i) => task(`task-${i}`, { needs: i ? [`task-${i - 1}`] : [], state: "done" }))
    const run = workflow({ state: "blocked", contract, tasks: wide, rounds: 1, verification: verificationRound() })
    const out = plain(render([run], start, 140, 40)).join("\n")
    expect(out).toContain("round 1 — rejected")
    expect(out).toContain("audit fail")
  })

  test("a pending confirmation takes the list's first row", () => {
    const stop = plain(render(sample, { selected: 0, scope: "project", confirm: { kind: "stop", workflowId: sample[0]!.workflowId } }, 100, 40))
    expect(stop.some((line) => line.includes('stop "api rewrite"? x or y confirms · any key cancels'))).toBe(true)
    const wide = plain(render(sample, { selected: 0, scope: "project", confirm: { kind: "stop", workflowId: sample[0]!.workflowId } }, 140, 40))
    expect(wide.some((line) => line.includes("stop? x/y confirm"))).toBe(true)
    const del = plain(render(sample, { selected: 0, scope: "project", confirm: { kind: "delete", workflowId: sample[0]!.workflowId } }, 50, 20))
    expect(del.some((line) => line.includes("delete? d/y confirm"))).toBe(true)
  })

  test("empty state", () => {
    const rows = plain(render([], start, 100, 30))
    expect(rows.some((line) => line.includes("no workflows"))).toBe(true)
    expect(rows).toHaveLength(30)
    expect(text(titleRow(render([], start)))).toContain("no workflows")
  })

  test("elapsed time follows `now`", () => {
    const later = plain(renderWorkflowsPage({ runs: sample, state: start, width: 140, height: 40, now: NOW + 3 * MIN })).find((line) => line.includes("api rewrite"))!
    expect(later).toContain("15m 0s")
  })

  test("compact sizes drop the directory and perms rows", () => {
    const compact = plain(render(sample, start, 60, 20)).join("\n")
    expect(compact).not.toContain("perms")
    expect(compact).not.toContain("/Users/dev")
    expect(plain(render(sample, start, 90, 40)).join("\n")).toContain("perms")
  })
})

describe("needsTick", () => {
  test("only while a run has a live clock", () => {
    expect(needsTick([])).toBe(false)
    expect(needsTick(sample.filter((run) => run.state === "completed" || run.state === "paused" || run.state === "blocked"))).toBe(false)
    expect(needsTick([byName("docs sweep")])).toBe(true)
    expect(needsTick([workflow({ state: "verifying" })])).toBe(true)
  })
})

describe("workflowsPageKey", () => {
  const id = (name: string) => byName(name).workflowId

  test("up and down move the run selection with clamping and reset the task cursor", () => {
    expect(workflowsPageKey(start, "j", sample).state.selected).toBe(1)
    expect(workflowsPageKey(start, "\x1b[B", sample).state.selected).toBe(1)
    expect(workflowsPageKey(start, "k", sample).state).toBe(start)
    expect(workflowsPageKey({ ...start, selected: 6 }, "j", sample).state.selected).toBe(6)
    const moved = workflowsPageKey({ ...start, task: 2 }, "j", sample).state
    expect(moved).toEqual({ selected: 1, scope: "project" })
    expect("task" in moved).toBe(false)
    expect(workflowsPageKey({ ...start, selected: 1, task: 1 }, "\x10", sample).state).toEqual({ selected: 0, scope: "project" })
  })

  test("left and right move the task cursor from the default target and clamp", () => {
    // api rewrite: order survey, impl-api, impl-ui, tests; default target = impl-ui (needs_input, index 2)
    expect(workflowsPageKey(start, "\x1b[C", sample).state.task).toBe(3)
    expect(workflowsPageKey(start, "l", sample).state.task).toBe(3)
    expect(workflowsPageKey(start, "\x1b[D", sample).state.task).toBe(1)
    expect(workflowsPageKey(start, "h", sample).state.task).toBe(1)
    expect(workflowsPageKey({ ...start, task: 0 }, "\x1b[D", sample).state).toEqual({ selected: 0, scope: "project", task: 0 })
    expect(workflowsPageKey({ ...start, task: 3 }, "\x1b[C", sample).state.task).toBe(3)
  })

  test("with no default target right starts at the first task and left too", () => {
    const calm = [workflow({ state: "paused", tasks: tasksOf([["a", { state: "pending" }], ["b", { state: "pending", needs: ["a"] }]]) })]
    expect(workflowsPageKey(start, "l", calm).state.task).toBe(0)
    expect(workflowsPageKey(start, "h", calm).state.task).toBe(0)
  })

  test("the verification block is a cursor slot only when an auditor session exists", () => {
    const audited = [workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification: verificationRound() })]
    expect(workflowsPageKey({ ...start, task: 3 }, "l", audited).state.task).toBe(4)
    expect(workflowsPageKey({ ...start, task: 4 }, "l", audited).state.task).toBe(4)
    const bare = [workflow({ state: "blocked", contract, tasks: graph() })]
    expect(workflowsPageKey({ ...start, task: 3 }, "l", bare).state.task).toBe(3)
  })

  test("enter opens the default target: needs_input over running over failed", () => {
    const sessionOf = (run: WorkflowSummary, taskId: string) => run.tasks.find((t) => t.id === taskId)!.sessionId!
    const first = sample[0]!
    expect(workflowsPageKey(start, "\r", sample).action).toEqual({ type: "open", sessionId: sessionOf(first, "impl-ui") })
    const noInput = workflow({ tasks: [...graph().filter((t) => t.state !== "needs_input")] })
    expect(workflowsPageKey(start, "\r", [noInput]).action).toEqual({ type: "open", sessionId: sessionOf(noInput, "impl-api") })
    const flaky = byName("flaky")
    expect(workflowsPageKey({ ...start, selected: 4 }, "\r", sample).action).toEqual({ type: "open", sessionId: sessionOf(flaky, "a") })
    // a running task wins over a failed one listed earlier
    const both = workflow({ tasks: tasksOf([["f", { state: "failed" }], ["r", { state: "running" }]]) })
    expect(workflowsPageKey(start, "\r", [both]).action).toEqual({ type: "open", sessionId: sessionOf(both, "r") })
  })

  test("enter with nothing to prioritize opens the latest task session, else the run's root session", () => {
    const done = byName("audit deps")
    const latest = { ...done, tasks: done.tasks.map((t, i) => ({ ...t, endedAt: NOW - (10 - i) * MIN })) }
    expect(workflowsPageKey(start, "\r", [latest]).action).toEqual({ type: "open", sessionId: latest.tasks[1]!.sessionId! })
    const fresh = workflow({ state: "paused", tasks: tasksOf([["a", { state: "pending" }]]) })
    expect(workflowsPageKey(start, "\r", [fresh]).action).toEqual({ type: "open", sessionId: fresh.rootSessionId })
  })

  test("enter opens the cursor's task, and nothing for a task that has no session yet", () => {
    const first = sample[0]!
    expect(workflowsPageKey({ ...start, task: 0 }, "\r", sample).action).toEqual({ type: "open", sessionId: first.tasks.find((t) => t.id === "survey")!.sessionId! })
    expect(workflowsPageKey({ ...start, task: 1 }, "\r", sample).action).toEqual({ type: "open", sessionId: first.tasks.find((t) => t.id === "impl-api")!.sessionId! })
    // tests is pending: it has no session, so enter does nothing even though other tasks have one
    expect(workflowsPageKey({ ...start, task: 3 }, "\r", sample).action).toEqual({ type: "none" })
    const withoutSession = workflow({ tasks: tasksOf([["a", { state: "pending" }]]) })
    expect(workflowsPageKey({ ...start, task: 0 }, "\r", [withoutSession]).action).toEqual({ type: "none" })
  })

  test("enter on the verification block opens the auditor session", () => {
    const verification = verificationRound()
    const run = workflow({ state: "blocked", contract, tasks: graph(), rounds: 1, verification })
    expect(workflowsPageKey({ ...start, task: 4 }, "\r", [run]).action).toEqual({ type: "open", sessionId: verification.audit!.sessionId })
  })

  test("esc and q close; an empty list never throws", () => {
    expect(workflowsPageKey(start, "\x1b", sample).action).toEqual({ type: "close" })
    expect(workflowsPageKey(start, "q", []).action).toEqual({ type: "close" })
    for (const key of ["j", "k", "h", "l", "p", "x", "t", "v", "a", "d", "\r", "y"]) expect(workflowsPageKey(start, key, []).action).toEqual({ type: "none" })
  })

  test("p pauses running, waiting and verifying runs and resumes paused and blocked ones", () => {
    for (const name of ["api rewrite", "docs sweep"]) expect(on(name, "p").action).toEqual({ type: "control", workflowId: id(name), action: "pause" })
    expect(workflowsPageKey(start, "p", [workflow({ state: "verifying" })]).action).toMatchObject({ action: "pause" })
    for (const name of ["later", "broken"]) expect(on(name, "p").action).toEqual({ type: "control", workflowId: id(name), action: "resume" })
    for (const name of ["audit deps", "flaky", "old"]) expect(on(name, "p").action).toEqual({ type: "none" })
  })

  test("v verifies a blocked run with a contract, or a paused one whose tasks are finished", () => {
    expect(on("broken", "v").action).toEqual({ type: "control", workflowId: id("broken"), action: "verify" })
    const pausedDone = workflow({ state: "paused", contract, tasks: tasksOf([["a", { state: "done" }], ["b", { state: "skipped" }]]) })
    expect(workflowsPageKey(start, "v", [pausedDone]).action).toMatchObject({ action: "verify" })
    const pausedWorking = workflow({ state: "paused", contract, tasks: tasksOf([["a", { state: "done" }], ["b", { state: "pending" }]]) })
    expect(workflowsPageKey(start, "v", [pausedWorking]).action).toEqual({ type: "none" })
    const noContract = workflow({ state: "blocked", tasks: graph() })
    expect(workflowsPageKey(start, "v", [noContract]).action).toEqual({ type: "none" })
    for (const name of ["api rewrite", "docs sweep", "audit deps", "flaky", "old"]) expect(on(name, "v").action).toEqual({ type: "none" })
  })

  test("a asks for a reason unless the run is running, waiting, completed or stopped", () => {
    for (const name of ["broken", "flaky", "later"]) expect(on(name, "a").action).toEqual({ type: "accept", workflowId: id(name) })
    expect(workflowsPageKey(start, "a", [workflow({ state: "verifying" })]).action).toMatchObject({ type: "accept" })
    for (const name of ["api rewrite", "docs sweep", "audit deps", "old"]) expect(on(name, "a").action).toEqual({ type: "none" })
  })

  test("t retries the selected failed task, or the first failed one with no cursor", () => {
    const run = workflow({ state: "failed", tasks: tasksOf([["a", { state: "done" }], ["b", { state: "failed", needs: ["a"] }], ["c", { state: "failed", needs: ["a"] }], ["d", { state: "skipped", needs: ["b"] }]]) })
    expect(workflowsPageKey(start, "t", [run]).action).toEqual({ type: "retry", workflowId: run.workflowId, taskId: "b" })
    expect(workflowsPageKey({ ...start, task: 2 }, "t", [run]).action).toEqual({ type: "retry", workflowId: run.workflowId, taskId: "c" })
    expect(workflowsPageKey({ ...start, task: 0 }, "t", [run]).action).toEqual({ type: "none" })
    expect(workflowsPageKey({ ...start, task: 3 }, "t", [run]).action).toEqual({ type: "none" })
    expect(workflowsPageKey(start, "t", [byName("docs sweep")]).action).toEqual({ type: "none" })
  })

  test("y and n approve or reject the human task that waits, at the cursor or the first one", () => {
    const run = workflow({ state: "needs_input", tasks: tasksOf([["a", { state: "done" }], ["gate", { state: "needs_input", needs: ["a"], over: { kind: "human", mode: undefined, latest: "Approve the release" } }], ["work", { state: "needs_input", needs: ["a"] }]]) })
    expect(workflowsPageKey(start, "y", [run]).action).toEqual({ type: "answer", workflowId: run.workflowId, taskId: "gate", decision: "approve" })
    expect(workflowsPageKey(start, "n", [run]).action).toEqual({ type: "answer", workflowId: run.workflowId, taskId: "gate", decision: "reject" })
    expect(workflowsPageKey({ ...start, task: 2 }, "y", [run]).action).toEqual({ type: "none" })
    expect(workflowsPageKey({ ...start, task: 0 }, "n", [run]).action).toEqual({ type: "none" })
    expect(workflowsPageKey(start, "y", [byName("docs sweep")]).action).toEqual({ type: "none" })
    const rows = plain(render([run], start)).join("\n")
    expect(rows).toContain("human")
    expect(rows).toContain("y approve · n reject · Approve the release")
  })

  test("a task waiting out its retry backoff shows why", () => {
    const run = workflow({ state: "running", tasks: tasksOf([["a", { state: "pending", over: { attempt: 1, retryAt: NOW + 5_000, reason: "retrying after transient failure: the turn failed" } }]]) })
    expect(plain(render([run], start)).join("\n")).toContain("retrying after transient failure")
  })

  test("x asks for confirmation, then x or y stops", () => {
    const asked = on("docs sweep", "x")
    expect(asked.action).toEqual({ type: "none" })
    expect(asked.state.confirm).toEqual({ kind: "stop", workflowId: id("docs sweep") })
    const done = workflowsPageKey(asked.state, "x", sample)
    expect(done.action).toEqual({ type: "control", workflowId: id("docs sweep"), action: "stop" })
    expect(done.state.confirm).toBeUndefined()
    expect(workflowsPageKey(asked.state, "y", sample).action).toMatchObject({ action: "stop" })
    expect(workflowsPageKey(asked.state, "d", sample).action).toEqual({ type: "none" })
  })

  test("d asks for confirmation, then d or y deletes", () => {
    const asked = workflowsPageKey(start, "d", sample)
    expect(asked.state.confirm).toEqual({ kind: "delete", workflowId: sample[0]!.workflowId })
    expect(workflowsPageKey(asked.state, "d", sample).action).toEqual({ type: "control", workflowId: sample[0]!.workflowId, action: "delete" })
    expect(workflowsPageKey(asked.state, "y", sample).action).toMatchObject({ action: "delete" })
    expect(workflowsPageKey(asked.state, "x", sample).action).toEqual({ type: "none" })
  })

  test("any other key cancels a confirmation, esc does not close", () => {
    const asked = workflowsPageKey(start, "x", sample).state
    for (const key of ["n", "j", "\x1b", "p", "\t", "\r"]) {
      const result = workflowsPageKey(asked, key, sample)
      expect(result.action).toEqual({ type: "none" })
      expect(result.state.confirm).toBeUndefined()
    }
  })

  test("a confirmation for a run that is no longer selected does nothing", () => {
    const asked = workflowsPageKey(start, "x", sample).state
    expect(workflowsPageKey({ ...asked, selected: 1 }, "x", sample).action).toEqual({ type: "none" })
  })

  test("stop is ignored for finished runs but delete is not", () => {
    for (const name of ["audit deps", "flaky", "old"]) {
      expect(on(name, "x").state.confirm).toBeUndefined()
      expect(on(name, "d").state.confirm).toEqual({ kind: "delete", workflowId: id(name) })
    }
    expect(on("later", "x").state.confirm).toEqual({ kind: "stop", workflowId: id("later") })
  })

  test("tab toggles the scope, resets the selection and cursor, and reports the new scope", () => {
    const all = workflowsPageKey({ selected: 3, scope: "project", task: 1 }, "\t", sample)
    expect(all.action).toEqual({ type: "scope", scope: "all" })
    expect(all.state).toEqual({ selected: 0, scope: "all" })
    expect(workflowsPageKey(all.state, "\t", sample).action).toEqual({ type: "scope", scope: "project" })
  })

  test("unknown keys change nothing", () => {
    const result = workflowsPageKey(start, "z", sample)
    expect(result.state).toBe(start)
    expect(result.action).toEqual({ type: "none" })
  })
})

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
