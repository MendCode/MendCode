import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers } from "@mendcode/packages"
import type { ModelInfo } from "@mendcode/protocol"
import { createExtensions } from "../src/extensions"
import type { ExtensionSessionPort } from "../src/extensions"
import { createMcpConfigLoader } from "../src/mcp-loader"
import { createExtensionSessions } from "../src/extension-sessions"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `extreg-${label}-`)))
  dirs.push(dir)
  return dir
}
function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const extension = (name: string, body: string) => `export default { name: ${JSON.stringify(name)}, daemon(api) { ${body} } }\n`

function setup(options: { sessions?: ExtensionSessionPort; trusted?: boolean } = {}) {
  const data = tmp("data")
  const project = tmp("project")
  const ext = () => createExtensions({ dataDir: data, layersFor: (directory) => extensionLayers({ userDir: data, directory }), isTrusted: () => options.trusted ?? true, notify: () => {}, hookTimeoutMs: 2_000, ...(options.sessions ? { sessions: options.sessions } : {}) })
  return { data, project, ext }
}

describe("MCP servers from extensions", () => {
  test("a registered server joins the directory's config with ${VAR} expanded; mcp.json keeps a name it uses; a project extension's server is a project server", async () => {
    const { data, project, ext } = setup()
    put(data, "extensions/jira.ts", extension("jira", `api.registerMcpServer("jira", { url: "https://jira.example.test/mcp", headers: { authorization: "Bearer \${MENDCODE_TEST_JIRA_TOKEN}" } }); api.registerMcpServer("dup", { command: "from-extension" }); api.registerMcpServer("bad__name", { command: "x" }); api.registerMcpServer("both", { command: "a", url: "https://b.test" })`))
    put(project, ".mendcode/extensions/local.ts", extension("local", `api.registerMcpServer("local-db", { command: "db-mcp", args: ["--ro"], cwd: "tools" })`))
    put(data, "mcp.json", JSON.stringify({ servers: { dup: { command: "from-file" } } }))
    const extensions = ext()
    process.env.MENDCODE_TEST_JIRA_TOKEN = "t-123"
    const loader = createMcpConfigLoader({ userDir: data, layers: (directory) => extensionLayers({ userDir: data, directory }), allowed: () => true, trustedDirs: () => [project], extensionServers: (directory) => extensions.mcpServers(directory) })
    const loaded = await loader(project).finally(() => delete process.env.MENDCODE_TEST_JIRA_TOKEN)
    expect(loaded.servers.jira).toMatchObject({ url: "https://jira.example.test/mcp", headers: { authorization: "Bearer t-123" } })
    expect(loaded.servers.dup).toMatchObject({ command: "from-file" })
    expect(loaded.servers["local-db"]).toEqual({ command: "db-mcp", args: ["--ro"], cwd: path.join(project, "tools"), scope: "project" })
    const errors = (await extensions.list(project)).find((entry) => entry.name === "jira")!.errors.join(" | ")
    expect(errors).toContain("no __")
    expect(errors).toContain("exactly one of command")
    expect((await extensions.list(project)).find((entry) => entry.name === "jira")?.mcpServers).toEqual(["jira", "dup"])
    const off = createMcpConfigLoader({ userDir: data, layers: (directory) => extensionLayers({ userDir: data, directory }), allowed: () => false, trustedDirs: () => [project], extensionServers: (directory) => extensions.mcpServers(directory) })
    expect((await off(project)).servers).toEqual({})
  })
})

describe("virtual models", () => {
  const catalog: ModelInfo[] = [
    { id: "fast", name: "Fast", efforts: ["low"], contextWindow: 64_000 },
    { id: "deep", name: "Deep", efforts: ["low", "high"], contextWindow: 200_000 },
    { id: "claude-x", name: "Claude", efforts: [], engine: "claude" },
  ]
  test("listed while one of its models exists; each call goes to the model route picks, else the first; a project extension cannot add one", async () => {
    const { data, project, ext } = setup()
    put(data, "extensions/router.ts", extension("router", `
      api.registerVirtualModel({ id: "auto", name: "Auto", models: ["deep", "fast"], route: ({ role }) => role === "compaction" ? "fast" : role === "plan" ? "claude-x" : role === "boom" ? (() => { throw new Error("no") })() : undefined })
      api.registerVirtualModel({ id: "ghost", models: ["missing"] })
      api.registerVirtualModel({ id: "Bad Id", models: ["fast"] })`))
    put(project, ".mendcode/extensions/p.ts", extension("p", `api.registerVirtualModel({ id: "proj", models: ["fast"] })`))
    const extensions = ext()
    await extensions.ensure(project)
    expect(extensions.virtualModels(catalog)).toEqual([{ id: "virtual:auto", name: "Auto", provider: "virtual", efforts: ["low", "high"], contextWindow: 64_000 }])
    const route = (role: string) => extensions.routeModel({ model: "virtual:auto", effort: "high" }, { sessionId: "s", cwd: project, role }, catalog)
    expect(route("main")).toEqual({ model: "deep", effort: "high" })
    expect(route("compaction").model).toBe("fast")
    // Another engine runs whole sessions, so a route that names one gets the first real model instead.
    expect(route("plan").model).toBe("deep")
    expect(route("boom").model).toBe("deep")
    expect(extensions.routeModel({ model: "fast" }, { sessionId: "s", cwd: project, role: "main" }, catalog)).toEqual({ model: "fast" })
    const listed = await extensions.list(project)
    expect(listed.find((entry) => entry.name === "router")?.virtualModels).toEqual(["virtual:auto", "virtual:ghost"])
    expect(listed.find((entry) => entry.name === "router")?.errors.join(" ")).toContain("route failed")
    expect(listed.find((entry) => entry.name === "p")?.errors.join(" ")).toContain("from a user extension")
  })
})

