import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, type Loop, type LoopRun, type LoopTemplateInfo } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { FALLBACK_TEMPLATES, FIRE_COMMAND, buildLoopFields, editLoopForm, formRows, newLoopForm } from "../src/view/loop-form"
import { createLoopsPageState, loopsPageKey, renderLoopsPage, triggerShort, type LoopsPageAction, type LoopsPageState } from "../src/view/loops-page"
import { textWidth } from "../src/view/wrap"
import { appHarness, scratch } from "./extensions-harness"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DOWN = "\x1b[B"
const UP = "\x1b[A"
const RIGHT = "\x1b[C"
const LEFT = "\x1b[D"
const CLEAR = "\x15"

function loop(over: Partial<Loop> = {}): Loop {
  return {
    loopId: ids("loop"),
    name: "check ci",
    directory: "/work/app",
    objective: "check the CI status and fix failing tests",
    trigger: { kind: "interval", everyMs: 30 * MIN },
    budget: { mode: "monitor" },
    state: "active",
    sessionId: ids("session"),
    runs: 2,
    nextWakeAt: NOW + 12 * MIN,
    history: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...over,
  }
}

const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)
const render = (loops: Loop[], state: LoopsPageState, width = 220, height = 60) => renderLoopsPage({ loops, state, width, height, now: NOW })

type Row = ReturnType<typeof formRows>[number]
type SaveAction = Extract<LoopsPageAction, { type: "save" }>

/** Drives the page key handler the way the app does, keeping the state and every action it returned. */
function driver(loops: Loop[] = [], initial: LoopsPageState = createLoopsPageState()) {
  let state = initial
  const actions: LoopsPageAction[] = []
  const api = {
    get state() {
      return state
    },
    actions,
    get form() {
      return state.form!
    },
    press(...keys: string[]) {
      for (const key of keys) {
        const result = loopsPageKey(state, key, loops)
        state = result.state
        if (result.action.type !== "none") actions.push(result.action)
      }
      return api
    },
    /** Moves the form's focus to a row. */
    focus(row: Row) {
      const target = formRows(state.form!).indexOf(row)
      if (target < 0) throw new Error(`no row ${row} in ${formRows(state.form!).join(",")}`)
      while (state.form!.row < target) api.press(DOWN)
      while (state.form!.row > target) api.press(UP)
      return api
    },
    /** Types `value` into a text row, replacing what was there. */
    fill(row: Row, value: string) {
      api.focus(row).press(CLEAR)
      return api.press(value)
    },
    /** Presses enter on the last row; the save action it produced, if the form accepted itself. */
    save(): SaveAction | undefined {
      const before = actions.length
      api.focus("submit").press("\r")
      return actions.slice(before).find((action): action is SaveAction => action.type === "save")
    },
  }
  return api
}

const open = (loops: Loop[] = []) => driver(loops).press("c")

