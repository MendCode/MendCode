import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers } from "@mendcode/packages"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { createExtensions, createPromptFiles, systemPartsWith } from "../src/extensions"

const dirs: string[] = []
const calls = () => ((globalThis as { __extCalls?: string[] }).__extCalls ??= [])
beforeEach(() => {
  ;(globalThis as { __extCalls?: string[] }).__extCalls = []
})
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `ext-${label}-`)))
  dirs.push(dir)
  return dir
}

function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

/** An extension module whose daemon half runs `body` with `api` in scope. */
const extension = (name: string, body: string) => `export default { name: ${JSON.stringify(name)}, daemon(api) { ${body} } }\n`
const log = (entry: string) => `globalThis.__extCalls.push(${JSON.stringify(entry)})`

function setup(options: { trusted?: boolean; timeoutMs?: number; breakerThreshold?: number; disabled?: string[]; tier?: "minimalist" | "balanced" | "full"; feedback?: Array<{ extension: string; text: string; level: string }> } = {}) {
  const user = tmp("user")
  const project = tmp("project")
  const state = { trusted: options.trusted ?? true }
  const logs: string[] = []
  const notices: Array<[string, string]> = []
  const ext = createExtensions({
    dataDir: user,
    layersFor: (directory) => extensionLayers({ userDir: user, directory }),
    isTrusted: () => state.trusted,
    notify: (sessionId, text) => void notices.push([sessionId, text]),
    log: (level, message) => void logs.push(`${level}: ${message}`),
    hookTimeoutMs: options.timeoutMs ?? 100,
    builtinTools: () => [builtinEcho],
    ...(options.breakerThreshold ? { breakerThreshold: options.breakerThreshold } : {}),
    isDisabled: (name) => (options.disabled ?? []).includes(name),
    tier: () => options.tier,
    ...(options.feedback ? { feedback: (event: { extension: string; text: string; level: string }) => void options.feedback!.push(event) } : {}),
  })
  return { user, project, state, logs, notices, ext, userExt: (file: string, text: string) => put(user, `extensions/${file}`, text), projectExt: (file: string, text: string) => put(project, `.mendcode/extensions/${file}`, text) }
}

const builtinEcho = defineTool({ name: "echo", description: "echo", permission: "read", args: z.object({ text: z.string() }), execute: async ({ text }) => ({ output: text, truncated: false, title: "echo", isError: false }) })
const ref = (cwd: string) => ({ sessionId: "s1", cwd })
const before = (cwd: string, args: Record<string, unknown>) => ({ ...ref(cwd), turnId: "t1", tool: "x", callId: "c1", args })

