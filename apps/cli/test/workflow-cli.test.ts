import { describe, expect, test } from "bun:test"
import type { GlobalEvent, WorkflowRun, WorkflowSummary } from "@mendcode/protocol"
import { EXIT, helpText, parseAutomation, previewText, runAutomation, SCHEMA, waitingLines, workflowRows, workflowText, type Automation, type AutomationDeps } from "../src/automation"

const WFL = "wfl_1"
const SES = "ses_task"

function parsed(...argv: string[]): Automation {
  const result = parseAutomation(argv)
  if (result.ok !== true) throw new Error(`not parsed: ${JSON.stringify(result)}`)
  return result.command
}
const failure = (...argv: string[]) => {
  const result = parseAutomation(argv)
  if (result.ok !== false) throw new Error("expected a parse error")
  return result.message
}
const lines = (out: string[]) => out.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))

const plan = {
  name: "ship it",
  objective: "build and test",
  tasks: [
    { kind: "agent", id: "build", title: "Build it", prompt: "do", mode: "work" },
    { kind: "check", id: "test", title: "Run tests", command: "bun test", needs: ["build"] },
  ],
  contract: { criteria: [{ id: "works", text: "it works", required: true }], checks: [{ id: "unit", command: "bun test packages/x", covers: ["works"] }], audit: "auto" },
  permission: "full",
}

function summary(patch: Record<string, unknown> = {}): WorkflowSummary {
  return {
    workflowId: WFL,
    name: "ship it",
    directory: "/work/app",
    objective: "build and test",
    planHash: "0".repeat(64),
    permission: "edits",
    state: "running",
    rootSessionId: "ses_root",
    tasks: [
      { id: "build", title: "Build it", kind: "agent", mode: "work", needs: [], state: "done", attempt: 1 },
      { id: "test", title: "Run tests", kind: "check", needs: ["build"], state: "running", attempt: 1 },
    ],
    rounds: 0,
    repairs: 0,
    startedAt: 1,
    updatedAt: 10,
    ...patch,
  } as never
}

function run(patch: Record<string, unknown> = {}): WorkflowRun {
  return {
    ...summary(),
    plan,
    tasks: [
      { id: "build", title: "Build it", kind: "agent", mode: "work", needs: [], state: "done", attempt: 2, sessionId: SES, result: "built" },
      { id: "test", title: "Run tests", kind: "check", needs: ["build"], state: "failed", attempt: 1, reason: "exit 1" },
    ],
    verifications: [
      {
        round: 1,
        at: 5,
        gates: [{ id: "bun test packages/x", status: "fail", detail: "1 failed" }],
        audit: { verdict: "fail", sessionId: "ses_audit", inspections: 2, findings: "missing test", criteria: [{ id: "works", status: "fail", evidence: "e" }] },
        criteria: [{ id: "works", status: "fail", by: "check" }],
        accepted: false,
      },
    ],
    override: { reason: "manual review", at: 9 },
    ...patch,
  } as never
}

