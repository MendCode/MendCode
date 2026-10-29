import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type WorkflowSummary } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")
const project = mkdtempSync(path.join(tmpdir(), "mend-tui-script-"))
const data = mkdtempSync(path.join(tmpdir(), "mend-tui-data-"))
afterAll(() => {
  rmSync(project, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})
const SOURCE = `export const meta = { name: "demo", budget: { agents: 5 } }\nreturn 1`
writeFileSync(path.join(project, "flow.js"), SOURCE)
writeFileSync(path.join(project, "plan.json"), JSON.stringify({ name: "p", objective: "o", tasks: [{ kind: "agent", id: "a", title: "A", prompt: "do it", mode: "read", needs: [] }] }))

const summary = { name: "demo", tasks: [], checks: [], permission: "edits", maxConcurrent: 16, script: { hash: "c".repeat(64), origin: "file", meta: { budget: { agents: 5 } } } }
const started = { workflowId: ids("workflow"), name: "demo", directory: project, objective: "demo", planHash: "0".repeat(64), permission: "edits", state: "running", rootSessionId: ids("session"), tasks: [], rounds: 0, repairs: 0, startedAt: NOW - 1000, updatedAt: NOW } as WorkflowSummary

function harness(remote = false) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 140, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"), screen, directory: project, dataDir: data, exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => NOW, random: () => 0, mode: "balanced",
    ...(remote ? { remote: { host: "h", readOnly: false } } : {}),
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      if (command.type === "workflow.preview") return { ok: true, result: { problems: [], summary } }
      if (command.type === "workflow.start") return { ok: true, result: { workflow: started } }
      if (command.type === "workflow.list") return { ok: true, result: { workflows: [started] } }
      if (command.type === "workflow.script") return { ok: true, result: { workflow: started } }
      return { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain).join("\n")
  const slash = async (line: string) => {
    await app.onInput(line)
    await app.onKey("\r")
    await Bun.sleep(10)
    app.render()
  }
  return { sent, text, slash }
}

describe("/workflows run and friends in the terminal", () => {
  test("run previews with the origin, hash and caps; --yes starts it with the arguments", async () => {
    const h = harness()
    await h.slash("/workflows run flow.js who=me")
    expect(h.sent.some((command) => command.type === "workflow.start")).toBe(false)
    expect(h.text()).toContain("sha256 cccccccccccc")
    expect(h.text()).toContain("caps agents 5")
    expect(h.sent.find((command) => command.type === "workflow.preview")).toMatchObject({ plan: { script: SOURCE, origin: "file", args: { who: "me" } } })
    await h.slash("/workflows run flow.js who=me --yes")
    expect(h.sent.find((command) => command.type === "workflow.start")).toMatchObject({ directory: project, plan: { script: SOURCE, args: { who: "me" } } })
  })

  test("a saved name goes to the daemon as a script reference", async () => {
    const h = harness()
    await h.slash("/workflows run saved --yes")
    expect(h.sent.find((command) => command.type === "workflow.start")).toMatchObject({ plan: { scriptRef: "saved" } })
  })

  test("a remote terminal does not start scripts", async () => {
    const h = harness(true)
    await h.slash("/workflows run flow.js --yes")
    expect(h.sent.some((command) => command.type === "workflow.start" || command.type === "workflow.preview")).toBe(false)
    expect(h.text()).toContain("script workflows start")
  })

  test("budget, resume and update talk to the daemon", async () => {
    const h = harness()
    await h.slash("/workflows budget wf_1 agents=60 usd=5")
    expect(h.sent.find((command) => command.type === "workflow.script")).toMatchObject({ workflowId: "wf_1", action: "budget", budget: { agents: 60, usd: 5 } })
    await h.slash("/workflows resume wf_1")
    expect(h.sent.find((command) => command.type === "workflow.control")).toMatchObject({ workflowId: "wf_1", action: "resume" })
    await h.slash("/workflows update wf_1 flow.js")
    expect(h.sent.filter((command) => command.type === "workflow.script").at(-1)).toMatchObject({ action: "update", script: SOURCE })
  })

  test("new writes the starter in the user's workflows folder; convert writes a script next to the plan", async () => {
    const h = harness()
    await h.slash("/workflows new my-flow")
    expect(readFileSync(path.join(data, "workflows", "my-flow.js"), "utf8")).toContain("export const meta")
    expect(h.text()).toContain("wrote workflows/my-flow.js")
    await h.slash("/workflows new my-flow")
    expect(h.text()).toContain("already exists")
    await h.slash("/workflows convert plan.json")
    expect(readFileSync(path.join(project, "plan.js"), "utf8")).toContain('agent("do it"')
  })
})