describe("extension discovery", () => {
  test("finds files and folders with an index in the user, package and project layers, in layer order", async () => {
    const { user, project, ext, userExt, projectExt } = setup()
    userExt("b-user.ts", extension("user-b", ""))
    userExt("a-user/index.ts", extension("user-a", ""))
    userExt("notes.md", "not code")
    userExt("types.d.ts", "export {}")
    userExt("empty-dir/readme.md", "no index")
    put(user, "packages/up/extensions/pkg.js", "export default { name: 'user-pkg', daemon() {} }")
    put(project, ".mendcode/packages/pp/extensions/ppkg.ts", extension("project-pkg", ""))
    projectExt("proj.ts", extension("project-own", ""))
    const list = await ext.list(project)
    expect(list.map((e) => [e.name, e.source])).toEqual([
      ["user-pkg", "package"],
      ["user-a", "user"],
      ["user-b", "user"],
      ["project-pkg", "package"],
      ["project-own", "project"],
    ])
    expect(list.every((e) => e.trusted && e.daemon && !e.tui && e.errors.length === 0)).toBe(true)
    expect(list[1]!.file).toBe(path.join(user, "extensions", "a-user", "index.ts"))
  })

  test("a project without extension files loads nothing and lists nothing", async () => {
    const { project, ext } = setup()
    expect(await ext.list(project)).toEqual([])
    expect(ext.syncScope(project)?.records).toEqual([])
  })

  test("an untrusted project's extensions are listed but never imported until the directory is trusted", async () => {
    const { project, ext, state, projectExt, userExt } = setup({ trusted: false })
    projectExt("p.ts", extension("proj", `${log("project-imported")}; api.registerTool({ name: "p_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })`))
    userExt("u.ts", extension("usr", log("user-imported")))
    const before = await ext.list(project)
    expect(before.map((e) => [e.name, e.trusted, e.daemon, e.tools])).toEqual([
      ["usr", true, true, []],
      ["p", false, false, []],
    ])
    expect(calls()).toEqual(["user-imported"])
    expect(await ext.tools(project, "s1")).toEqual([])
    state.trusted = true
    ext.invalidateProject()
    const after = await ext.list(project)
    expect(after.map((e) => [e.name, e.trusted, e.daemon, e.tools])).toEqual([
      ["usr", true, true, []],
      ["proj", true, true, ["p_tool"]],
    ])
    // User extensions load once for the whole daemon; only the project's were loaded again.
    expect(calls()).toEqual(["user-imported", "project-imported"])
    state.trusted = false
    ext.invalidateProject()
    expect((await ext.list(project)).map((e) => [e.name, e.trusted])).toEqual([["usr", true], ["p", false]])
  })

  test("user extensions are shared by every directory; project ones are per directory", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt("u.ts", extension("usr", log("user-imported")))
    projectExt("p.ts", extension("proj", ""))
    const other = tmp("other")
    await ext.list(project)
    expect((await ext.list(other)).map((e) => e.name)).toEqual(["usr"])
    await ext.list(project)
    expect(calls()).toEqual(["user-imported"])
  })

  test("invalid modules are recorded as errors, never thrown, and do not stop the others", async () => {
    const { project, ext, userExt } = setup()
    userExt("1-no-default.ts", "export const x = 1")
    userExt("2-bad-name.ts", "export default { name: '../escape', daemon() {} }")
    userExt("3-bad-daemon.ts", "export default { name: 'bad-daemon', daemon: 3 }")
    userExt("4-syntax.ts", "export default {{{")
    userExt("5-throws-in-setup.ts", extension("setup-throws", "throw new Error('boom in setup')"))
    userExt("6-good.ts", extension("good", log("good")))
    const list = await ext.list(project)
    expect(list.map((e) => e.name)).toEqual(["1-no-default", "2-bad-name", "3-bad-daemon", "4-syntax", "setup-throws", "good"])
    expect(list[0]!.errors[0]).toContain("default export")
    expect(list[1]!.errors[0]).toContain("invalid extension")
    expect(list[2]!.errors[0]).toContain("functions")
    expect(list[3]!.errors[0]).toContain("load failed")
    expect(list[4]!.errors).toEqual(["daemon(): boom in setup"])
    expect(list[5]!.errors).toEqual([])
    expect(calls()).toEqual(["good"])
  })

  test("a first setup that fails after registering publishes nothing: no tool, command, hook, auth or provider, and the error is listed", async () => {
    const { project, ext, userExt } = setup()
    userExt("half.ts", extension("half", `
      api.on("prompt.system", () => ({ append: "HALF" }))
      api.on("input", () => { ${log("half-input")} })
      api.registerTool({ name: "half_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })
      api.registerCommand({ name: "half", description: "d", run: () => ({ notice: "half" }) })
      api.registerAuth({ provider: "half-auth", methods: [{ type: "api", label: "Key" }] })
      api.registerProvider({ id: "half-auth", models: () => ({}) })
      throw new Error("setup died")`))
    userExt("whole.ts", extension("whole", `api.registerTool({ name: "whole_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })`))
    const report = await ext.report(project)
    const half = report.extensions.find((entry) => entry.name === "half")!
    expect(half.errors).toEqual(["daemon(): setup died"])
    expect(half.tools).toEqual([])
    expect(half.commands).toEqual([])
    expect(half.hooks).toEqual([])
    expect(half.authProvider).toBeUndefined()
    expect(half.provider).toBeUndefined()
    expect((await ext.toolOwners(project)).get("half_tool")).toBeUndefined()
    expect((await ext.toolOwners(project)).get("whole_tool")).toBe("whole")
    expect((await ext.tools(project, "s1")).map((tool) => tool.name)).toEqual(["whole_tool"])
    expect(await ext.hasCommand(project, "half")).toBe(false)
    expect(await ext.authMethods(project)).toEqual([])
    expect(await ext.providerModels(project)).toEqual([])
    expect(await ext.routeInput(ref(project), "/half")).toEqual({ kind: "submit", text: "/half" })
    expect(calls()).toEqual([])
    expect((await ext.syncScope(project)!.hooks.has("prompt.system"))).toBe(false)
  })

  test("a registration made after a failed setup finished is refused, so a late callback cannot publish into the scope", async () => {
    const { project, ext, userExt } = setup()
    userExt("late.ts", extension("late", `setTimeout(() => { api.registerTool({ name: "late_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) }) }, 20); throw new Error("setup died")`))
    expect((await ext.report(project)).extensions[0]!.errors).toEqual(["daemon(): setup died"])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect((await ext.toolOwners(project)).get("late_tool")).toBeUndefined()
    expect((await ext.list(project))[0]!.tools).toEqual([])
  })

  test("only the daemon half runs; the tui half is reported, never called", async () => {
    const { project, ext, userExt } = setup()
    userExt("both.ts", `export default { name: "both", daemon() { ${log("daemon")} }, tui() { ${log("tui")} } }`)
    userExt("tui-only.ts", `export default { name: "tui-only", tui() { ${log("tui-only")} } }`)
    const list = await ext.list(project)
    expect(list.map((e) => [e.name, e.daemon, e.tui])).toEqual([["both", true, true], ["tui-only", false, true]])
    expect(calls()).toEqual(["daemon"])
  })

  test("a disabled feature set (enabled: false) discovers and imports nothing", async () => {
    const user = tmp("user")
    const project = tmp("project")
    put(user, "extensions/u.ts", extension("usr", log("imported")))
    const ext = createExtensions({ dataDir: user, layersFor: (directory) => extensionLayers({ userDir: user, directory }), isTrusted: () => true, notify: () => {}, enabled: false })
    expect(await ext.list(project)).toEqual([])
    expect(await ext.tools(project, "s1")).toEqual([])
    expect(await ext.routeInput(ref(project), "hello")).toEqual({ kind: "submit", text: "hello" })
    expect(calls()).toEqual([])
  })

  test("api.dataDir is created on first access under the data dir; api.notify reaches the session notice queue; api.log is tagged", async () => {
    const { user, project, ext, userExt, notices, logs } = setup()
    userExt("data.ts", extension("data-ext", `globalThis.__dataDir = () => api.dataDir; api.on("turn.end", () => { api.notify("s9", "done"); api.log("info", "hello log") })`))
    await ext.list(project)
    const dataDir = path.join(user, "extensions-data", "data-ext")
    expect(existsSync(dataDir)).toBe(false)
    expect((globalThis as unknown as { __dataDir: () => string }).__dataDir()).toBe(dataDir)
    expect(existsSync(dataDir)).toBe(true)
    await ext.fire("turn.end", project, { ...ref(project), turnId: "t1", outcome: "completed" })
    expect(notices).toEqual([["s9", "done"]])
    expect(logs).toEqual(["info: [EXTENSIONS]: data-ext: hello log"])
  })
})