describe("loops form: the create flow sends one loop.create per trigger", () => {
  test("c opens a blank form with the interval trigger; an empty objective is refused", () => {
    const d = open()
    expect(d.form.trigger).toBe("interval")
    expect(formRows(d.form)).toEqual(["template", "name", "objective", "trigger", "every", "budget", "maxTokens", "maxCost", "unknownCost", "approvalActions", "reportOnly", "worktree", "runNow", "submit"])
    expect(d.save()).toBeUndefined()
    expect(d.state.form?.error).toBe("objective is empty")
    expect(d.actions).toEqual([])
  })

  test("interval: the name comes from the objective and the span becomes everyMs", () => {
    const d = open().fill("objective", "check CI and fix failing tests")
    const save = d.save()!
    expect(save.fields).toEqual({ name: "check CI and fix failing tests", objective: "check CI and fix failing tests", trigger: { kind: "interval", everyMs: 30 * MIN }, budget: { mode: "monitor" } })
    expect(save.summary).toBe("every 30m · monitor")
    expect(d.state.form).toBeUndefined()
    const other = open().fill("objective", "watch logs").fill("name", "log watch").fill("every", "2h").save()!
    expect(other.fields).toMatchObject({ name: "log watch", trigger: { kind: "interval", everyMs: 2 * HOUR } })
  })

  test("interval: spans outside 1m to 30d and words are refused with a message", () => {
    for (const bad of ["", "abc", "30", "0m", "31d", "1.5h"]) {
      const d = open().fill("objective", "x").fill("every", bad)
      expect(d.save()).toBeUndefined()
      expect(d.state.form?.error).toMatch(/every needs a span|interval must be/)
    }
    expect(open().fill("objective", "x").fill("every", "every 45m").save()!.fields.trigger).toEqual({ kind: "interval", everyMs: 45 * MIN })
  })

  test("daily: HH:MM and an IANA time zone; a bad zone or time is refused", () => {
    const d = open().fill("objective", "triage issues").focus("trigger").press(RIGHT)
    expect(d.form.trigger).toBe("daily")
    expect(formRows(d.form)).toContain("timezone")
    d.fill("at", "7:30").fill("timezone", "Europe/Madrid")
    expect(d.save()!.fields.trigger).toEqual({ kind: "daily", at: "07:30", timezone: "Europe/Madrid" })
    const local = open().fill("objective", "x").focus("trigger").press(RIGHT).save()!
    expect(local.fields.trigger).toEqual({ kind: "daily", at: "09:00" })
    const zone = open().fill("objective", "x").focus("trigger").press(RIGHT).fill("timezone", "Mars/Base")
    expect(zone.save()).toBeUndefined()
    expect(zone.state.form?.error).toContain("IANA")
    const time = open().fill("objective", "x").focus("trigger").press(RIGHT).fill("at", "25:00")
    expect(time.save()).toBeUndefined()
    expect(time.state.form?.error).toContain("HH:MM")
  })

  test("adaptive: the starting pace with optional bounds, sent as everyMs, minMs and maxMs", () => {
    const d = open().fill("objective", "watch the PR").focus("trigger").press(RIGHT, RIGHT)
    expect(d.form.trigger).toBe("adaptive")
    expect(formRows(d.form).slice(3, 8)).toEqual(["trigger", "every", "min", "max", "budget"])
    expect(d.save()!.fields.trigger).toEqual({ kind: "adaptive", everyMs: 30 * MIN })
    const bounded = open().fill("objective", "watch the PR").focus("trigger").press(RIGHT, RIGHT).fill("min", "5m").fill("max", "4h").save()!
    expect(bounded.fields.trigger).toEqual({ kind: "adaptive", everyMs: 30 * MIN, minMs: 5 * MIN, maxMs: 4 * HOUR })
    expect(bounded.summary).toContain("adaptive 30m (5m..4h)")
  })

  test("adaptive: one bound given takes the default for the other; bounds that do not bracket the pace are refused", () => {
    const one = open().fill("objective", "x").focus("trigger").press(RIGHT, RIGHT).fill("min", "10m").save()!
    expect(one.fields.trigger).toEqual({ kind: "adaptive", everyMs: 30 * MIN, minMs: 10 * MIN, maxMs: 4 * HOUR })
    const inverted = open().fill("objective", "x").focus("trigger").press(RIGHT, RIGHT).fill("min", "2h")
    expect(inverted.save()).toBeUndefined()
    expect(inverted.state.form?.error).toContain("min <= every <= max")
    const words = open().fill("objective", "x").focus("trigger").press(RIGHT, RIGHT).fill("max", "soon")
    expect(words.save()).toBeUndefined()
    expect(words.state.form?.error).toContain("min and max need a span")
  })

  test("external: no schedule, the fire command is shown, and the loop is created with an external trigger", () => {
    const d = open().fill("objective", "react to CI").focus("trigger").press(RIGHT, RIGHT, RIGHT)
    expect(d.form.trigger).toBe("external")
    expect(formRows(d.form)).toContain("external")
    expect(plain(render([], d.state)).join("\n")).toContain("mendcode loop fire <id>")
    expect(d.save()!.fields.trigger).toEqual({ kind: "external" })
  })

  test("manual with run now starts the first run at once", () => {
    const d = open().fill("objective", "one shot").focus("trigger").press(LEFT)
    expect(d.form.trigger).toBe("manual")
    expect(formRows(d.form)).not.toContain("every")
    d.focus("runNow").press(" ")
    expect(d.save()!.fields).toEqual({ name: "one shot", objective: "one shot", trigger: { kind: "manual" }, budget: { mode: "monitor" }, runNow: true })
  })

  test("budget: goal takes a cap and what must be true; fixed needs a number of runs", () => {
    const goal = open().fill("objective", "make CI green").focus("budget").press(RIGHT)
    expect(goal.form.budget).toBe("goal")
    expect(formRows(goal.form)).toEqual(expect.arrayContaining(["runs", "criteria"]))
    goal.fill("runs", "5").fill("criteria", "CI is green")
    expect(goal.save()!.fields).toMatchObject({ budget: { mode: "goal", maxRuns: 5 }, criteria: "CI is green" })
    const capless = open().fill("objective", "x").focus("budget").press(RIGHT).save()!
    expect(capless.fields.budget).toEqual({ mode: "goal" })
    expect(capless.fields.criteria).toBeUndefined()

    const fixed = open().fill("objective", "x").focus("budget").press(RIGHT, RIGHT)
    expect(fixed.form.budget).toBe("fixed")
    expect(fixed.save()).toBeUndefined()
    expect(fixed.state.form?.error).toBe("fixed needs runs")
    expect(fixed.fill("runs", "0").save()).toBeUndefined()
    expect(fixed.state.form?.error).toContain("1 to 1000")
    expect(fixed.fill("runs", "3").save()!.fields.budget).toEqual({ mode: "fixed", maxRuns: 3 })
  })

  test("typed text is one printable line: escapes are dropped, backspace and ctrl+u edit", () => {
    const d = open().focus("objective").press("hello", "\x7f", "!")
    expect(d.form.objective).toBe("hell!")
    d.press("\x1b[31m")
    expect(d.form.objective).toBe("hell!")
    d.press(CLEAR)
    expect(d.form.objective).toBe("")
  })

  test("esc cancels without a command", () => {
    const d = open().fill("objective", "x").press("\x1b")
    expect(d.state.form).toBeUndefined()
    expect(d.actions).toEqual([])
  })

  test("enter moves to the next row; enter on the last row saves", () => {
    const d = open().focus("objective").press("x", "\r")
    expect(formRows(d.form)[d.form.row]).toBe("trigger")
    expect(d.save()).toBeDefined()
  })
})

