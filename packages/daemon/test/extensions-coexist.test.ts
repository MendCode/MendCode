import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers } from "@mendcode/packages"
import { ExtensionsReport } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createExtensions } from "../src/extensions"

const dirs: string[] = []
const calls = () => ((globalThis as { __coexist?: string[] }).__coexist ??= [])
beforeEach(() => {
  ;(globalThis as { __coexist?: string[] }).__coexist = []
})
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `coexist-${label}-`)))
  dirs.push(dir)
  return dir
}

function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

const extension = (name: string, body: string) => `export default { name: ${JSON.stringify(name)}, daemon(api) { ${body} } }\n`
const push = (entry: string) => `globalThis.__coexist.push(${JSON.stringify(entry)})`
const builtinEcho = defineTool({ name: "echo", description: "echo", permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => ({ output: text, truncated: false, title: "echo", isError: false }) })
const ref = (cwd: string) => ({ sessionId: "s1", cwd })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Feedback = Array<{ extension: string; text: string; level: string }>
function setup(options: { timeoutMs?: number; breakerThreshold?: number; disabled?: string[]; tier?: "minimalist" | "balanced" | "full"; feedback?: Feedback } = {}) {
  const user = tmp("user")
  const project = tmp("project")
  const logs: string[] = []
  const ext = createExtensions({
    dataDir: user,
    layersFor: (directory) => extensionLayers({ userDir: user, directory }),
    isTrusted: () => true,
    notify: () => {},
    log: (level, message) => void logs.push(`${level}: ${message}`),
    hookTimeoutMs: options.timeoutMs ?? 100,
    builtinTools: () => [builtinEcho],
    ...(options.breakerThreshold ? { breakerThreshold: options.breakerThreshold } : {}),
    isDisabled: (name) => (options.disabled ?? []).includes(name),
    tier: () => options.tier,
    ...(options.feedback ? { feedback: (event: Feedback[number]) => void options.feedback!.push(event) } : {}),
  })
  return { user, project, logs, ext, userExt: (file: string, text: string) => put(user, `extensions/${file}`, text), projectExt: (file: string, text: string) => put(project, `.mendcode/extensions/${file}`, text) }
}

const tool = (name: string, extra = "") => `api.registerTool({ name: ${JSON.stringify(name)}, description: "tool ${name}", parameters: { type: "object", properties: { q: { type: "string" } } }, permission: "read", execute: async () => ({ output: "ok" })${extra} })`

describe("conflicts between extensions and the host", () => {
  test("a command, a tool, a name and a built-in override each report winner, loser and the rule", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt("a-first.ts", extension("first", `api.registerCommand({ name: "deploy", description: "first", run: () => ({ notice: "1" }) }); ${tool("shared")}`))
    userExt("b-second.ts", extension("second", `api.registerCommand({ name: "deploy", description: "second", run: () => ({ notice: "2" }) }); ${tool("shared")}`))
    userExt("c-override.ts", extension("override", `api.registerTool({ name: "echo", override: true, description: "wrapped", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })`))
    projectExt("d-same.ts", extension("first", ""))
    const report = await ext.report(project)
    const notes = (report.conflicts ?? []).map((entry) => `${entry.kind}:${entry.name}:${entry.winner}>${entry.losers.join(",")}`)
    expect(notes).toEqual(expect.arrayContaining(["command:deploy:second>first", "tool:shared:first>second", "builtin-tool:echo:override>built-in", "name:first:first>first"]))
    // The later layer wins a command; the first registration wins a tool unless the later one asks to override.
    expect((await ext.tools(project, "s")).map((entry) => entry.name).sort()).toEqual(["echo", "shared"])
    const second = report.extensions.find((entry) => entry.name === "second")!
    expect(second.conflicts?.some((line) => line.includes("/deploy of first is hidden by second"))).toBe(true)
    expect(second.conflicts?.some((line) => line.includes("did not get tool shared"))).toBe(true)
    expect(report.extensions.find((entry) => entry.name === "override")!.conflicts?.[0]).toContain("replaces the built-in tool echo")
    // The wire shape stays valid for older and newer terminals.
    expect(ExtensionsReport.safeParse(report).success).toBe(true)
  })

  test("an override of another extension's tool is reported as a replacement, not an error", async () => {
    const { project, ext, userExt } = setup()
    userExt("a.ts", extension("a", tool("shared")))
    userExt("b.ts", extension("b", tool("shared", ", override: true")))
    const report = await ext.report(project)
    expect(report.conflicts).toEqual([expect.objectContaining({ kind: "tool", name: "shared", winner: "b", losers: ["a"] })])
    expect(report.extensions.find((entry) => entry.name === "b")!.errors).toEqual([])
  })

  test("no collision means no conflicts field at all", async () => {
    const { project, ext, userExt } = setup()
    userExt("a.ts", extension("a", tool("one")))
    userExt("b.ts", extension("b", tool("two")))
    const report = await ext.report(project)
    expect(report.conflicts).toBeUndefined()
    expect(report.extensions.every((entry) => entry.conflicts === undefined)).toBe(true)
  })
})

