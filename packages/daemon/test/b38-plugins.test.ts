import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { extensionLayers } from "@mendcode/packages"
import { createExtensions } from "../src/extensions/loader"
import { createEngineHooks } from "../src/extensions/engine-hooks"
import { installPlugin } from "../src/extensions/plugin-install"
import { createPluginMetadata } from "../src/extensions/plugin-metadata"
import { pluginConfig, pluginSelections, resolvePlugin } from "@mendcode/extension-api/plugin-files"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import { callTool, echoTool, scriptedProvider, stop, turn, writeTool } from "../../engine-native/test/harness"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "b38-")))
  roots.push(root)
  const dataDir = path.join(root, "data")
  const project = path.join(root, "project")
  mkdirSync(dataDir)
  mkdirSync(project)
  const put = (file: string, text: string) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); return target }
  const state = { trusted: true }
  const logs: string[] = []
  const manager = (enabled = true) => createExtensions({ dataDir, layersFor: (directory) => extensionLayers({ userDir: dataDir, directory }), isTrusted: () => state.trusted, enabled, hookTimeoutMs: 100, notify() {}, log: (_level, text) => { logs.push(text) } })
  const configure = (file: string, extra: Record<string, unknown> = {}) => put("data/mendcode.json", JSON.stringify({ pluginCompatibility: true, plugin: [pathToFileURL(file).href], ...extra }))
  return { root, dataDir, project, put, state, logs, manager, configure }
}

test("plugin opt-in, disabled identities, trust and pure mode prevent import", async () => {
  const s = setup()
  const file = s.put("project/.mendcode/guard.ts", 'throw new Error("should not import")')
  const config = "project/.mendcode/mendcode.json"
  s.put(config, JSON.stringify({ plugin: ["./guard.ts"] }))
  expect(await s.manager().list(s.project)).toEqual([])
  s.put(config, JSON.stringify({ pluginCompatibility: true, plugin: ["./guard.ts"] }))
  s.state.trusted = false
  const ext = s.manager()
  expect((await ext.list(s.project))[0]).toMatchObject({ trusted: false, errors: [] })
  s.state.trusted = true
  ext.invalidateProject()
  expect((await ext.list(s.project))[0]!.errors.join(" ")).toContain("should not import")
  s.configure(file)
  expect(await s.manager(false).list(s.project)).toEqual([])
  expect(pluginSelections({ pluginCompatibility: true, plugin: ["demo@1", ["demo@2", { x: 1 }]], disabledPlugins: ["demo"] })).toEqual([])
  expect(pluginSelections({ pluginCompatibility: true, plugin: ["demo@1", ["demo@2", { x: 1 }]] })).toEqual([{ spec: "demo@2", options: { x: 1 } }])
})

test("legacy tool modules import the daemon schema helper and export default and named tools", async () => {
  const s = setup()
  s.put("project/.mendcode/mendcode.json", '{"pluginCompatibility":true}')
  s.put("project/.mendcode/tool/local.ts", `import { tool } from "@mendcode/plugin"
export default tool({ description: "local", args: { text: tool.schema.string() }, permission: "read", async execute(args, ctx) { ctx.metadata({ title: "Local", metadata: { cwd: ctx.directory } }); return args.text } })
export const extra = tool({ description: "extra", args: {}, permission: "read", async execute() { return { output: "extra", metadata: { ok: true } } } })`)
  const ext = s.manager()
  const tools = await ext.tools(s.project, "session-test")
  expect(tools.map((tool) => tool.name)).toEqual(["local", "local_extra"])
  const result = await tools[0]!.execute({ text: "hello" }, { cwd: s.project, signal: new AbortController().signal })
  expect(result).toMatchObject({ output: "hello", title: "Local", meta: { cwd: s.project } })
  expect(tools[0]!.args.safeParse({ text: 1 }).success).toBe(false)
})