describe("loops form: report-only and worktree", () => {
  test("report-only alone is sent as reportOnly: true", () => {
    const d = open().fill("objective", "audit deps").focus("reportOnly").press(" ")
    expect(d.form.reportOnly).toBe("on")
    const save = d.save()!
    expect(save.fields.reportOnly).toBe(true)
    expect(save.fields.workspace).toBeUndefined()
    expect(save.summary).toContain("report-only")
  })

  test("worktree alone is sent as workspace: worktree", () => {
    const save = open().fill("objective", "refactor").focus("worktree").press(" ").save()!
    expect(save.fields.workspace).toBe("worktree")
    expect(save.fields.reportOnly).toBeUndefined()
    expect(save.summary).toContain("worktree")
  })

  test("the two exclude each other: a report-only run never edits, so it has no worktree", () => {
    const worktreeFirst = open().fill("objective", "x").focus("worktree").press(" ").focus("reportOnly").press(" ")
    expect(worktreeFirst.form).toMatchObject({ reportOnly: "on", worktree: false })
    expect(worktreeFirst.save()!.fields).toMatchObject({ reportOnly: true })
    const reportFirst = open().fill("objective", "x").focus("reportOnly").press(" ").focus("worktree").press(" ")
    expect(reportFirst.form).toMatchObject({ reportOnly: "off", worktree: true })
    const fields = reportFirst.save()!.fields
    expect(fields.workspace).toBe("worktree")
    expect(fields.reportOnly).toBeUndefined()
  })

  test("the toggles render as checkboxes", () => {
    const d = open().focus("reportOnly").press(" ")
    const rows = plain(render([], d.state))
    expect(rows.find((row) => row.includes("report-only"))).toContain("[x] on")
    expect(rows.find((row) => row.includes("worktree"))).toContain("[ ] off")
  })
})