describe("circuit breaker", () => {
  test("a handler that fails three times in a row is not called again; the others and the session carry on", async () => {
    const { project, ext, userExt, logs } = setup({ timeoutMs: 40 })
    userExt("a-broken.ts", extension("broken", `api.on("prompt.system", () => { ${push("broken")}; throw new Error("boom") })`))
    userExt("b-fine.ts", extension("fine", `api.on("prompt.system", (e) => { ${push("fine")}; return e.system + "+" })`))
    const scope = await ext.ensure(project)
    const run = () => ext.bus.promptSystem(scope.records, { ...ref(project), role: "main", system: "s" })
    for (let i = 0; i < 6; i++) expect(await run()).toBe("s+")
    expect(calls().filter((entry) => entry === "broken")).toHaveLength(3)
    expect(calls().filter((entry) => entry === "fine")).toHaveLength(6)
    const [broken, fine] = await ext.list(project)
    expect(broken!.breaker).toEqual(["prompt.system#0"])
    expect(broken!.errors.at(-1)).toContain("stopped for this session after 3 failures in a row")
    expect(fine!.breaker).toBeUndefined()
    expect(logs.filter((line) => line.includes("stopped for this session"))).toHaveLength(1)
  })

  test("a success resets the count: only consecutive failures open the breaker", async () => {
    const { project, ext, userExt } = setup()
    userExt("flaky.ts", extension("flaky", `let n = 0; api.on("prompt.system", (e) => { n++; ${push("run")}; if (n % 3 !== 0) throw new Error("x"); return e.system + "!" })`))
    const scope = await ext.ensure(project)
    for (let i = 0; i < 9; i++) await ext.bus.promptSystem(scope.records, { ...ref(project), role: "main", system: "s" })
    expect(calls()).toHaveLength(9)
    expect((await ext.list(project))[0]!.breaker).toBeUndefined()
  })

  test("a timeout counts as a failure and its late answer is ignored", async () => {
    const { project, ext, userExt } = setup({ timeoutMs: 20, breakerThreshold: 2 })
    userExt("late.ts", extension("late", `api.on("tool.before", async () => { ${push("late")}; await new Promise((r) => setTimeout(r, 80)); return { block: "too late" } })`))
    const scope = await ext.ensure(project)
    const event = { ...ref(project), turnId: "t", tool: "echo", callId: "c", args: { text: "x" } }
    expect(await ext.bus.toolBefore(scope.records, event)).toBeUndefined()
    expect(await ext.bus.toolBefore(scope.records, event)).toBeUndefined()
    await sleep(120)
    // Two timeouts opened the breaker: the third call never reaches the handler, and the blocks that arrived late never applied.
    expect(await ext.bus.toolBefore(scope.records, event)).toBeUndefined()
    expect(calls()).toHaveLength(2)
    expect((await ext.list(project))[0]!.breaker).toEqual(["tool.before#0"])
  })

  test("a command is stopped with a clear notice, and a reload turns everything back on", async () => {
    const { project, ext, userExt } = setup()
    userExt("cmd.ts", extension("cmd", `api.registerCommand({ name: "go", description: "d", run: () => { ${push("go")}; throw new Error("bad") } })`))
    for (let i = 0; i < 3; i++) expect(await ext.routeInput(ref(project), "/go")).toEqual({ kind: "handled", notice: "/go failed; /extensions lists the error" })
    const stopped = await ext.routeInput(ref(project), "/go")
    expect(stopped).toMatchObject({ kind: "handled", notice: expect.stringContaining("/go is stopped for this session") })
    expect(calls()).toHaveLength(3)
    ext.invalidateAll()
    expect(await ext.routeInput(ref(project), "/go")).toMatchObject({ notice: "/go failed; /extensions lists the error" })
    expect(calls()).toHaveLength(4)
  })

  test("a tool that throws is stopped after three failures but one that is running is never cut", async () => {
    const { project, ext, userExt } = setup()
    userExt("tool.ts", extension("tool", `api.registerTool({ name: "flaky", description: "d", parameters: { type: "object" }, permission: "read", execute: async (args) => { ${push("exec")}; if (args.fail) throw new Error("crash"); await new Promise((r) => setTimeout(r, 40)); return { output: "finished" } } })`))
    const [flaky] = await ext.tools(project, "s1")
    const context = () => ({ cwd: project, signal: new AbortController().signal })
    const running = flaky!.execute({}, context())
    for (let i = 0; i < 3; i++) expect(await flaky!.execute({ fail: true }, context())).toMatchObject({ isError: true, output: expect.stringContaining("crash") })
    // The breaker is open for new calls, yet the call that began before it finished normally.
    expect(await running).toMatchObject({ output: "finished", isError: false })
    expect(await flaky!.execute({}, context())).toMatchObject({ isError: true, output: expect.stringContaining("stopped for this session") })
    expect(calls()).toHaveLength(4)
    expect((await ext.list(project))[0]!.breaker).toEqual(["tool:flaky"])
  })

  test("permission.ask failing never grants anything: with the handler stopped the answer is the host's own ask", async () => {
    const { project, ext, userExt } = setup()
    userExt("perm.ts", extension("perm", `api.on("permission.ask", () => { throw new Error("down") })`))
    const scope = await ext.ensure(project)
    for (let i = 0; i < 5; i++) expect(await ext.bus.transform(scope.records, "permission.ask", { ...ref(project), tool: "shell", args: {} } as never, { status: "ask" as const }, (value) => typeof value === "object")).toEqual({ status: "ask" })
  })
})