describe("hook bus", () => {
  test("tool.before: args rewrites chain in layer order and the first block wins", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt("a.ts", extension("a", `api.on("tool.before", (e) => { ${"globalThis.__extCalls.push('a:' + JSON.stringify(e.args))"}; return { args: { n: e.args.n + 1 } } })`))
    userExt("b.ts", extension("b", `api.on("tool.before", (e) => { globalThis.__extCalls.push('b:' + JSON.stringify(e.args)); return { args: { n: e.args.n + 10 } } })`))
    projectExt("c.ts", extension("c", `api.on("tool.before", (e) => { globalThis.__extCalls.push('c:' + JSON.stringify(e.args)); return e.args.n > 10 ? { block: "too big" } : undefined })`))
    projectExt("d.ts", extension("d", `api.on("tool.before", () => { ${log("d")} })`))
    const scope = await ext.ensure(project)
    expect(await ext.bus.toolBefore(scope.records, before(project, { n: 1 }))).toEqual({ block: "too big" })
    expect(calls()).toEqual(['a:{"n":1}', 'b:{"n":2}', 'c:{"n":12}'])
    calls().length = 0
    // Without the blocker the rewrites are what comes out.
    expect(await ext.bus.toolBefore(scope.records.slice(0, 2), before(project, { n: 1 }))).toEqual({ args: { n: 12 } })
    expect(await ext.bus.toolBefore([], before(project, { n: 1 }))).toBeUndefined()
  })

  test("tool.after: output and isError rewrites chain", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt("a.ts", extension("a", `api.on("tool.after", (e) => ({ output: e.output + " [a]" }))`))
    projectExt("b.ts", extension("b", `api.on("tool.after", (e) => ({ output: e.output + " [b]", isError: !e.isError }))`))
    const scope = await ext.ensure(project)
    const result = await ext.bus.toolAfter(scope.records, { ...before(project, {}), output: "raw", isError: false })
    expect(result).toEqual({ output: "raw [a] [b]", isError: true })
  })

  test("prompt.system, context and request.before each see the previous handler's result", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt("a.ts", extension("a", `api.on("prompt.system", (e) => e.system + " A"); api.on("context", (e) => [...e.messages, { role: "user", content: "from a" }]); api.on("request.before", (e) => ({ ...e.body, a: 1 }))`))
    projectExt("b.ts", extension("b", `api.on("prompt.system", (e) => e.system + " B"); api.on("context", (e) => e.messages.map((m) => ({ ...m, content: m.content + "!" }))); api.on("request.before", (e) => ({ ...e.body, b: e.body.a + 1 }))`))
    const scope = await ext.ensure(project)
    expect(await ext.bus.promptSystem(scope.records, { ...ref(project), role: "main", system: "base" })).toBe("base A B")
    expect(await ext.bus.context(scope.records, { ...ref(project), role: "main", messages: [{ role: "user", content: "hi" }] })).toEqual([
      { role: "user", content: "hi!" },
      { role: "user", content: "from a!" },
    ])
    expect(await ext.bus.requestBefore(scope.records, { ...ref(project), provider: "p", model: "m", body: { model: "m" } })).toEqual({ model: "m", a: 1, b: 2 })
  })

  test("a handler that throws, rejects or returns the wrong shape is skipped and recorded; the next handler still runs", async () => {
    const { project, ext, userExt, logs } = setup()
    userExt("a-throws.ts", extension("thrower", `api.on("prompt.system", () => { throw new Error("nope") }); api.on("prompt.system", async () => { throw new Error("later") })`))
    userExt("b-wrong.ts", extension("wrong", `api.on("prompt.system", () => 42); api.on("context", () => [{ role: "robot" }])`))
    userExt("c-fine.ts", extension("fine", `api.on("prompt.system", (e) => e.system + " ok")`))
    const scope = await ext.ensure(project)
    expect(await ext.bus.promptSystem(scope.records, { ...ref(project), role: "main", system: "base" })).toBe("base ok")
    expect(await ext.bus.context(scope.records, { ...ref(project), role: "main", messages: [] })).toBeUndefined()
    const list = await ext.list(project)
    expect(list[0]!.errors).toEqual(["prompt.system: nope", "prompt.system: later"])
    expect(list[1]!.errors).toEqual(["prompt.system: returned a value of the wrong shape; ignored", "context: returned a value of the wrong shape; ignored"])
    expect(list[2]!.errors).toEqual([])
    // One log line per extension, however many errors it raised.
    expect(logs.filter((line) => line.includes("thrower"))).toHaveLength(1)
    expect(logs.filter((line) => line.includes("wrong"))).toHaveLength(1)
  })

  test("a handler that exceeds the time limit is skipped and recorded, and the chain continues", async () => {
    const { project, ext, userExt } = setup({ timeoutMs: 40 })
    userExt("a-slow.ts", extension("slow", `api.on("input", async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return { handled: true } })`))
    userExt("b-next.ts", extension("next", `api.on("input", (e) => ({ text: e.text + " next" }))`))
    const started = Date.now()
    expect(await ext.routeInput(ref(project), "go")).toEqual({ kind: "submit", text: "go next" })
    expect(Date.now() - started).toBeLessThan(300)
    expect((await ext.list(project))[0]!.errors).toEqual(["input: timed out after 40 ms"])
  })

  test("only the first 20 errors of an extension are kept", async () => {
    const { project, ext, userExt } = setup({ breakerThreshold: 1000 })
    userExt("noisy.ts", extension("noisy", `api.on("prompt.system", () => { throw new Error("again") })`))
    const scope = await ext.ensure(project)
    for (let i = 0; i < 30; i++) await ext.bus.promptSystem(scope.records, { ...ref(project), role: "main", system: "s" })
    expect((await ext.list(project))[0]!.errors).toHaveLength(20)
  })

  test("compact.before: the first cancel or summary wins; compact.after and observers run for all", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt("a.ts", extension("a", `api.on("compact.before", () => undefined); api.on("compact.after", (e) => { ${log("after-a")} })`))
    userExt("b.ts", extension("b", `api.on("compact.before", (e) => ({ summary: "made by b for " + e.reason })); api.on("compact.after", (e) => { globalThis.__extCalls.push("after-b:" + e.summary) })`))
    projectExt("c.ts", extension("c", `api.on("compact.before", () => ({ cancel: true }))`))
    const scope = await ext.ensure(project)
    expect(await ext.bus.compactBefore(scope.records, { ...ref(project), reason: "manual", tokens: 10 })).toEqual({ summary: "made by b for manual" })
    await ext.bus.notify(scope.records, "compact.after", { ...ref(project), summary: "S" })
    expect(calls()).toEqual(["after-a", "after-b:S"])
  })
})

