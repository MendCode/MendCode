import { describe, expect, test } from "bun:test"
import { EXIT, parseAutomation, runAutomation, type Automation, type AutomationDeps } from "../src/automation"

const parsed = (...argv: string[]): Automation => {
  const result = parseAutomation(argv)
  if (result.ok !== true) throw new Error(`not parsed: ${JSON.stringify(result)}`)
  return result.command
}
const failure = (...argv: string[]) => {
  const result = parseAutomation(argv)
  if (result.ok !== false) throw new Error("expected a parse error")
  return result.message
}

const SOURCE = `export const meta = { name: "demo" }\nreturn 1`
const summary = { name: "demo", script: { origin: "file", hash: "f".repeat(64), meta: { description: "does a thing", phases: [{ title: "Go" }], budget: { agents: 5, usd: 1 } }, args: { who: "me" } }, checks: [], permission: "edits", tasks: [] }

function harness(files: Record<string, string> = { "/work/app/flow.js": SOURCE }) {
  const out: string[] = []
  const err: string[] = []
  const sent: Array<Record<string, unknown>> = []
  const written: Record<string, string> = {}
  const deps: AutomationDeps = {
    client: {
      send: async (command: Record<string, unknown>) => {
        sent.push(command)
        if (command.type === "workflow.preview") return { ok: true, result: { problems: [], summary } }
        if (command.type === "workflow.start") return { ok: true, result: { workflow: { workflowId: "wfl_1", name: "demo", state: "running", tasks: [] } } }
        if (command.type === "workflow.script") return { ok: true, result: { workflow: { workflowId: "wfl_1", name: "demo", state: "paused", tasks: [], script: { hash: "a".repeat(64), budget: { agents: 60 } } } } }
        return { ok: true }
      },
      subscribe: async () => ({ ok: true }),
    } as never,
    listen: () => {},
    readText: async (file) => {
      if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return files[file]!
    },
    readJson: async (file) => {
      if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return JSON.parse(files[file]!)
    },
    writeText: async (file, text) => void (written[file] = text),
    exists: async (file) => file in files || file in written,
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    cwd: "/work/app",
    now: () => 0,
    onInterrupt: () => {},
  }
  return { deps, out, err, sent, written }
}

describe("workflow run and its siblings: parsing", () => {
  test("run takes a file or name, arguments as key=value or --args, and the usual start flags", () => {
    expect(parsed("workflow", "run", "flow.js", "who=me", "n=3", "--yes")).toMatchObject({ kind: "workflow.start", target: "flow.js", script: { args: { who: "me", n: 3 } }, yes: true, wait: false })
    expect(parsed("workflow", "run", "saved", "--args", '{"a":1}', "--permission", "edits", "--wait", "--timeout", "30")).toMatchObject({ kind: "workflow.start", target: "saved", script: { args: { a: 1 } }, permission: "edits", wait: true, timeoutMs: 30_000, yes: false })
    expect(parsed("workflow", "start", "flow.js")).toMatchObject({ kind: "workflow.start", target: "flow.js", script: {} })
    expect(parsed("workflow", "preview", "flow.js")).toMatchObject({ kind: "workflow.preview", target: "flow.js", script: {} })
    expect(failure("workflow", "run")).toContain("needs <file.js|name>")
    expect(failure("workflow", "run", "flow.js", "bare")).toContain("key=value")
    expect(failure("workflow", "run", "flow.js", "a=1", "--args", "{}")).toContain("either")
    expect(failure("workflow", "run", "Bad Name")).toContain("neither")
    expect(failure("workflow", "run", "flow.js", "--permission", "root")).toContain("--permission")
  })

  test("new, convert, budget and update", () => {
    expect(parsed("workflow", "new", "my-flow", "--out", "x/y.js")).toMatchObject({ kind: "workflow.new", name: "my-flow", out: "x/y.js" })
    expect(failure("workflow", "new", "Bad Name")).toContain("<name>")
    expect(parsed("workflow", "convert", "plan.json")).toMatchObject({ kind: "workflow.convert", target: "plan.json" })
    expect(failure("workflow", "convert", "plan.txt")).toContain("<plan.json>")
    expect(parsed("workflow", "budget", "wfl_1", "--agents", "60", "--usd", "5")).toMatchObject({ kind: "workflow.script", id: "wfl_1", budget: { agents: 60, usd: 5 } })
    expect(failure("workflow", "budget", "wfl_1")).toContain("at least one")
    expect(parsed("workflow", "update", "wfl_1", "flow.js")).toMatchObject({ kind: "workflow.update", id: "wfl_1", file: "flow.js" })
    expect(failure("workflow", "update", "wfl_1")).toContain("<id> <file.js>")
  })

  test("workflow resume keeps working for script runs", () => {
    expect(parsed("workflow", "resume", "wfl_1")).toMatchObject({ kind: "workflow.control", id: "wfl_1", action: "resume" })
  })
})