describe("loops form: templates", () => {
  test("t opens the form on the first template; what the template fills is left out of the command", () => {
    const d = driver().press("t")
    expect(d.form.template).toBe("pr-watch")
    expect(d.form).toMatchObject({ trigger: "default", budget: "default", reportOnly: "default" })
    const save = d.save()!
    expect(save.fields).toEqual({ name: "PR watch", template: "pr-watch" })
    expect(save.summary).toBe("template pr-watch · template trigger · template budget")
  })

  test("the daemon's templates replace the built-in list; left and right pick one", () => {
    const templates: LoopTemplateInfo[] = [
      { id: "alpha", name: "Alpha", description: "first", summary: "every 1h · monitor" },
      { id: "beta", name: "Beta", description: "second template", summary: "adaptive 15m · goal" },
    ]
    const d = driver([], { ...createLoopsPageState(), templates }).press("t")
    expect(d.form.template).toBe("alpha")
    d.focus("template").press(RIGHT)
    expect(d.form.template).toBe("beta")
    expect(plain(render([], d.state)).join("\n")).toContain("second template · fills in adaptive 15m · goal")
    d.press(RIGHT)
    expect(d.form.template).toBe("")
    expect(d.form).toMatchObject({ trigger: "interval", budget: "monitor", reportOnly: "off" })
    d.press(LEFT)
    expect(d.form.template).toBe("beta")
    expect(d.save()!.fields.template).toBe("beta")
  })

  test("the built-in list matches docs/loops.md", () => {
    expect(FALLBACK_TEMPLATES.map((template) => template.id)).toEqual(["pr-watch", "ci-repair", "research-digest", "repo-maintenance"])
  })

  test("what you set wins: an objective becomes Specifically, a trigger or budget overrides the template's", () => {
    const d = driver().press("t").fill("objective", "PR 42").focus("trigger").press(RIGHT)
    expect(d.form.trigger).toBe("manual")
    d.focus("budget").press(RIGHT)
    expect(d.form.budget).toBe("monitor")
    expect(d.save()!.fields).toEqual({ name: "PR 42", objective: "PR 42", trigger: { kind: "manual" }, budget: { mode: "monitor" }, template: "pr-watch" })
  })

  test("a template's report-only stays unless you say otherwise; worktree makes it explicit", () => {
    const d = driver().press("t").focus("template").press(RIGHT, RIGHT)
    expect(d.form.template).toBe("research-digest")
    expect(d.save()!.fields.reportOnly).toBeUndefined()
    const worktree = driver().press("t").focus("template").press(RIGHT, RIGHT).focus("worktree").press(" ")
    expect(worktree.form).toMatchObject({ reportOnly: "off", worktree: true })
    expect(worktree.save()!.fields).toMatchObject({ template: "research-digest", reportOnly: false, workspace: "worktree" })
  })
})

