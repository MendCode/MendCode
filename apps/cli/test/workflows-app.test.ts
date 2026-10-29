import { describe, expect, test } from "bun:test"
import { createIdFactory, type WorkflowSummary } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { parseWorkflowCommand } from "../src/view/workflow-command"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function run(patch: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    workflowId: ids("workflow"),
    name: "ship",
    directory: "/work/app",
    objective: "Ship it.",
    planHash: "0".repeat(64),
    permission: "edits",
    state: "running",
    rootSessionId: ids("session"),
    tasks: [{ id: "build", title: "Build", kind: "agent", mode: "work", needs: [], state: "running", attempt: 1 }],
    rounds: 0,
    repairs: 0,
    startedAt: NOW - 60_000,
    updatedAt: NOW,
    ...patch,
  }
}

function harness(reply: (command: Record<string, unknown>) => unknown = () => undefined) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 120, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: "/work/app",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
    random: () => 0,
    mode: "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      return (await reply(command)) ?? { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain)
  const slash = async (line: string) => {
    await app.onInput(line)
    await app.onKey("\r")
    await Bun.sleep(5)
    app.render()
  }
  return { app, sent, text, slash }
}

describe("/workflows command", () => {
  test("parses names, files, permission, --yes and accept", () => {
    expect(parseWorkflowCommand("ship")).toEqual({ ok: true, spec: { kind: "start", source: { ref: "ship" }, confirmed: false } })
    expect(parseWorkflowCommand("plans/a.json --permission full --yes")).toEqual({ ok: true, spec: { kind: "start", source: { file: "plans/a.json" }, permission: "full", confirmed: true } })
    expect(parseWorkflowCommand("ship --permission root")).toEqual({ ok: false, error: "--permission needs ask, edits or full" })
    expect(parseWorkflowCommand("Ship It")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("accept workflow_1 tests are flaky")).toEqual({ ok: true, spec: { kind: "accept", workflowId: "workflow_1", reason: "tests are flaky" } })
    expect(parseWorkflowCommand("accept workflow_1")).toMatchObject({ ok: false })
    expect(parseWorkflowCommand("")).toMatchObject({ ok: false })
  })

  test("without --yes it only previews; with --yes it starts as this session's child and opens the page", async () => {
    const started = run()
    const { sent, text, slash } = harness((command) => {
      if (command.type === "workflow.preview") return { ok: true, result: { problems: [], summary: { name: "ship", tasks: [{}, {}], checks: ["bun test"], permission: "edits" } } }
      if (command.type === "workflow.start") return { ok: true, result: { workflow: started } }
      if (command.type === "workflow.list") return { ok: true, result: { workflows: [started] } }
      return undefined
    })
    await slash("/workflows ship")
    expect(sent.some((command) => command.type === "workflow.start")).toBe(false)
    expect(text().join("\n")).toContain("checks: bun test")
    await slash("/workflows ship --yes")
    const start = sent.find((command) => command.type === "workflow.start")!
    expect(start).toMatchObject({ directory: "/work/app", plan: { ref: "ship" } })
    expect(start.originSessionId).toBeDefined()
    expect(text().join("\n")).toMatch(/workflows/i)
    expect(text().join("\n")).toContain("ship")
  })

  test("preview problems are shown and nothing starts", async () => {
    const { sent, text, slash } = harness((command) => (command.type === "workflow.preview" ? { ok: true, result: { problems: ['task "a": needs unknown task "zz"'] } } : undefined))
    await slash("/workflows ship --yes")
    expect(sent.some((command) => command.type === "workflow.start")).toBe(false)
    expect(text().join("\n")).toContain("zz")
  })
})

describe("workflows in the chat", () => {
  test("the row under the prompt counts live workflows and marks one that needs the user", async () => {
    const { app, text } = harness((command) =>
      command.type === "workflow.list" ? { ok: true, result: { workflows: [run(), run({ state: "needs_input" }), run({ state: "completed" }), run({ directory: "/elsewhere" })] } } : undefined,
    )
    app.applySettings({})
    await Bun.sleep(5)
    app.render()
    expect(text().at(-1)).toContain("◇ 2 workflows ?")
  })

  test("workflow.changed keeps the count and the open page current", async () => {
    const live = run()
    const { app, text, slash } = harness((command) => (command.type === "workflow.list" ? { ok: true, result: { workflows: [live] } } : undefined))
    app.applySettings({})
    await slash("/workflows")
    expect(text().join("\n")).toContain("ship")
    app.onGlobal({ type: "workflow.changed", gseq: 1, at: NOW, workflow: { ...live, state: "completed", tasks: [{ ...live.tasks[0]!, state: "done" }] } } as never)
    app.render()
    expect(text().join("\n")).toContain("completed")
    await app.onKey("\x1b")
    app.render()
    expect(text().at(-1)).not.toContain("◇")
  })
})

describe("profile in the chat", () => {
  test("a project inside a profile's folder leads the row under the prompt with its name; personal shows nothing", async () => {
    const company = harness()
    company.app.applySettings({ profiles: [{ name: "company", directories: ["/work/*"] }] } as never)
    company.app.render()
    // The home screen shows the sessions sidebar at this width; the row leads its own column.
    expect(company.text().at(-1)).toMatch(/^(?:.*│ )? {3}◆ company/)
    const personal = harness()
    personal.app.applySettings({ profiles: [{ name: "company", directories: ["/elsewhere"] }] } as never)
    personal.app.render()
    expect(personal.text().at(-1)).not.toContain("◆")
  })
})