test("chat, model, tool, context and compaction hooks affect the native engine", async () => {
  const s = setup()
  const file = s.put("hooks.ts", `export const plugin = async (_api, options) => ({
  "chat.message": async (_i,o) => { o.parts[0].text += options.suffix },
  "chat.params": async (_i,o) => { o.temperature = 0.2; o.topP = 0.8; o.maxOutputTokens = 64 },
  "chat.headers": async (_i,o) => { o.headers["x-plugin"] = "local" },
  "tool.definition": async (_i,o) => { o.description = "Adapted tool" },
  "tool.execute.before": async (_i,o) => { o.args.text = "rewritten" },
  "tool.execute.after": async (_i,o) => { o.output += "!"; o.title = "Plugin tool"; o.metadata = { adapted: true } },
  "experimental.chat.system.transform": async (_i,o) => { o.system.push("ADAPTED") },
  "experimental.chat.messages.transform": async (_i,o) => { o.messages[0].parts[0].text = "context copy" },
  "experimental.text.complete": async (_i,o) => { o.text += "!" },
  "experimental.session.compacting": async (_i,o) => { o.prompt = "PLUGIN COMPACT" },
  "experimental.compaction.autocontinue": async (_i,o) => { o.enabled = false },
  "shell.env": async (_i,o) => { o.env.PLUGIN_TEST = "on" }
})`)
  s.configure(file, { plugin: [[pathToFileURL(file).href, { suffix: " adapted" }]] })
  const ext = s.manager()
  const hooks = createEngineHooks(ext)
  const script = scriptedProvider([callTool("echo", { text: "before" }), stop("answer"), stop("summary")])
  const history = memoryHistory()
  const engine = createNativeEngine({ provider: script.provider, tools: [echoTool], history, hooks, cwdFor: () => s.project, system: () => "BASE", compactionPrompt: "ORIGINAL" })
  const input = turn({ text: "question" })
  expect(await ext.routeInput({ sessionId: input.input.sessionId, cwd: s.project }, "question")).toEqual({ kind: "submit", text: "question adapted" })
  expect(await engine.runTurn(input.input)).toMatchObject({ status: "ok" })
  expect(script.requests[0]).toMatchObject({ system: "BASE\n\nADAPTED", parameters: { temperature: 0.2, top_p: 0.8 }, maxOutputTokens: 64, headers: { "x-plugin": "local" } })
  expect(script.requests[0]!.tools[0]!.description).toBe("Adapted tool")
  expect(script.requests[0]!.messages[0]).toMatchObject({ content: "context copy" })
  expect(script.requests[1]!.messages.some((message) => message.role === "tool" && message.output === "echoed rewritten!")).toBe(true)
  expect(input.events.some((event) => event.type === "item.completed" && event.text === "answer!")).toBe(true)
  expect(await hooks.environment?.({ sessionId: input.input.sessionId, cwd: s.project })).toEqual({ PLUGIN_TEST: "on" })
  expect(await engine.compact(input.input)).toMatchObject({ compacted: true, continueAfterCompact: false })
  // The hook's prompt ends the request that repeats the last call, followed by the engine's no-tool line.
  expect(script.requests[2]!.messages.at(-1)).toMatchObject({ content: "PLUGIN COMPACT\n\nDo not call any tool: reply with the summary text only." })
  expect((await ext.list(s.project))[0]!.errors).toEqual([])
})

test("permission deny hook prevents execution and slash hooks only transform submitted input", async () => {
  const s = setup()
  const file = s.put("deny.ts", `export default async () => ({ "permission.ask": async (_i,o) => { o.status = "deny" }, "command.execute.before": async (_i,o) => { o.parts[0].text += " changed" } })`)
  s.configure(file)
  const ext = s.manager()
  expect(await ext.routeInput({ sessionId: "s", cwd: s.project }, "/")).toEqual({ kind: "submit", text: "/" })
  expect(await ext.routeInput({ sessionId: "s", cwd: s.project }, "/example args")).toEqual({ kind: "submit", text: "/example args changed" })
  const written: string[] = []
  const script = scriptedProvider([callTool("write", { path: "a" }), stop("done")])
  const engine = createNativeEngine({ provider: script.provider, tools: [writeTool(written)], history: memoryHistory(), hooks: createEngineHooks(ext), cwdFor: () => s.project, system: () => "BASE", compactionPrompt: "summarize" })
  const run = turn({ text: "write a", mode: () => "full" })
  await engine.runTurn(run.input)
  expect(written).toEqual([])
  expect(run.asked).toEqual([])
})

test("API and OAuth methods store private credentials and bind a one-use flow to its project", async () => {
  const s = setup()
  const file = s.put("auth.ts", `export default async () => ({ auth: { provider: "local", methods: [
    { type: "api", label: "Key" },
    { type: "oauth", label: "Local OAuth", async authorize() { return { url: "https://auth.example.invalid/login", instructions: "Enter the local test code", method: "code", async callback(code) { return code === "test-code" ? { type: "success", access: "private-access", refresh: "private-refresh", expires: Date.now()+60000 } : { type: "failed" } } } } }
  ], async loader(get) { const auth = await get(); return { headers: { "x-private": auth.type === "api" ? auth.key : auth.access } } } } })`)
  s.configure(file)
  const ext = s.manager()
  expect(await ext.authStart(s.project, "local", 0, { key: "private-key" })).toEqual({ authenticated: true })
  expect(JSON.stringify(await ext.authMethods(s.project))).not.toContain("private-key")
  const headers = await createEngineHooks(ext).headers?.({ sessionId: turn({ text: "" }).input.sessionId, cwd: s.project, provider: "local", model: "local:test", role: "main" })
  expect(headers).toMatchObject({ headers: { authorization: "Bearer private-key", "x-private": "private-key" } })
  const flow = await ext.authStart(s.project, "local", 1, {})
  expect("flowId" in flow).toBe(true)
  const id = (flow as { flowId: string }).flowId
  await expect(ext.authComplete(s.root, id, "test-code")).rejects.toThrow("not found")
  expect(await ext.authComplete(s.project, id, "test-code")).toEqual({ authenticated: true })
  await expect(ext.authComplete(s.project, id, "test-code")).rejects.toThrow("not found")
  expect(statSync(path.join(s.dataDir, "plugin-auth.json")).mode & 0o777).toBe(0o600)
  expect(JSON.stringify(flow)).not.toContain("private-")
})