describe("loops form: editing", () => {
  const goal = loop({
    name: "keep CI green",
    objective: "make CI pass",
    criteria: "all checks pass",
    trigger: { kind: "adaptive", everyMs: 30 * MIN, minMs: 10 * MIN, maxMs: 2 * HOUR },
    budget: { mode: "goal", maxRuns: 20 },
    checks: ["bun test"],
    audit: "independent",
    reportOnly: false,
    workspace: "worktree",
    state: "blocked",
  })

  test("e opens the form prefilled from the loop", () => {
    const d = driver([goal]).press("e")
    expect(d.form).toMatchObject({ name: "keep CI green", objective: "make CI pass", criteria: "all checks pass", trigger: "adaptive", every: "30m", min: "10m", max: "2h", budget: "goal", runs: "20", worktree: true, reportOnly: "off" })
    expect(d.form.replaces).toEqual({ loopId: goal.loopId, name: "keep CI green", state: "blocked" })
    const screen = plain(render([goal], d.state)).join("\n")
    expect(screen).toContain("editing “keep CI green”")
    expect(screen).toContain("save loop")
  })

  test("saving sends the edited loop and its id; checks and audit are carried over", () => {
    const d = driver([goal]).press("e").fill("objective", "make CI pass and stay green").focus("trigger").press(LEFT)
    expect(d.form.trigger).toBe("daily")
    const save = d.save()!
    expect(save.replaces).toEqual({ loopId: goal.loopId, name: "keep CI green", state: "blocked" })
    expect(save.fields).toEqual({
      name: "keep CI green",
      objective: "make CI pass and stay green",
      criteria: "all checks pass",
      trigger: { kind: "daily", at: "09:00" },
      budget: { mode: "goal", maxRuns: 20 },
      checks: ["bun test"],
      audit: "independent",
      workspace: "worktree",
      reportOnly: false,
    })
  })

  test("a default-bounds adaptive loop is prefilled with empty bounds, not fractional minutes", () => {
    const form = editLoopForm(loop({ trigger: { kind: "adaptive", everyMs: 30 * MIN } }))
    expect([form.min, form.max]).toEqual(["", ""])
    expect(buildLoopFields(form)).toMatchObject({ ok: true, fields: { trigger: { kind: "adaptive", everyMs: 30 * MIN } } })
  })

  test("every trigger kind round-trips through the form", () => {
    const triggers: Loop["trigger"][] = [{ kind: "manual" }, { kind: "external" }, { kind: "interval", everyMs: 3 * HOUR }, { kind: "daily", at: "06:15", timezone: "Europe/Madrid" }, { kind: "adaptive", everyMs: HOUR, minMs: 5 * MIN, maxMs: 24 * HOUR }]
    for (const trigger of triggers) {
      const built = buildLoopFields(editLoopForm(loop({ trigger })))
      expect(built.ok && built.fields.trigger).toEqual(trigger)
    }
  })

  test("editing sends explicit clears for criteria, report-only and worktree", () => {
    const d = driver([goal]).press("e").fill("criteria", "").focus("worktree").press(" ")
    expect(d.save()!.fields).toMatchObject({ criteria: "", reportOnly: false, workspace: "in-place" })
    const report = driver([loop({ reportOnly: true })]).press("e").focus("reportOnly").press(" ")
    expect(report.save()!.fields.reportOnly).toBe(false)
  })

  test("a new form has no loop to replace", () => {
    expect(newLoopForm().replaces).toBeUndefined()
  })
})