describe("workflow run and its siblings: running", () => {
  test("without --yes it only previews: origin, hash, caps and arguments, and nothing starts", async () => {
    const h = harness()
    expect(await runAutomation(parsed("workflow", "run", "flow.js", "who=me"), h.deps)).toBe(0)
    expect(h.sent.map((command) => command.type)).toEqual(["workflow.preview"])
    expect(h.sent[0]).toMatchObject({ plan: { script: SOURCE, origin: "file", args: { who: "me" } } })
    const text = h.out.join("")
    expect(text).toContain("script: file · sha256 " + "f".repeat(64))
    expect(text).toContain("caps: agents 5, usd 1")
    expect(text).toContain('arguments: {"who":"me"}')
    expect(text).toContain("re-run with --yes")
  })

  test("--yes starts it, a saved name goes to the daemon as a script reference", async () => {
    const h = harness()
    expect(await runAutomation(parsed("workflow", "run", "flow.js", "--yes"), h.deps)).toBe(0)
    expect(h.sent.at(-1)).toMatchObject({ type: "workflow.start", plan: { script: SOURCE } })
    const named = harness()
    await runAutomation(parsed("workflow", "run", "saved-flow", "--yes"), named.deps)
    expect(named.sent.at(-1)).toMatchObject({ type: "workflow.start", plan: { scriptRef: "saved-flow" } })
  })

  test("a missing script file is reported without calling the daemon", async () => {
    const h = harness({})
    expect(await runAutomation(parsed("workflow", "run", "nope.js", "--yes"), h.deps)).not.toBe(0)
    expect(h.sent).toEqual([])
    expect(h.err.join("")).toContain("no such file")
  })

  test("new writes the starter and never overwrites; convert writes a script next to the plan", async () => {
    const h = harness({ "/work/app/exists.js": "x", "/work/app/plan.json": JSON.stringify({ name: "p", objective: "o", tasks: [{ kind: "agent", id: "a", title: "A", prompt: "do it", mode: "read", needs: [] }] }) })
    expect(await runAutomation(parsed("workflow", "new", "fresh"), h.deps)).toBe(0)
    expect(h.written["/work/app/fresh.js"]).toContain("export const meta")
    expect(await runAutomation(parsed("workflow", "new", "exists"), h.deps)).not.toBe(0)
    expect(h.err.join("")).toContain("already exists")
    expect(await runAutomation(parsed("workflow", "convert", "plan.json"), h.deps)).toBe(0)
    expect(h.written["/work/app/plan.js"]).toContain('agent("do it"')
    const map = harness({ "/work/app/m.json": JSON.stringify({ name: "m", objective: "o", tasks: [{ kind: "map", id: "each", title: "E", map: {}, needs: [] }] }) })
    expect(await runAutomation(parsed("workflow", "convert", "m.json"), map.deps)).not.toBe(0)
    expect(map.err.join("")).toContain("map task")
    expect(map.written).toEqual({})
  })

  test("budget and update go to the daemon as workflow.script and say how to resume", async () => {
    const h = harness()
    expect(await runAutomation(parsed("workflow", "budget", "wfl_1", "--agents", "60"), h.deps)).toBe(0)
    expect(h.sent.at(-1)).toEqual(expect.objectContaining({ type: "workflow.script", workflowId: "wfl_1", action: "budget", budget: { agents: 60 } }))
    expect(h.out.join("")).toContain("agents 60")
    expect(await runAutomation(parsed("workflow", "update", "wfl_1", "flow.js"), h.deps)).toBe(0)
    expect(h.sent.at(-1)).toEqual(expect.objectContaining({ type: "workflow.script", action: "update", script: SOURCE }))
    expect(h.out.join("")).toContain("workflow resume wfl_1")
  })

  test("EXIT codes stay the documented ones", () => {
    expect(EXIT.needsInput).toBeGreaterThan(0)
  })
})