test("auth exceptions are redacted, missing plugins do not hide working extensions", async () => {
  const s = setup()
  const file = s.put("bad-auth.ts", `export default async () => ({ auth: { provider: "bad", methods: [{ type: "api", label: "Bad", async authorize() { throw new Error("private-auth-token") } }] } })`)
  s.configure(file, { plugin: [pathToFileURL(file).href, "missing@1.0.0"] })
  const ext = s.manager()
  await expect(ext.authStart(s.project, "bad", 0, {})).rejects.toThrow("failed")
  const listed = await ext.list(s.project)
  expect(listed).toHaveLength(2)
  expect(listed[1]!.errors.length).toBe(1)
  expect(JSON.stringify(listed) + s.logs.join(" ")).not.toContain("private-auth-token")
})

test("global plugin instances receive each project's own directory", async () => {
  const s = setup()
  const file = s.put("per-project.ts", `export default async ({directory}) => ({ "chat.message": async (_i,o) => { o.parts[0].text = directory } })`)
  s.configure(file)
  const ext = s.manager()
  expect(await ext.routeInput({ sessionId: "one", cwd: s.project }, "hello")).toEqual({ kind: "submit", text: s.project })
  expect(await ext.routeInput({ sessionId: "two", cwd: s.root }, "hello")).toEqual({ kind: "submit", text: s.root })
})

test("provider model hooks expose native model ids and isolate model loader failures", async () => {
  const s = setup()
  const file = s.put("models.ts", `export default async () => ({ provider: { id: "local", async models() { return { small: { name: "Local small", limit: {context: 8192} } } } } })`)
  s.configure(file)
  expect(await s.manager().providerModels(s.project)).toEqual([{ id: "local:small", name: "Local small", provider: "local", efforts: [], contextWindow: 8192 }])
})

test("local installation, global/force replacement, JSONC backup and atomic failure", async () => {
  const s = setup()
  const file = s.put("local plugin.ts", "export default async () => ({})")
  s.put("data/mendcode.jsonc", '// retained in backup\n{"theme":"terminal", "plugin":[["demo@1.0.0", {"option":true}]],}')
  const installed = await installPlugin({ dataDir: s.dataDir, directory: s.project, spec: file, global: true })
  expect(installed).toMatchObject({ mode: "add", scope: "user" })
  expect(pluginConfig(s.dataDir).value.theme).toBe("terminal")
  expect(existsSync(path.join(s.dataDir, "plugin-config-backups"))).toBe(true)
  const before = readFileSync(installed.file, "utf8")
  await expect(installPlugin({ dataDir: s.dataDir, directory: s.project, spec: "./missing.ts", global: true })).rejects.toThrow()
  expect(readFileSync(installed.file, "utf8")).toBe(before)
  expect(await installPlugin({ dataDir: s.dataDir, directory: s.project, spec: installed.spec, global: true })).toMatchObject({ mode: "noop" })
  const calls: string[] = []
  const replacement = await installPlugin({ dataDir: s.dataDir, directory: s.project, spec: "demo@^2", global: true, force: true, resolveNpm: async (spec) => {
    calls.push(spec)
    s.put("data/plugin-cache/node_modules/demo/package.json", '{"name":"demo","version":"2.0.0","exports":{"./server":"./server.ts","./tui":"./tui.ts"}}')
    s.put("data/plugin-cache/node_modules/demo/server.ts", 'export default async () => ({})')
    s.put("data/plugin-cache/node_modules/demo/tui.ts", 'export default { id: "demo", activate() {} }')
  } })
  expect(calls).toEqual(["demo@^2"])
  expect(replacement).toMatchObject({ mode: "replace", spec: "demo@2.0.0", targets: ["server", "tui"] })
  expect((pluginConfig(s.dataDir).value.plugin as unknown[])[0]).toEqual(["demo@2.0.0", { option: true }])
  expect(resolvePlugin("demo@2.0.0", s.dataDir, s.dataDir, "tui")).toEndWith("tui.ts")
  expect(() => resolvePlugin("demo@1.0.0", s.dataDir, s.dataDir, "server")).toThrow("differs")
})

test("session metadata persists, separates namespaces, deletes null keys and bounds patches", () => {
  const s = setup()
  const metadata = createPluginMetadata(s.dataDir)
  expect(metadata.patch("one", "session", { status: "review", count: 2 })).toEqual({ status: "review", count: 2 })
  expect(metadata.get("two", "session")).toEqual({})
  expect(createPluginMetadata(s.dataDir).get("one", "session")).toEqual({ status: "review", count: 2 })
  expect(metadata.patch("one", "session", { count: null })).toEqual({ status: "review" })
  expect(metadata.list("one", ["session", "other"])).toEqual([{ sessionID: "session", metadata: { status: "review" } }])
  expect(() => metadata.patch("one", "session", { long: "x".repeat(40_000) })).toThrow("32 KB")
  expect(() => metadata.patch("one", "session", JSON.parse('{"__proto__":{}}'))).toThrow("invalid")
})