describe("input routing", () => {
  test("input hooks rewrite the text in order; the first handled swallows it with a notice", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt("a.ts", extension("a", `api.on("input", (e) => ({ text: e.text.toUpperCase() }))`))
    userExt("b.ts", extension("b", `api.on("input", (e) => (e.text === "SWALLOW" ? { handled: true, notice: "swallowed" } : { text: e.text + "?" }))`))
    projectExt("c.ts", extension("c", `api.on("input", () => { ${log("c")} })`))
    expect(await ext.routeInput(ref(project), "hello")).toEqual({ kind: "submit", text: "HELLO?" })
    expect(calls()).toEqual(["c"])
    calls().length = 0
    expect(await ext.routeInput(ref(project), "swallow")).toEqual({ kind: "handled", notice: "swallowed" })
    expect(calls()).toEqual([])
  })

  test("extension commands: prompt becomes the message, notice is shown, nothing starts no turn; arguments are passed whole", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt(
      "cmds.ts",
      extension(
        "cmds",
        `api.registerCommand({ name: "Ask", description: "ask it", run: (args, ctx) => ({ prompt: "Please " + args + " in " + ctx.cwd }) })
         api.registerCommand({ name: "say", description: "say it", run: (args) => ({ notice: "said " + args }) })
         api.registerCommand({ name: "quiet", description: "no output", run: () => {} })
         api.registerCommand({ name: "boom", description: "throws", run: () => { throw new Error("kaput") } })
         api.registerCommand({ name: "BAD NAME", description: "x", run: () => {} })`,
      ),
    )
    projectExt("over.ts", extension("over", `api.registerCommand({ name: "say", description: "project say", run: () => ({ notice: "project said" }) })`))
    expect(await ext.routeInput(ref(project), "/ask  refactor the parser ")).toEqual({ kind: "submit", text: `Please refactor the parser in ${project}` })
    expect(await ext.routeInput(ref(project), "/say hi")).toEqual({ kind: "handled", notice: "project said" })
    expect(await ext.routeInput(ref(project), "/quiet")).toEqual({ kind: "handled" })
    expect(await ext.routeInput(ref(project), "/boom")).toEqual({ kind: "handled", notice: "/boom failed; /extensions lists the error" })
    expect(await ext.routeInput(ref(project), "/unknown x")).toEqual({ kind: "submit", text: "/unknown x" })
    expect(await ext.routeInput(ref(project), "plain text")).toEqual({ kind: "submit", text: "plain text" })
    const list = await ext.list(project)
    expect(list[0]!.commands).toEqual(["ask", "quiet", "boom"])
    expect(list[0]!.errors.some((e) => e.includes("command names"))).toBe(true)
    expect(list[0]!.errors.some((e) => e.includes("/boom: kaput"))).toBe(true)
    expect(list[1]!.commands).toEqual(["say"])
    expect((await ext.commandEntries(project)).map((c) => [c.name, c.source, c.description, c.body])).toEqual([
      ["ask", "user", "ask it", ""],
      ["say", "project", "project say", ""],
      ["quiet", "user", "no output", ""],
      ["boom", "user", "throws", ""],
    ])
  })
})