type Send = (command: Record<string, unknown>) => { ok: true; result?: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

function harness(options: { send?: Send; files?: Record<string, unknown>; globals?: boolean } = {}) {
  const out: string[] = []
  const err: string[] = []
  const sent: Array<Record<string, unknown>> = []
  const read: string[] = []
  let global: ((event: GlobalEvent) => void) | undefined
  const timers: Array<{ ms: number; callback: () => void; cancelled: boolean }> = []
  const deps: AutomationDeps = {
    client: { send: async (command: Record<string, unknown>) => (sent.push(command), options.send?.(command) ?? { ok: true }), subscribe: async () => ({ ok: true }) } as never,
    listen: () => {},
    ...(options.globals === false ? {} : { listenGlobal: (handler: ((event: GlobalEvent) => void) | undefined) => void (global = handler) }),
    readJson: async (file) => {
      read.push(file)
      if (!(file in (options.files ?? {}))) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      const value = options.files![file]
      if (value instanceof SyntaxError) throw value
      return value
    },
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    cwd: "/work/app",
    now: () => 0,
    onInterrupt: () => {},
    setTimer: (ms, callback) => {
      const timer = { ms, callback, cancelled: false }
      timers.push(timer)
      return { cancel: () => void (timer.cancelled = true) }
    },
  }
  const push = (workflow: WorkflowSummary, deleted?: boolean) => global?.({ type: "workflow.changed", workflow, ...(deleted ? { deleted } : {}) } as never)
  return { deps, out, err, sent, read, push, timers, listening: () => global !== undefined }
}

/** preview ok + start ok; `start` is the summary acked by workflow.start. */
const daemonFor = (start: WorkflowSummary, previewResult: Record<string, unknown> = { problems: [], summary: { permission: "edits" } }): Send => (command) => {
  if (command.type === "workflow.preview") return { ok: true, result: previewResult }
  if (command.type === "workflow.start") return { ok: true, result: { workflow: start } }
  return { ok: true }
}

describe("workflow argument parsing", () => {
  test("list", () => {
    expect(parsed("workflow", "list")).toEqual({ kind: "workflow.list", all: false, json: false })
    expect(parsed("workflow", "list", "--all", "--json")).toEqual({ kind: "workflow.list", all: true, json: true })
  })

  test("preview and start take a file or a saved name", () => {
    expect(parsed("workflow", "preview", "plans/ship.json")).toMatchObject({ kind: "workflow.preview", target: "plans/ship.json" })
    expect(parsed("workflow", "preview", "ship")).toMatchObject({ kind: "workflow.preview", target: "ship" })
    expect(parsed("workflow", "start", "ship")).toEqual({ kind: "workflow.start", target: "ship", yes: false, wait: false, json: false })
    expect(parsed("workflow", "start", "ship.json", "--permission", "edits", "--yes", "--wait", "--timeout", "90")).toMatchObject({ kind: "workflow.start", target: "ship.json", permission: "edits", yes: true, wait: true, timeoutMs: 90_000 })
    expect(parsed("workflow", "start", "ship")).not.toHaveProperty("permission")
  })

  test("show and every control action", () => {
    expect(parsed("workflow", "show", WFL)).toMatchObject({ kind: "workflow.show", id: WFL })
    for (const action of ["pause", "resume", "stop", "verify", "delete"] as const) expect(parsed("workflow", action, WFL)).toEqual({ kind: "workflow.control", id: WFL, action, json: false })
    expect(parsed("workflow", "retry", WFL, "--task", "build")).toMatchObject({ kind: "workflow.control", id: WFL, action: "retry", taskId: "build" })
    expect(parsed("workflow", "accept", WFL, "--reason", "reviewed by hand")).toMatchObject({ kind: "workflow.control", id: WFL, action: "accept", reason: "reviewed by hand" })
  })

  test("approve and reject answer a human task and need its id", () => {
    expect(parsed("workflow", "approve", WFL, "--task", "gate-1")).toEqual({ kind: "workflow.control", id: WFL, action: "approve", taskId: "gate-1", json: false })
    expect(parsed("workflow", "reject", WFL, "--task-id", "qa", "--reason", "not yet")).toMatchObject({ kind: "workflow.control", id: WFL, action: "reject", taskId: "qa", reason: "not yet" })
    expect(failure("workflow", "approve", WFL)).toContain("--task")
    expect(failure("workflow", "approve", WFL, "--task", "Not A Slug")).toContain("--task")
    expect(failure("workflow", "reject", "--task", "qa")).toContain("needs <id>")
    expect(failure("workflow", "approve", WFL, "--task", "qa", "--reason", "x".repeat(501))).toContain("at most 500")
  })

  test("errors name the missing piece", () => {
    expect(failure("workflow")).toContain("needs a command")
    expect(failure("workflow", "bogus")).toContain('unknown workflow command "bogus"')
    expect(failure("workflow", "preview")).toContain("needs <file.json|name>")
    expect(failure("workflow", "start")).toContain("needs <file.json|name>")
    expect(failure("workflow", "start", "Bad Name")).toContain("neither a .json file")
    expect(failure("workflow", "start", "a", "b")).toContain("one <file.json|name>")
    expect(failure("workflow", "start", "ship", "--permission", "root")).toContain("--permission")
    expect(failure("workflow", "start", "ship", "--timeout", "5")).toContain("needs --wait")
    expect(failure("workflow", "start", "ship", "--wait", "--timeout", "0")).toContain("--timeout")
    expect(failure("workflow", "show")).toContain("needs <id>")
    expect(failure("workflow", "pause")).toContain("needs <id>")
    expect(failure("workflow", "retry", WFL)).toContain("--task")
    expect(failure("workflow", "retry", WFL, "--task", "Not A Slug")).toContain("--task")
    expect(failure("workflow", "retry", "--task", "build")).toContain("needs <id>")
    expect(failure("workflow", "accept", WFL)).toContain("--reason")
    expect(failure("workflow", "accept", WFL, "--reason", "x".repeat(501))).toContain("at most 500")
    expect(failure("workflow", "list", "--wat")).toContain("unknown flag --wat")
  })

  test("help lists the workflow commands and the needs-input exit code", () => {
    expect(parsed("workflow", "--help")).toMatchObject({ kind: "help", topic: "workflow" })
    expect(helpText("workflow")).toStartWith("usage: mendcode workflow")
    expect(helpText()).toContain("mendcode workflow <command>")
    expect(helpText("workflow")).toContain("accept <id> --reason")
    expect(helpText("workflow")).toContain("save <file.json|name>")
    expect(helpText("loop")).not.toContain("revision")
    expect(helpText()).toContain("4 needs input")
    expect(EXIT.needsInput).toBe(4)
  })
})

describe("loop create checks and audit", () => {
  test("--check repeats and --no-audit maps to audit none", () => {
    expect(parsed("loop", "create", "--every", "1h", "--goal", "--check", "bun test", "--check=bun run typecheck", "--no-audit", "fix it")).toMatchObject({ checks: ["bun test", "bun run typecheck"], audit: "none" })
    expect(parsed("loop", "create", "--every", "1h", "--goal", "fix")).not.toHaveProperty("checks")
    expect(parsed("loop", "create", "--every", "1h", "--goal", "fix")).not.toHaveProperty("audit")
  })

  test("--check needs --goal, a value and at most five", () => {
    expect(failure("loop", "create", "--every", "1h", "--check", "bun test", "fix")).toContain("need --goal")
    expect(failure("loop", "create", "--every", "1h", "--no-audit", "fix")).toContain("need --goal")
    expect(failure("loop", "create", "--every", "1h", "--goal", "fix", "--check")).toContain("--check needs a value")
    expect(failure("loop", "create", "--every", "1h", "--goal", ...["a", "b", "c", "d", "e", "f"].flatMap((c) => ["--check", c]), "fix")).toContain("at most 5")
  })

  test("the runner sends checks and audit to the daemon", async () => {
    const h = harness({ send: () => ({ ok: true, result: { loop: { loopId: "loop_1", state: "active" } } }) })
    await runAutomation(parsed("loop", "create", "--every", "1h", "--goal", "--check", "bun test", "--no-audit", "keep green"), h.deps)
    expect(h.sent[0]).toMatchObject({ type: "loop.create", checks: ["bun test"], audit: "none" })
  })
})

describe("workflow formatting", () => {
  test("rows show state, progress and name", () => {
    expect(workflowRows([])).toBe("no workflows\n")
    expect(workflowRows([summary(), summary({ workflowId: "wfl_2", state: "needs_input", name: "other" })])).toBe(`${WFL}  running      1/2 tasks  ship it  working=1 blocked=0\nwfl_2  needs_input  1/2 tasks  other  working=1 blocked=0\n`)
    expect(workflowRows([summary({ tasks: [{ id: "ask", state: "needs_input" }, { id: "failed", state: "failed" }] })])).toContain("working=0 blocked=2")
  })

  test("show prints tasks, contract, last verification and the override", () => {
    const text = workflowText(run({ state: "blocked", reason: "contract not met" }))
    expect(text).toContain(`${WFL}  blocked  edits  ship it`)
    expect(text).toContain("reason: contract not met")
    expect(text).toContain("tasks 1/2:")
    expect(text).toContain(`[x] build  done         agent/work  Build it  (attempt 2)  ${SES}`)
    expect(text).toContain("[!] test  failed       check  Run tests")
    expect(text).toContain("      exit 1")
    expect(text).toContain("contract: 1 criteria · audit auto")
    expect(text).toContain("  works  required  it works")
    expect(text).toContain("  check unit: bun test packages/x")
    expect(text).toContain("verification round 1: not accepted")
    expect(text).toContain("FAIL  bun test packages/x  1 failed")
    expect(text).toContain("fail        works  by check")
    expect(text).toContain("audit fail: missing test")
    expect(text).toContain("accepted by user: manual review")
    expect(workflowText(run({ plan: { ...plan, contract: undefined }, verifications: [], override: undefined }))).toContain("contract: none (unverified)")
  })

  test("waiting lines name the task and its session", () => {
    const waiting = summary({ tasks: [{ id: "ask", title: "t", kind: "agent", needs: [], state: "needs_input", attempt: 1, sessionId: SES }] })
    expect(waitingLines(waiting)).toEqual([`waiting: ask  session ${SES}\n`])
    expect(waitingLines(summary())).toEqual([])
  })

  test("preview prints tasks, verbatim checks and the lower of the requested and granted permission", () => {
    const text = previewText({ target: "ship.json", plan, summary: { permission: "edits" }, granted: undefined })
    expect(text).toContain("plan: ship it")
    expect(text).toContain("build  agent/work  Build it")
    expect(text).toContain("test  check  Run tests  $ bun test")
    expect(text).toContain("check unit: bun test packages/x")
    expect(text).toContain("permission: edits")
    expect(previewText({ target: "ship.json", plan, summary: {}, granted: "ask" })).toContain("permission: ask")
    expect(previewText({ target: "ship.json", plan, summary: {}, granted: "full" })).toContain("permission: full")
    expect(previewText({ target: "ship", plan: { ref: "ship" }, summary: undefined })).toBe("plan: ship\npermission: set by the daemon at start\n")
    expect(previewText({ target: "ship", plan: { ref: "ship" }, summary: { name: "saved", tasks: [{ id: "a", kind: "check", title: "T", command: "make" }], checks: ["make all"] } })).toContain("check: make all")
  })
})

describe("workflow list, show and control", () => {
  test("list scopes to the directory unless --all", async () => {
    const send: Send = () => ({ ok: true, result: { workflows: [summary()] } })
    const scoped = harness({ send })
    expect(await runAutomation(parsed("workflow", "list"), scoped.deps)).toBe(0)
    expect(scoped.sent[0]).toEqual({ type: "workflow.list", directory: "/work/app" })
    expect(scoped.out.join("")).toContain("1/2 tasks  ship it")
    const all = harness({ send })
    await runAutomation(parsed("workflow", "list", "--all", "--json"), all.deps)
    expect(all.sent[0]).toEqual({ type: "workflow.list" })
    expect(lines(all.out)).toEqual([{ schema: SCHEMA, kind: "result", command: "workflow.list", data: { workflows: [expect.objectContaining({ workflowId: WFL })] } }])
  })

  test("show fetches the run", async () => {
    const h = harness({ send: () => ({ ok: true, result: { workflow: run() } }) })
    expect(await runAutomation(parsed("workflow", "show", WFL), h.deps)).toBe(0)
    expect(h.sent[0]).toEqual({ type: "workflow.get", workflowId: WFL })
    expect(h.out.join("")).toContain("verification round 1")
  })

  test("control sends the mapped command with task and reason", async () => {
    const send: Send = () => ({ ok: true, result: { workflow: summary({ state: "paused" }) } })
    const pause = harness({ send })
    expect(await runAutomation(parsed("workflow", "pause", WFL), pause.deps)).toBe(0)
    expect(pause.sent[0]).toEqual({ type: "workflow.control", workflowId: WFL, action: "pause" })
    expect(pause.out).toEqual([`pause ${WFL}  paused\n`])
    const retry = harness({ send })
    await runAutomation(parsed("workflow", "retry", WFL, "--task", "build"), retry.deps)
    expect(retry.sent[0]).toEqual({ type: "workflow.control", workflowId: WFL, action: "retry", taskId: "build" })
    const accept = harness({ send })
    await runAutomation(parsed("workflow", "accept", WFL, "--reason", "looked fine", "--json"), accept.deps)
    expect(accept.sent[0]).toEqual({ type: "workflow.control", workflowId: WFL, action: "accept", reason: "looked fine" })
    expect(lines(accept.out)[0]).toMatchObject({ schema: SCHEMA, kind: "result", command: "workflow.control", data: { workflowId: WFL, action: "accept" } })
    const remove = harness({ send: () => ({ ok: true, result: {} }) })
    await runAutomation(parsed("workflow", "delete", WFL), remove.deps)
    expect(remove.out).toEqual([`delete ${WFL}\n`])
  })

  test("daemon errors exit 1 and keep the daemon error code in JSON", async () => {
    const send: Send = () => ({ ok: false, error: { code: "busy", message: "another workflow is running" } })
    const human = harness({ send })
    expect(await runAutomation(parsed("workflow", "stop", WFL), human.deps)).toBe(EXIT.failed)
    expect(human.err).toEqual(["error: another workflow is running\n"])
    const json = harness({ send })
    await runAutomation(parsed("workflow", "stop", WFL, "--json"), json.deps)
    expect(lines(json.out)).toEqual([{ schema: SCHEMA, kind: "error", command: "workflow.control", error: { code: "busy", message: "another workflow is running" } }])
  })
})

describe("workflow preview", () => {
  test("a plan file is read relative to the directory and sent inline", async () => {
    const h = harness({ send: daemonFor(summary()), files: { "/work/app/plans/ship.json": plan } })
    expect(await runAutomation(parsed("workflow", "preview", "plans/ship.json"), h.deps)).toBe(0)
    expect(h.read).toEqual(["/work/app/plans/ship.json"])
    expect(h.sent).toEqual([{ type: "workflow.preview", directory: "/work/app", plan }])
    expect(h.out.join("")).toContain("$ bun test")
  })

  test("a bare name is sent as a ref and nothing is read", async () => {
    const h = harness({ send: daemonFor(summary()) })
    await runAutomation(parsed("workflow", "preview", "ship"), h.deps)
    expect(h.read).toEqual([])
    expect(h.sent[0]).toEqual({ type: "workflow.preview", directory: "/work/app", plan: { ref: "ship" } })
  })

  test("problems are printed and exit 1, in JSON with the list", async () => {
    const send: Send = () => ({ ok: true, result: { problems: ["task test needs unknown task lint", "no checks"] } })
    const human = harness({ send })
    expect(await runAutomation(parsed("workflow", "preview", "ship"), human.deps)).toBe(EXIT.failed)
    expect(human.err.join("")).toBe("error: plan has 2 problems:\n  - task test needs unknown task lint\n  - no checks\n")
    expect(human.out).toEqual([])
    const json = harness({ send })
    await runAutomation(parsed("workflow", "preview", "ship", "--json"), json.deps)
    expect(lines(json.out)).toEqual([{ schema: SCHEMA, kind: "error", command: "workflow.preview", error: { code: "invalid_plan", message: "plan has 2 problems", problems: ["task test needs unknown task lint", "no checks"] } }])
  })

  test("a missing or malformed plan file fails before contacting the daemon", async () => {
    const missing = harness()
    expect(await runAutomation(parsed("workflow", "preview", "nope.json"), missing.deps)).toBe(EXIT.failed)
    expect(missing.err).toEqual(["error: cannot read plan nope.json: no such file\n"])
    const broken = harness({ files: { "/work/app/bad.json": new SyntaxError("x") } })
    await runAutomation(parsed("workflow", "preview", "bad.json"), broken.deps)
    expect(broken.err).toEqual(["error: cannot read plan bad.json: not valid JSON\n"])
    expect(missing.sent).toEqual([])
    expect(broken.sent).toEqual([])
  })
})

describe("workflow start", () => {
  const files = { "/work/app/ship.json": plan }

  test("without --yes it previews, asks for --yes and starts nothing", async () => {
    const h = harness({ send: daemonFor(summary()), files })
    expect(await runAutomation(parsed("workflow", "start", "ship.json"), h.deps)).toBe(EXIT.ok)
    expect(h.sent.map((c) => c.type)).toEqual(["workflow.preview"])
    expect(h.out.join("")).toContain("check unit: bun test packages/x")
    expect(h.out.join("")).toEndWith("re-run with --yes to start\n")
    const json = harness({ send: daemonFor(summary()), files })
    await runAutomation(parsed("workflow", "start", "ship.json", "--json"), json.deps)
    expect(lines(json.out)).toEqual([{ schema: SCHEMA, kind: "result", command: "workflow.start", data: { started: false, problems: [], summary: { permission: "edits" } } }])
  })

  test("problems stop the start before anything is created", async () => {
    const h = harness({ send: () => ({ ok: true, result: { problems: ["bad"] } }), files })
    expect(await runAutomation(parsed("workflow", "start", "ship.json", "--yes"), h.deps)).toBe(EXIT.failed)
    expect(h.sent.map((c) => c.type)).toEqual(["workflow.preview"])
  })

  test("--yes previews, then starts with the plan, directory and permission", async () => {
    const h = harness({ send: daemonFor(summary()), files })
    expect(await runAutomation(parsed("workflow", "start", "ship.json", "--yes", "--permission", "ask"), h.deps)).toBe(EXIT.ok)
    expect(h.sent.map((c) => c.type)).toEqual(["workflow.preview", "workflow.start"])
    expect(h.sent[1]).toEqual({ type: "workflow.start", directory: "/work/app", plan, permission: "ask" })
    expect(h.out.join("")).toContain("permission: ask")
    expect(h.out.join("")).toEndWith(`${WFL}  running  ship it\n`)
    expect(h.listening()).toBe(false)
  })

  test("a saved name starts as a ref, and a start refusal exits 1 with its code", async () => {
    const send: Send = (command) => (command.type === "workflow.start" ? { ok: false, error: { code: "busy", message: "another workflow with work tasks is running here" } } : { ok: true, result: { problems: [] } })
    const h = harness({ send })
    expect(await runAutomation(parsed("workflow", "start", "ship", "--yes", "--json"), h.deps)).toBe(EXIT.failed)
    expect(h.sent[1]).toEqual({ type: "workflow.start", directory: "/work/app", plan: { ref: "ship" } })
    expect(lines(h.out)).toEqual([{ schema: SCHEMA, kind: "error", command: "workflow.start", error: { code: "busy", message: "another workflow with work tasks is running here" } }])
  })

  test("--json --yes prints one result line", async () => {
    const h = harness({ send: daemonFor(summary()), files })
    await runAutomation(parsed("workflow", "start", "ship.json", "--yes", "--json"), h.deps)
    expect(lines(h.out)).toEqual([{ schema: SCHEMA, kind: "result", command: "workflow.start", data: { workflow: expect.objectContaining({ workflowId: WFL }) } }])
  })
})

describe("workflow start --wait", () => {
  const files = { "/work/app/ship.json": plan }
  const start = (...extra: string[]) => parsed("workflow", "start", "ship.json", "--yes", "--wait", ...extra)

  test("refuses up front when the client cannot receive global events", async () => {
    const h = harness({ send: daemonFor(summary()), files, globals: false })
    expect(await runAutomation(start(), h.deps)).toBe(EXIT.failed)
    expect(h.sent).toEqual([])
    expect(h.err[0]).toContain("cannot receive workflow events")
  })

  test("waits on pushed events for its own workflow only and exits 0 on completed", async () => {
    const h = harness({ send: daemonFor(summary()), files })
    let finished: number | undefined
    const waiting = runAutomation(start(), h.deps).then((code) => (finished = code))
    await Bun.sleep(2)
    h.push(summary({ workflowId: "wfl_other", state: "failed", updatedAt: 11 }))
    h.push(summary({ state: "verifying", updatedAt: 12 }))
    h.push(summary({ state: "paused", updatedAt: 13 }))
    await Bun.sleep(2)
    expect(finished).toBeUndefined()
    h.push(summary({ state: "completed", updatedAt: 14 }))
    expect(await waiting).toBe(EXIT.ok)
    expect(h.out.join("")).toEndWith(`${WFL}  completed  ship it\n`)
    expect(h.err).toEqual([])
    expect(h.listening()).toBe(false)
  })

  test("maps failed and blocked to 1 and prints the reason", async () => {
    for (const state of ["failed", "blocked"]) {
      const h = harness({ send: daemonFor(summary()), files })
      const waiting = runAutomation(start(), h.deps)
      await Bun.sleep(2)
      h.push(summary({ state, reason: "check unit failed", updatedAt: 20 }))
      expect(await waiting).toBe(EXIT.failed)
      expect(h.err).toEqual(["error: check unit failed\n"])
    }
  })

  test("maps stopped to 2", async () => {
    const h = harness({ send: daemonFor(summary()), files })
    const waiting = runAutomation(start(), h.deps)
    await Bun.sleep(2)
    h.push(summary({ state: "stopped", updatedAt: 20 }))
    expect(await waiting).toBe(EXIT.stopped)
  })

  test("needs_input exits 4 and prints the waiting task session, in JSON too", async () => {
    const tasks = [{ id: "ask", title: "Ask", kind: "agent", mode: "work", needs: [], state: "needs_input", attempt: 1, sessionId: SES }]
    const human = harness({ send: daemonFor(summary()), files })
    const first = runAutomation(start(), human.deps)
    await Bun.sleep(2)
    human.push(summary({ state: "needs_input", tasks, updatedAt: 20 }))
    expect(await first).toBe(EXIT.needsInput)
    expect(human.out.join("")).toContain(`waiting: ask  session ${SES}\n`)
    const json = harness({ send: daemonFor(summary()), files })
    const second = runAutomation(start("--json"), json.deps)
    await Bun.sleep(2)
    json.push(summary({ state: "needs_input", tasks, updatedAt: 20 }))
    expect(await second).toBe(EXIT.needsInput)
    expect(lines(json.out)).toEqual([{ schema: SCHEMA, kind: "result", command: "workflow.start", data: { workflow: expect.objectContaining({ state: "needs_input" }), exitCode: 4, status: "needs_input", waiting: [{ taskId: "ask", sessionId: SES }] } }])
  })

  test("an event that arrives before the start ack is not lost", async () => {
    let h!: ReturnType<typeof harness>
    const send: Send = (command) => {
      if (command.type === "workflow.preview") return { ok: true, result: { problems: [] } }
      h.push(summary({ state: "completed", updatedAt: 30 }))
      return { ok: true, result: { workflow: summary({ updatedAt: 10 }) } }
    }
    h = harness({ send, files })
    expect(await runAutomation(start(), h.deps)).toBe(EXIT.ok)
  })

  test("a workflow already finished in the start ack returns at once", async () => {
    const h = harness({ send: daemonFor(summary({ state: "completed" })), files })
    expect(await runAutomation(start(), h.deps)).toBe(EXIT.ok)
  })

  test("a deleted workflow ends the wait with a failure", async () => {
    const h = harness({ send: daemonFor(summary()), files })
    const waiting = runAutomation(start("--json"), h.deps)
    await Bun.sleep(2)
    h.push(summary({ updatedAt: 40 }), true)
    expect(await waiting).toBe(EXIT.failed)
    expect(lines(h.out)[0]).toMatchObject({ data: { status: "deleted", exitCode: 1 } })
  })

  test("--timeout exits 3 and stops listening", async () => {
    const h = harness({ send: daemonFor(summary()), files })
    const waiting = runAutomation(start("--timeout", "5"), h.deps)
    await Bun.sleep(2)
    expect(h.timers[0]!.ms).toBe(5_000)
    h.timers[0]!.callback()
    expect(await waiting).toBe(EXIT.timeout)
    expect(h.err).toEqual(["error: timed out waiting for the workflow\n"])
    expect(h.listening()).toBe(false)
  })

  test("a refused start does not leave a listener behind", async () => {
    const send: Send = (command) => (command.type === "workflow.start" ? { ok: false, error: { code: "busy", message: "busy" } } : { ok: true, result: { problems: [] } })
    const h = harness({ send, files })
    expect(await runAutomation(start(), h.deps)).toBe(EXIT.failed)
    expect(h.listening()).toBe(false)
  })
})

describe("B21 workflow revisions and v1 aliases", () => {
  test("control-plane/plural aliases and save options map to v2 commands; mixed sources reject", () => {
    expect(parsed("control-plane", "workflows", "status", "--all")).toMatchObject({ kind: "workflow.list", all: true })
    expect(parsed("workflows")).toMatchObject({ kind: "workflow.list" })
    expect(parsed("workflows", "save", "--plan-file", "ship.json", "--definition-id", "wfd_1", "--name", "Ship", "--description", "Release", "--source", "manual")).toMatchObject({ kind: "workflow.save", target: "ship.json", definitionId: "wfd_1", name: "Ship", description: "Release", source: "manual" })
    expect(parsed("workflow", "start", "--revision-id", "wfr_1", "--yes")).toMatchObject({ kind: "workflow.start", target: "revision:wfr_1", yes: true })
    expect(failure("workflow", "start", "ship", "--definition-id", "wfd_1")).toContain("one plan")
    expect(failure("workflow", "save", "ship", "--definition-id", "../bad")).toContain("definition id")
    expect(failure("workflow", "save", "ship", "--source", "unknown")).toContain("source")
  })

  test("save reads the file once and reports immutable identity without preview/start; daemon errors propagate", async () => {
    const receipt = { definitionId: "wfd_1", revisionId: "wfr_2", revision: 2, planHash: "a".repeat(64) }
    const h = harness({ files: { "/work/app/ship.json": plan }, send: () => ({ ok: true, result: { receipt } }) })
    expect(await runAutomation(parsed("control-plane", "workflows", "save", "--plan-file", "ship.json", "--definition-id", "wfd_1", "--json"), h.deps)).toBe(0)
    expect(h.sent).toEqual([{ type: "workflow.save", directory: "/work/app", plan, definitionId: "wfd_1" }])
    expect(lines(h.out)[0]).toMatchObject({ data: { receipt } })
    const denied = harness({ send: () => ({ ok: false, error: { code: "invalid_command", message: "unknown definition" } }) })
    expect(await runAutomation(parsed("workflow", "save", "ship"), denied.deps)).toBe(1)
    expect(denied.err.join("")).toContain("unknown definition")
  })

  test("definition/revision selection makes no file reads; exact identity prints with status", async () => {
    const h = harness({ send: daemonFor(summary()) })
    await runAutomation(parsed("workflow", "start", "--definition-id", "wfd_1", "--yes"), h.deps)
    expect(h.read).toEqual([])
    expect(h.sent[1]).toMatchObject({ type: "workflow.start", plan: { definitionId: "wfd_1" } })
    expect(workflowText(run({ definitionId: "wfd_1", revisionId: "wfr_2", revision: 2 }))).toContain("revision_id: wfr_2 (#2)")
  })

  test("retry-task honours task-id/reason and --wait, including events before the ack", async () => {
    let h!: ReturnType<typeof harness>
    h = harness({ send: () => {
      h.push(summary({ state: "completed", updatedAt: 30 }))
      return { ok: true, result: { workflow: summary() } }
    } })
    expect(await runAutomation(parsed("control-plane", "workflows", "retry-task", WFL, "--task-id", "build", "--reason", "Input confirmed", "--wait"), h.deps)).toBe(0)
    expect(h.sent[0]).toEqual({ type: "workflow.control", workflowId: WFL, action: "retry", taskId: "build", reason: "Input confirmed" })
    expect(h.out.join("")).toContain("completed")
    expect(h.listening()).toBe(false)
  })

  test("retry waiting has a local timeout and unregisters its listener", async () => {
    const h = harness({ send: () => ({ ok: true, result: { workflow: summary() } }) })
    const pending = runAutomation(parsed("workflows", "retry-task", WFL, "--task-id", "build", "--wait", "--timeout", "2"), h.deps)
    await Bun.sleep(2)
    expect(h.timers[0]!.ms).toBe(2000)
    h.timers[0]!.callback()
    expect(await pending).toBe(EXIT.timeout)
    expect(h.listening()).toBe(false)
  })
})