describe("a project extension acts only on its own project's sessions", () => {
  test("setModel, sendUserMessage and dialogs on another project's session are refused; a user extension may act on any", async () => {
    const other = tmp("other")
    const calls: string[] = []
    let directoryOf = ""
    const sessions: ExtensionSessionPort = {
      directory: (id) => (id === "mine" ? directoryOf : id === "theirs" ? other : undefined),
      model: () => ({ model: "fast" }),
      setModel: async (id) => { calls.push(`model:${id}`); return { ok: true } },
      activeTools: () => undefined,
      setActiveTools: (id) => void calls.push(`tools:${id}`),
      submit: async (id) => { calls.push(`submit:${id}`); return { ok: true } },
    }
    const { data, project, ext } = setup({ sessions })
    directoryOf = project
    put(project, ".mendcode/extensions/p.ts", extension("p", `api.registerCommand({ name: "go", description: "x", run: async () => ({ notice: JSON.stringify([await api.setModel("theirs", "fast"), await api.sendUserMessage("theirs", "hi"), api.setActiveTools("theirs", ["read"]), await api.setModel("mine", "fast"), await api.ui.confirm("theirs", "t", "m", { default: true })]) }) })`))
    put(data, "extensions/u.ts", extension("u", `api.registerCommand({ name: "user", description: "x", run: async () => ({ notice: JSON.stringify(await api.sendUserMessage("theirs", "hi")) }) })`))
    const extensions = ext()
    const routed = await extensions.routeInput({ sessionId: "mine", cwd: project }, "/go")
    const answers = JSON.parse(routed.kind === "handled" ? routed.notice ?? "" : "") as Array<{ ok: boolean; error?: string } | boolean>
    expect(answers.slice(0, 3).map((answer) => (answer as { ok: boolean }).ok)).toEqual([false, false, false])
    expect((answers[0] as { error: string }).error).toContain("its project's sessions")
    expect(answers[3]).toEqual({ ok: true })
    expect(answers[4]).toBe(true)
    const user = await extensions.routeInput({ sessionId: "mine", cwd: project }, "/user")
    expect(user.kind === "handled" ? JSON.parse(user.notice!) : undefined).toEqual({ ok: true })
    expect(calls).toEqual(["model:mine", "submit:theirs"])
  })
})

describe("the daemon's session port", () => {
  test("a tool limit on a session another engine runs is refused, since that engine keeps its own tool list; lifting one always works", () => {
    const configured: unknown[] = []
    const port = createExtensionSessions({
      directory: () => "/p",
      current: () => ({ model: "claude-x" }),
      engineOf: () => "claude",
      catalog: async () => ({ selectable: true, list: () => [], defaults: { model: "x" } }),
      choose: () => {},
      runLimits: { configure: (_id: unknown, limits: unknown) => void configured.push(limits) } as never,
      submit: async () => ({ ok: true }),
    })
    expect(port.setActiveTools("s", ["read"])).toContain("runs on claude")
    expect(port.setActiveTools("s", undefined)).toBeUndefined()
    expect(configured).toEqual([{ activeTools: null }])
  })
})

describe("a hook waiting on a dialog", () => {
  test("is not cut by the hook time limit while the user has the dialog; the answer decides the call", async () => {
    const data = tmp("data")
    const project = tmp("project")
    put(data, "extensions/push.ts", extension("push", `api.on("tool.before", async (e) => (await api.ui.confirm(e.sessionId, "Push", "Allow?", { default: false, timeoutMs: 1000 })) ? undefined : { block: "not allowed" })`))
    const asked: string[] = []
    const extensions = createExtensions({
      dataDir: data, layersFor: (directory) => extensionLayers({ userDir: data, directory }), isTrusted: () => true, notify: () => {}, hookTimeoutMs: 150,
      sessions: { directory: () => project, model: () => undefined, setModel: async () => ({ ok: true }), activeTools: () => undefined, setActiveTools: () => {}, submit: async () => ({ ok: true }) },
      dialogs: { ask: (request) => { asked.push(request.question); return new Promise((resolve) => setTimeout(() => resolve(asked.length === 1 ? "No" : "Yes"), 500)) } },
    })
    const records = (await extensions.ensure(project)).records
    const call = { sessionId: "s", turnId: "t", callId: "c", cwd: project, tool: "shell", args: { command: "git push" } }
    expect(await extensions.bus.toolBefore(records, call)).toEqual({ block: "not allowed" })
    expect(await extensions.bus.toolBefore(records, call)).toBeUndefined()
    expect(asked).toEqual(["Allow?", "Allow?"])
    expect(records[0]!.errors).toEqual([])
  })
})