describe("extension tools", () => {
  test("new tools go to the model with their own JSON schema and accept any object; bad tools and clashes are errors", async () => {
    const { project, ext, userExt, projectExt } = setup()
    userExt(
      "tools.ts",
      extension(
        "tools",
        `api.registerTool({ name: "greet", description: "greets", parameters: { type: "object", properties: { who: { type: "string" } } }, permission: "read", execute: async (args, ctx) => ({ output: "hello " + args.who + " from " + ctx.sessionId, title: "Greet", meta: { n: 1, bad: {} } }) })
         api.registerTool({ name: "echo", description: "clashes with a built-in", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })
         api.registerTool({ name: "mcp__nope", description: "reserved", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })
         api.registerTool({ name: "no schema", description: "bad name", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })
         api.registerTool({ name: "bad_params", description: "d", parameters: "nope", permission: "read", execute: async () => ({ output: "x" }) })`,
      ),
    )
    projectExt("dup.ts", extension("dup", `api.registerTool({ name: "greet", description: "second", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })`))
    const tools = await ext.tools(project, "sess-1")
    expect(tools.map((t) => t.name)).toEqual(["greet"])
    const greet = tools[0]!
    expect(greet.jsonSchema).toEqual({ type: "object", properties: { who: { type: "string" } } })
    expect(greet.args.safeParse({ who: "a", extra: 1 }).success).toBe(true)
    expect(greet.args.safeParse("not an object").success).toBe(false)
    const result = await greet.execute({ who: "Ana" }, { cwd: project, signal: new AbortController().signal })
    expect(result).toMatchObject({ output: "hello Ana from sess-1", title: "Greet", isError: false, meta: { n: 1 } })
    expect(result.meta).toEqual({ n: 1 })
    const list = await ext.list(project)
    expect(list[0]!.tools).toEqual(["greet"])
    expect(list[0]!.errors).toHaveLength(4)
    expect(list[0]!.errors.join("\n")).toContain("echo is a built-in tool")
    expect(list[0]!.errors.join("\n")).toContain("mcp__nope is reserved")
    expect(list[1]!.tools).toEqual([])
    expect(list[1]!.errors[0]).toContain("greet is already registered by tools")
  })

  test("override replaces a built-in for the directory; builtinTool wraps the built-in; failures and bad results become tool errors", async () => {
    const { project, ext, userExt } = setup()
    userExt(
      "wrap.ts",
      extension(
        "wrap",
        `const inner = api.builtinTool("echo")
         globalThis.__inner = inner
         api.registerTool({ name: "echo", description: "loud echo", parameters: inner.parameters, permission: inner.permission, override: true, execute: async (args, ctx) => { const r = await inner.execute(args, ctx); return { ...r, output: r.output.toUpperCase() } } })
         api.registerTool({ name: "throws", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => { throw new Error("kaput") } })
         api.registerTool({ name: "garbage", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => "just a string" })
         api.registerTool({ name: "huge", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x".repeat(200000) }) })`,
      ),
    )
    const tools = await ext.tools(project, "s1")
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(Object.keys(byName)).toEqual(["echo", "throws", "garbage", "huge"])
    expect(byName.echo!.override).toBe(true)
    expect(byName.greet).toBeUndefined()
    const context = { cwd: project, signal: new AbortController().signal }
    expect(await byName.echo!.execute({ text: "quiet" }, context)).toMatchObject({ output: "QUIET", isError: false })
    expect(await byName.echo!.execute({ text: 5 }, context)).toMatchObject({ isError: true })
    expect(await byName.throws!.execute({}, context)).toMatchObject({ isError: true, output: expect.stringContaining("kaput") })
    expect(await byName.garbage!.execute({}, context)).toMatchObject({ isError: true, output: expect.stringContaining("invalid result") })
    const huge = await byName.huge!.execute({}, context)
    expect(huge.truncated).toBe(true)
    expect(huge.output.length).toBeLessThan(60_000)
    const inner = (globalThis as unknown as { __inner: { name: string; parameters: unknown } }).__inner
    expect(inner.name).toBe("echo")
    expect(inner.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } })
    expect((await ext.list(project))[0]!.errors).toEqual([])
  })

  test("registrations after setup finished are refused", async () => {
    const { project, ext, userExt } = setup()
    userExt("late.ts", extension("late", `globalThis.__api = api`))
    await ext.list(project)
    const api = (globalThis as unknown as { __api: { registerTool(tool: unknown): void; on(hook: string, handler: () => void): void } }).__api
    api.on("input", () => {})
    api.registerTool({ name: "late_tool", description: "d", parameters: { type: "object" }, permission: "read", execute: async () => ({ output: "x" }) })
    const [info] = await ext.list(project)
    expect(info!.hooks).toEqual([])
    expect(info!.tools).toEqual([])
    expect(info!.errors).toHaveLength(2)
  })
})