describe("reload keeps the last working extension", () => {
  const good = (version: string) => extension("steady", `api.on("prompt.system", (e) => e.system + " ${version}")`)
  const system = async (ext: ReturnType<typeof setup>["ext"], project: string) => ext.bus.promptSystem((await ext.ensure(project)).records, { ...ref(project), role: "main", system: "s" })

  test("a syntax error after an edit keeps the previous version running and says so; fixing it replaces it", async () => {
    const { project, ext, userExt, logs } = setup()
    const file = userExt("steady.ts", good("v1"))
    expect(await system(ext, project)).toBe("s v1")
    userExt("steady.ts", "export default { name: 'steady', daemon(api) {")
    ext.invalidateAll()
    const [kept] = await ext.list(project)
    expect(kept).toMatchObject({ name: "steady", file })
    expect(kept!.kept).toContain("load failed")
    expect(await system(ext, project)).toBe("s v1")
    expect(logs.some((line) => line.includes("keeping the previous version"))).toBe(true)
    userExt("steady.ts", good("v2"))
    ext.invalidateAll()
    expect(await system(ext, project)).toBe("s v2")
    expect((await ext.list(project))[0]!.kept).toBeUndefined()
  })

  test("a daemon() that throws after an edit also keeps the previous version", async () => {
    const { project, ext, userExt } = setup()
    userExt("steady.ts", good("v1"))
    expect(await system(ext, project)).toBe("s v1")
    userExt("steady.ts", extension("steady", `throw new Error("setup broke")`))
    ext.invalidateAll()
    expect(await system(ext, project)).toBe("s v1")
    expect((await ext.list(project))[0]!.kept).toContain("setup broke")
  })

  test("a missing helper or a broken helper is reported without importing, and the fix applies on the next reload", async () => {
    const { project, ext, userExt } = setup()
    const withHelper = (version: string) => `import { tag } from "./lib/helper"\nimport { readFileSync } from "node:fs"\nimport type { Nothing } from "./not-there"\nvoid readFileSync\nexport default { name: "steady", daemon(api) { api.on("prompt.system", (e) => e.system + " " + tag + "${version}") } }\n`
    userExt("steady.ts", withHelper("a"))
    const [missing] = await ext.list(project)
    expect(missing!.errors[0]).toContain('cannot resolve "./lib/helper"')
    userExt("lib/helper.ts", "export const tag = 'x' +")
    ext.invalidateAll()
    expect((await ext.list(project))[0]!.errors[0]).toContain("helper.ts:")
    userExt("lib/helper.ts", `export const tag = "t"`)
    ext.invalidateAll()
    expect((await ext.list(project))[0]!.errors).toEqual([])
    expect(await system(ext, project)).toBe("s ta")
  })

  test("an extension that never loaded has nothing to fall back to: the error is the record", async () => {
    const { project, ext, userExt } = setup()
    userExt("never.ts", "export default 5")
    const [record] = await ext.list(project)
    expect(record!.errors[0]).toContain("invalid extension")
    expect(record!.kept).toBeUndefined()
  })

  test("while a reload loads, hooks of a turn in flight still see the old registrations", async () => {
    const { project, ext, userExt } = setup()
    userExt("steady.ts", good("v1"))
    await ext.ensure(project)
    ext.invalidateAll()
    const loading = ext.ensure(project)
    expect(ext.syncScope(project)?.hooks.has("prompt.system")).toBe(true)
    await loading
    expect(ext.syncScope(project)?.hooks.has("prompt.system")).toBe(true)
  })
})