describe("loops page: adaptive pace, last run, external fire", () => {
  const run = (n: number, over: Partial<LoopRun> = {}): LoopRun => ({ run: n, startedAt: NOW - 10 * MIN, endedAt: NOW - 4 * MIN, outcome: "completed", checkpoint: { status: "continue", summary: `run ${n} done`, activity: "acted" }, trigger: "schedule", ...over })
  const bounds = { everyMs: 15 * MIN, minMs: 5 * MIN, maxMs: 2 * HOUR }

  test("the list shows the pace an adaptive loop is on now; the detail shows it against the bounds", () => {
    const adaptive = loop({ name: "pr watch", trigger: { kind: "adaptive", ...bounds }, adaptiveMs: HOUR })
    expect(triggerShort(adaptive)).toBe("adaptive 1h")
    expect(triggerShort(loop({ trigger: { kind: "adaptive", everyMs: 15 * MIN } }))).toBe("adaptive 15m")
    expect(triggerShort(loop({ trigger: { kind: "daily", at: "09:00" } }))).toBe("daily 09:00")
    const rows = plain(render([adaptive], createLoopsPageState()))
    expect(rows.join("\n")).toContain("now every 1h")
    expect(rows.some((row) => row.includes("adaptive 15m (5m..2h)") && row.includes("now every 1h"))).toBe(true)
    const slowest = plain(render([loop({ trigger: { kind: "adaptive", ...bounds }, adaptiveMs: 2 * HOUR })], createLoopsPageState()))
    expect(slowest.some((row) => row.includes("now every 2h (slowest)"))).toBe(true)
    const fastest = plain(render([loop({ trigger: { kind: "adaptive", ...bounds }, adaptiveMs: 5 * MIN })], createLoopsPageState()))
    expect(fastest.some((row) => row.includes("now every 5m (fastest)"))).toBe(true)
  })

  test("the last run's outcome, activity, age and origin show in the detail", () => {
    const rows = plain(render([loop({ history: [run(1), run(2, { trigger: "external" })] })], createLoopsPageState()))
    expect(rows.some((row) => row.includes("last run") && row.includes("completed · acted · 4m ago · run 2 · external fire"))).toBe(true)
    const idle = plain(render([loop({ history: [run(1, { checkpoint: { status: "continue", summary: "nothing", activity: "idle" }, outcome: "failed" })] })], createLoopsPageState()))
    expect(idle.some((row) => row.includes("last run") && row.includes("failed · idle"))).toBe(true)
    const retained = plain(render([loop({ history: [run(3, { worktree: { path: "/tmp/w", branch: "loop/ci-r3", state: "retained" } })] })], createLoopsPageState()))
    expect(retained.some((row) => row.includes("worktree loop/ci-r3 retained"))).toBe(true)
  })

  test("report-only, worktree and template show as the loop's mode", () => {
    const rows = plain(render([loop({ reportOnly: true, template: "research-digest" })], createLoopsPageState()))
    expect(rows.some((row) => row.includes("mode") && row.includes("report-only · template research-digest"))).toBe(true)
    const worktree = plain(render([loop({ workspace: "worktree" })], createLoopsPageState()))
    expect(worktree.some((row) => row.includes("mode") && row.includes("worktree"))).toBe(true)
    expect(plain(render([loop()], createLoopsPageState())).some((row) => row.includes("mode  "))).toBe(false)
  })

  test("an external loop shows the command to fire it, with its id, and a queued fire", () => {
    const external = loop({ name: "ci hook", trigger: { kind: "external" }, nextWakeAt: undefined, pendingFire: { at: NOW - 1000, note: "https://ci.example/run/7" } })
    const rows = plain(render([external], createLoopsPageState()))
    expect(rows.some((row) => row.includes(`mendcode loop fire ${external.loopId}`))).toBe(true)
    expect(rows.some((row) => row.includes("queued fire: https://ci.example/run/7"))).toBe(true)
    expect(rows.some((row) => row.includes("y copy fire cmd"))).toBe(true)
    expect(rows.some((row) => row.includes("f fire"))).toBe(true)
    expect(plain(render([loop()], createLoopsPageState())).some((row) => row.includes("copy fire cmd"))).toBe(false)
    expect(FIRE_COMMAND(undefined)).toBe("mendcode loop fire <id>")
  })

  test("y copies the fire command and f fires, only for an external loop that can be fired", () => {
    const external = loop({ trigger: { kind: "external" } })
    expect(loopsPageKey(createLoopsPageState(), "y", [external]).action).toEqual({ type: "copy", text: `mendcode loop fire ${external.loopId}` })
    expect(loopsPageKey(createLoopsPageState(), "f", [external]).action).toEqual({ type: "fire", loopId: external.loopId })
    expect(loopsPageKey(createLoopsPageState(), "f", [loop({ trigger: { kind: "external" }, state: "paused" })]).action).toEqual({ type: "none" })
    expect(loopsPageKey(createLoopsPageState(), "f", [loop({ trigger: { kind: "external" }, state: "blocked" })]).action).toEqual({ type: "none" })
    expect(loopsPageKey(createLoopsPageState(), "y", [loop()]).action).toEqual({ type: "none" })
    expect(loopsPageKey(createLoopsPageState(), "f", [loop()]).action).toEqual({ type: "none" })
  })

  test("the empty page offers the form", () => {
    const rows = plain(render([], createLoopsPageState()))
    expect(rows.some((row) => row.includes("c new loop form") && row.includes("t new loop from a template"))).toBe(true)
  })
})