describe("prompt files", () => {
  test("project files win over user files; each kind is resolved on its own", () => {
    const user = tmp("user")
    const project = tmp("project")
    put(user, "SYSTEM.md", "user system for {{cwd}}")
    put(user, "APPEND_SYSTEM.md", "user append")
    put(user, "COMPACTION.md", "user compaction")
    put(project, ".mendcode/SYSTEM.md", "project system for {{cwd}}\n")
    put(project, ".mendcode/COMPACTION.md", "   ")
    const files = createPromptFiles({ layersFor: (directory) => extensionLayers({ userDir: user, directory }), enabled: true })
    expect(files.read(project)).toEqual({ system: "project system for {{cwd}}", appendSystem: "user append", compaction: "user compaction" })
    expect(files.read(tmp("other"))).toEqual({ system: "user system for {{cwd}}", appendSystem: "user append", compaction: "user compaction" })
  })

  test("packages sit between the user's folder and the project's own", () => {
    const user = tmp("user")
    const project = tmp("project")
    put(user, "APPEND_SYSTEM.md", "user")
    put(user, "packages/up/APPEND_SYSTEM.md", "user package")
    put(project, ".mendcode/packages/pp/APPEND_SYSTEM.md", "project package")
    const files = createPromptFiles({ layersFor: (directory) => extensionLayers({ userDir: user, directory }), enabled: true })
    expect(files.read(project).appendSystem).toBe("project package")
    put(project, ".mendcode/APPEND_SYSTEM.md", "project")
    expect(files.read(project).appendSystem).toBe("project")
  })

  test("edits apply to the next read; no files and disabled mean no overrides", async () => {
    const user = tmp("user")
    const project = tmp("project")
    const files = createPromptFiles({ layersFor: (directory) => extensionLayers({ userDir: user, directory }), enabled: true })
    expect(files.read(project)).toEqual({})
    put(user, "COMPACTION.md", "one")
    expect(files.read(project).compaction).toBe("one")
    put(user, "COMPACTION.md", "two, longer")
    expect(files.read(project).compaction).toBe("two, longer")
    expect(createPromptFiles({ layersFor: (directory) => extensionLayers({ userDir: user, directory }), enabled: false }).read(project)).toEqual({})
  })

  test("SYSTEM.md replaces the base part (with {{cwd}} filled in) and APPEND_SYSTEM.md is a part of its own after the rest", () => {
    const rest = [{ id: "instructions", label: "project instructions", text: "rules" }]
    const packaged = (root: string) => `packaged for ${root}`
    expect(systemPartsWith({ files: {}, root: "/r", packaged, rest }).map((p) => [p.id, p.text])).toEqual([["base", "packaged for /r"], ["instructions", "rules"]])
    const parts = systemPartsWith({ files: { system: "custom in {{cwd}}", appendSystem: "tail" }, root: "/r", packaged, rest })
    expect(parts.map((p) => [p.id, p.label, p.text])).toEqual([
      ["base", "base prompt (SYSTEM.md)", "custom in /r"],
      ["instructions", "project instructions", "rules"],
      ["append", "appended prompt (APPEND_SYSTEM.md)", "tail"],
    ])
  })
})