describe("safe disable", () => {
  test("a disabled extension is listed, never run, and registers nothing", async () => {
    const { project, ext, userExt } = setup({ disabled: ["noisy"] })
    userExt("noisy.ts", `${push("imported")}; export default { name: "noisy", daemon(api) { ${push("setup")}; api.on("prompt.system", () => "x"); ${tool("t")} } }`)
    userExt("calm.ts", extension("calm", ""))
    const list = await ext.list(project)
    expect(list.find((entry) => entry.name === "noisy")).toMatchObject({ disabled: true, tools: [], hooks: [], errors: [] })
    expect(calls()).toEqual([])
    expect((await ext.tools(project, "s")).length).toBe(0)
    expect(ext.syncScope(project)?.hooks.size).toBe(0)
  })

  test("a module whose name differs from its file is stopped before daemon() runs", async () => {
    const { project, ext, userExt } = setup({ disabled: ["real-name"] })
    userExt("file.ts", extension("real-name", `${push("setup")}; ${tool("t")}`))
    const [entry] = await ext.list(project)
    expect(entry).toMatchObject({ name: "real-name", disabled: true, tools: [] })
    expect(calls()).toEqual([])
  })
})

describe("context cost per extension", () => {
  test("tool schemas are priced by chars / 4 and rewrite hooks are flagged as unmeasured", async () => {
    const { project, ext, userExt } = setup({ tier: "balanced" })
    userExt("heavy.ts", extension("heavy", `api.registerTool({ name: "big", description: ${JSON.stringify("d".repeat(800))}, parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) }); api.on("prompt.system", (e) => e.system)`))
    userExt("light.ts", extension("light", tool("small")))
    userExt("quiet.ts", extension("quiet", `api.on("turn.end", () => {})`))
    const list = await ext.list(project)
    const heavy = list.find((entry) => entry.name === "heavy")!.context!
    expect(heavy.tokens).toBeGreaterThan(200)
    expect(heavy.tokens).toBe(heavy.tools[0]!.tokens)
    expect(heavy.rewrites).toEqual(["prompt.system"])
    expect(list.find((entry) => entry.name === "light")!.context!.tokens).toBeLessThan(heavy.tokens)
    expect(list.find((entry) => entry.name === "quiet")!.context).toBeUndefined()
    expect(await ext.costs(project)).toEqual([expect.objectContaining({ name: "heavy", tools: 1 }), expect.objectContaining({ name: "light", tools: 1 })])
  })

  test("a tool above the user's tier is not offered, so it costs nothing", async () => {
    const { project, ext, userExt } = setup({ tier: "minimalist" })
    userExt("full.ts", extension("full", `api.registerTool({ name: "pricey", tier: "full", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })`))
    const [entry] = await ext.list(project)
    expect(entry!.context).toMatchObject({ tokens: 0, tools: [{ name: "pricey", offered: false }] })
    expect(await ext.costs(project)).toEqual([])
  })
})

describe("api.toast", () => {
  test("a short note reaches the terminal line: cleaned, cut to 300 characters, level checked", async () => {
    const feedback: Feedback = []
    const { project, ext, userExt } = setup({ feedback })
    userExt("note.ts", extension("note", `api.toast("indexed\\n40  files\\x1b[31m"); api.toast("x".repeat(500), { level: "warning" }); api.toast("odd", { level: "loud" }); api.toast(7); api.toast("   ")`))
    await ext.ensure(project)
    expect(feedback.map((entry) => [entry.extension, entry.level, entry.text.length])).toEqual([["note", "info", 21], ["note", "warning", 300], ["note", "info", 3]])
    expect(feedback[0]!.text).toBe("indexed 40 files [31m")
  })

  test("at most ten notes per window per extension; the rest are dropped", async () => {
    const feedback: Feedback = []
    const { project, ext, userExt } = setup({ feedback })
    userExt("loud.ts", extension("loud", `for (let i = 0; i < 50; i++) api.toast("n" + i)`))
    userExt("other.ts", extension("other", `api.toast("mine")`))
    await ext.ensure(project)
    expect(feedback.filter((entry) => entry.extension === "loud")).toHaveLength(10)
    expect(feedback.filter((entry) => entry.extension === "other")).toHaveLength(1)
  })

  test("without a terminal sink it does nothing and never throws", async () => {
    const { project, ext, userExt } = setup()
    userExt("note.ts", extension("note", `api.toast("hello")`))
    expect((await ext.list(project))[0]!.errors).toEqual([])
  })
})