describe("loops form render", () => {
  test("every width draws exactly height rows within width, with the focused row in view", () => {
    const states: LoopsPageState[] = [
      driver().press("c").focus("submit").state,
      driver().press("c").focus("trigger").press(RIGHT, RIGHT).focus("max").state,
      driver().press("t").focus("reportOnly").state,
      driver([loop()]).press("e").state,
    ]
    for (const width of [30, 50, 80, 100, 140]) {
      for (const height of [10, 14, 24, 40]) {
        for (const state of states) {
          const rows = plain(render([loop()], state, width, height))
          expect(rows).toHaveLength(height)
          for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
        }
      }
    }
    const focused = plain(render([], driver().press("c").focus("submit").state, 80, 14))
    expect(focused.some((row) => row.includes("create loop"))).toBe(true)
  })

  test("the form shows what it will send and why it cannot", () => {
    const ok = plain(render([], driver().press("c").fill("objective", "x").state)).join("\n")
    expect(ok).toContain("→ every 30m · monitor")
    const bad = plain(render([], driver().press("c").state)).join("\n")
    expect(bad).toContain("· objective is empty")
    const refused = driver().press("c").focus("submit").press("\r")
    expect(plain(render([], refused.state)).join("\n")).toContain("✗ objective is empty")
  })
})

const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

describe("/loops in the app", () => {
  type Harness = Awaited<ReturnType<typeof openLoops>>
  async function openLoops(options: { loops?: Loop[]; reply?: (command: Record<string, unknown>) => unknown } = {}) {
    const dirs = scratch()
    made.push(dirs)
    const h = await appHarness({
      dataDir: dirs.dataDir,
      width: 100,
      height: 40,
      reply: (command) => {
        const custom = options.reply?.(command)
        if (custom !== undefined) return custom
        if (command.type === "loop.list") return { ok: true, result: { loops: options.loops ?? [] } }
        if (command.type === "loop.templates") return { ok: true, result: { templates: [{ id: "daemon-tpl", name: "Daemon template", description: "from the daemon", summary: "every 5m · monitor" }] } }
        return undefined
      },
    })
    await h.start({ onboarded: true })
    await h.type("/loops")
    await h.key("\r")
    await Bun.sleep(15)
    h.app.render()
    return h
  }
  const created = (h: Harness) => h.sent.filter((command) => command.type === "loop.create")
  /** From the top row of the form to the objective, typed, then down to the last row and enter. */
  async function fillAndSave(h: Harness, objective: string, options: { clear?: boolean } = {}) {
    await h.key(DOWN)
    await h.key(DOWN)
    if (options.clear) await h.key(CLEAR)
    await h.key(objective)
    for (let i = 0; i < 20; i++) await h.key(DOWN)
    await h.key("\r")
    await Bun.sleep(15)
    h.app.render()
  }

  test("opening the page asks for the loops and the daemon's templates", async () => {
    const h = await openLoops()
    // The app also lists live loops once at start, for the count under the prompt.
    expect(h.sent.filter((command) => command.type === "loop.list").length).toBeGreaterThanOrEqual(1)
    expect(h.sent.filter((command) => command.type === "loop.templates")).toHaveLength(1)
    await h.key("t")
    expect(h.text()).toContain("Daemon template")
  })

  test("c, an objective and an interval create a loop in this project", async () => {
    const h = await openLoops()
    await h.key("c")
    expect(h.text()).toContain("New loop")
    await fillAndSave(h, "keep CI green")
    expect(created(h)).toEqual([{ type: "loop.create", directory: "/work/app", name: "keep CI green", objective: "keep CI green", trigger: { kind: "interval", everyMs: 30 * MIN }, budget: { mode: "monitor" } }])
    expect(h.app.page).toBe("loops")
    expect(h.sent.filter((command) => command.type === "loop.list").length).toBeGreaterThanOrEqual(2)
  }, 15_000)

  test("a refused create keeps what was typed and shows the daemon's message", async () => {
    const h = await openLoops({ reply: (command) => (command.type === "loop.create" ? { ok: false, error: { code: "invalid_command", message: "[DAEMON]: the directory must be a git checkout" } } : undefined) })
    await h.key("c")
    await fillAndSave(h, "refactor")
    expect(created(h)).toHaveLength(1)
    expect(h.text()).toContain("the directory must be a git checkout")
    expect(h.text()).toContain("New loop")
    expect(h.text()).toContain("refactor")
  }, 15_000)

  test("editing updates the existing loop without create or stop", async () => {
    const old = loop({ name: "old loop", objective: "old objective" })
    const h = await openLoops({ loops: [old] })
    await h.key("e")
    expect(h.text()).toContain("editing “old loop”")
    await fillAndSave(h, "new objective", { clear: true })
    expect(created(h)).toEqual([])
    expect(h.sent.filter((command) => command.type === "loop.update")).toEqual([{ type: "loop.update", loopId: old.loopId, name: "old loop", objective: "new objective", criteria: "", trigger: { kind: "interval", everyMs: 30 * MIN }, budget: { mode: "monitor" }, reportOnly: false, workspace: "in-place" }])
    expect(h.sent.filter((command) => command.type === "loop.control")).toEqual([])
  }, 15_000)

  test("an already stopped loop is not stopped again when edited", async () => {
    const old = loop({ state: "stopped" })
    const h = await openLoops({ loops: [old] })
    await h.key("2")
    await h.key("e")
    for (let i = 0; i < 20; i++) await h.key(DOWN)
    await h.key("\r")
    await Bun.sleep(15)
    expect(created(h)).toHaveLength(0)
    expect(h.sent.filter((command) => command.type === "loop.update")).toHaveLength(1)
    expect(h.sent.filter((command) => command.type === "loop.control")).toEqual([])
  }, 15_000)

  test("a refused update restores the edit form and does not create a replacement", async () => {
    const old = loop({ objective: "old objective" })
    const h = await openLoops({ loops: [old], reply: (command) => command.type === "loop.update" ? { ok: false, error: { code: "busy", message: "[DAEMON]: the loop is running; edit it after the run" } } : undefined })
    await h.key("e")
    await fillAndSave(h, "new objective", { clear: true })
    expect(h.sent.filter((command) => command.type === "loop.update")).toHaveLength(1)
    expect(created(h)).toEqual([])
    expect(h.sent.filter((command) => command.type === "loop.control")).toEqual([])
    expect(h.text()).toContain("the loop is running; edit it after the run")
    expect(h.text()).toContain("Loops / Edit")
    expect(h.text()).toContain("new objective")
  }, 30_000)

  test("f fires an external loop and y copies its command through the terminal", async () => {
    const external = loop({ trigger: { kind: "external" }, nextWakeAt: undefined })
    const h = await openLoops({ loops: [external] })
    await h.key("f")
    expect(h.sent.filter((command) => command.type === "loop.fire")).toEqual([{ type: "loop.fire", loopId: external.loopId }])
    await h.key("y")
    const command = `mendcode loop fire ${external.loopId}`
    expect(h.written.join("")).toContain(Buffer.from(command).toString("base64"))
  }, 15_000)
})
