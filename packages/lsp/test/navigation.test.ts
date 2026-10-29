import { afterEach, expect, test } from "bun:test"
import { chmodSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULT_SERVERS, createLspClient, createLspManager, createLspTool, loadLspRegistry, localCommand, serverInitialization, serverRoot, type LspManager } from "../src"
import { FAKE_LSP, fakeSpec, put, setupLspTestCleanup, tempDir, until } from "./helpers"

setupLspTestCleanup()

const managers: LspManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.stop())) })
const boot = (env: Record<string, string> = {}, extra = false) => {
  const cwd = tempDir()
  put({ root: cwd, path: "a.fake", content: "function execute() {}" })
  const spec = { ...fakeSpec(), env }
  const manager = createLspManager({ registryLoader: () => ({ servers: extra ? [spec, { ...spec, id: "second" }] : [spec], issues: [] }), settleMs: 10 })
  managers.push(manager)
  return { cwd, manager, input: { filePath: "a.fake", line: 3, character: 7, cwd } }
}
const logOf = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))

test("all nine semantic operations send editor positions, preserve locations, symbols and call data", async () => {
  const log = join(tempDir(), "requests.jsonl")
  const { manager, input, cwd } = boot({ FAKE_LOG: log })
  for (const operation of ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"] as const) {
    const report = await manager.query({ ...input, operation, query: "execute" })
    expect(report.unavailable).toBeUndefined()
    expect(report.result.length).toBeGreaterThan(0)
    if (operation === "goToDefinition") expect(report.result[0]).toMatchObject({ targetUri: pathToFileURL(join(cwd, "a.fake")).href, targetSelectionRange: { start: { line: 1, character: 2 } } })
    if (operation === "documentSymbol") expect(report.result[0]).toMatchObject({ name: "Service", children: [{ name: "execute" }] })
    if (operation === "workspaceSymbol") expect(report.result).toHaveLength(10)
  }
  const received = logOf(log)
  expect(received.filter((entry) => entry.method === "textDocument/didOpen")).toHaveLength(1)
  expect(received.find((entry) => entry.method === "textDocument/definition").params.position).toEqual({ line: 2, character: 6 })
  expect(received.find((entry) => entry.method === "textDocument/references").params.context).toEqual({ includeDeclaration: true })
  expect(received.find((entry) => entry.method === "workspace/symbol").params).toEqual({ query: "execute" })
  expect(received.find((entry) => entry.method === "callHierarchy/incomingCalls").params.item).toMatchObject({ name: "execute", data: { token: "keep-me" } })
  expect(received.find((entry) => entry.method === "initialize").params.capabilities.textDocument).toMatchObject({ definition: { linkSupport: true }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } })
})

test("navigation aggregates overlapping servers and scopes workspace symbols to this project", async () => {
  const { manager, input } = boot({}, true)
  expect((await manager.query({ ...input, operation: "hover" })).result).toHaveLength(2)
  expect((await manager.query({ ...input, operation: "workspaceSymbol" })).result).toHaveLength(20)
  const other = tempDir()
  put({ root: other, path: "b.fake", content: "other" })
  await manager.query({ ...input, cwd: other, filePath: "b.fake", operation: "hover" })
  expect((await manager.query({ ...input, operation: "workspaceSymbol" })).result).toHaveLength(20)
})

test("a failing server does not discard another server's result", async () => {
  const { cwd, input } = boot()
  const manager = createLspManager({ registryLoader: () => ({ servers: [fakeSpec(), { ...fakeSpec(), id: "broken", command: ["/does-not-exist"] }], issues: [] }) })
  managers.push(manager)
  const report = await manager.query({ ...input, cwd, operation: "hover" })
  expect(report.result).toHaveLength(1)
  expect(report.unavailable).toBeUndefined()
  expect(report.issues).toEqual([{ server: "broken", message: expect.stringContaining("not installed") }])
})

test("null hover/hierarchy and an empty workspace query return no results", async () => {
  const { manager, input } = boot({ FAKE_NULL: "1" })
  expect(await manager.query({ ...input, operation: "hover" })).toEqual({ result: [] })
  expect(await manager.query({ ...input, operation: "incomingCalls" })).toEqual({ result: [] })
  expect(await manager.query({ ...input, operation: "outgoingCalls" })).toEqual({ result: [] })
  expect(await manager.query({ ...input, operation: "workspaceSymbol", query: "__empty__" })).toEqual({ result: [] })
})

test("an unsupported request reports the server failure and later requests still work", async () => {
  const { manager, input } = boot()
  expect(await manager.query({ ...input, operation: "workspaceSymbol", query: "__error__" })).toMatchObject({ result: [], unavailable: "fake: Unsupported operation" })
  expect((await manager.query({ ...input, operation: "hover" })).result).toHaveLength(1)
})

test("requests time out and cancellation sends cancelRequest without closing the reusable server", async () => {
  const log = join(tempDir(), "requests.jsonl")
  const { manager, input } = boot({ FAKE_LOG: log, FAKE_HANG: "1" })
  expect(await manager.query({ ...input, operation: "hover", timeoutMs: 40 })).toMatchObject({ result: [], unavailable: expect.stringContaining("timed out after 40 ms") })
  const abort = new AbortController()
  const pending = manager.query({ ...input, operation: "hover", signal: abort.signal })
  await until({ check: () => logOf(log).filter((entry) => entry.method === "textDocument/hover").length === 2 })
  abort.abort()
  expect(await pending).toMatchObject({ result: [], unavailable: "fake: cancelled" })
  await until({ check: () => logOf(log).filter((entry) => entry.method === "$/cancelRequest").length === 2 })
  expect(manager.running()[0]?.pid).toBeGreaterThan(0)
})

test("pre-cancelled, invalid positions, unreadable and external paths start no server", async () => {
  const { manager, input, cwd } = boot()
  const other = put({ root: tempDir(), path: "outside.fake", content: "outside" })
  symlinkSync(other, join(cwd, "link.fake"))
  for (const filePath of [other, "link.fake", "../outside.fake"]) expect(await manager.query({ ...input, filePath, operation: "hover" })).toMatchObject({ unavailable: "file is outside the project" })
  expect(await manager.query({ ...input, filePath: "missing.fake", operation: "hover" })).toMatchObject({ unavailable: expect.stringContaining("cannot read") })
  expect(await manager.query({ ...input, line: 0, operation: "hover" })).toMatchObject({ unavailable: expect.stringContaining("positive integers") })
  expect(await manager.query({ ...input, operation: "hover", signal: AbortSignal.abort() })).toEqual({ result: [], unavailable: "cancelled" })
  expect(manager.running()).toEqual([])
})

test("env and initialization reach the server and workspace/configuration reads dotted sections", async () => {
  const cwd = tempDir(), log = join(cwd, "requests.jsonl")
  const client = createLspClient({ id: "fake", command: [process.execPath, FAKE_LSP], root: cwd, env: { FAKE_LOG: log, FAKE_ENV: "scoped", FAKE_SECTIONS: "1" }, initialization: { python: { analysis: { mode: "strict" } } } })
  try {
    await client.start()
    await until({ check: () => logOf(log).filter((entry) => entry.response).length === 2 })
    expect(logOf(log).find((entry) => entry.method === "initialize")).toMatchObject({ env: "scoped", params: { initializationOptions: { python: { analysis: { mode: "strict" } } } } })
    expect(logOf(log).find((entry) => entry.response === 9001).result).toEqual([{ mode: "strict" }, null])
    expect(logOf(log).find((entry) => entry.method === "workspace/didChangeConfiguration").params).toEqual({ settings: { python: { analysis: { mode: "strict" } } } })
  } finally { await client.close() }
})

test("registry keeps custom env/init, builtin aliases, global disable and download/bootstrap flags", async () => {
  const directory = tempDir()
  put({ root: directory, path: ".mendcode/lsp.json", content: JSON.stringify({ disableDownload: true, servers: { pyright: { env: { TEST: "value" }, initialization: { pythonPath: "/python" }, bootstrap: false }, gopls: { disabled: true }, rust: { disableDownload: true }, wrong: { command: ["x"], extensions: [".wrong"], env: { VALUE: 3 } } } }) })
  const report = await loadLspRegistry({ directory })
  expect(report).toMatchObject({ disableDownload: true, issues: [{ server: "wrong" }] })
  expect(report.servers.find((spec) => spec.id === "python")).toMatchObject({ env: { TEST: "value" }, initialization: { pythonPath: "/python" }, bootstrap: false })
  expect(report.servers.some((spec) => spec.id === "go")).toBe(false)
  put({ root: directory, path: ".mendcode/lsp.json", content: "false" })
  expect((await loadLspRegistry({ directory })).servers).toEqual([])
  put({ root: directory, path: ".mendcode/lsp.json", content: "true" })
  expect((await loadLspRegistry({ directory })).servers).toHaveLength(DEFAULT_SERVERS.length)
  put({ root: directory, path: ".mendcode/lsp.json", content: '{"disabled":true}' })
  expect((await loadLspRegistry({ directory })).servers).toEqual([])
})

test("project/cache bootstrapping is offline and respects bootstrap=false", async () => {
  const cwd = tempDir(), cacheDir = tempDir()
  const spec = { ...fakeSpec(), command: ["test-server", "--stdio"] }
  const cached = put({ root: cacheDir, path: "bin/test-server", content: "#!/bin/sh\n" })
  chmodSync(cached, 0o755)
  expect(await localCommand({ spec, cwd, cacheDir, which: () => null })).toEqual([cached, "--stdio"])
  expect(await localCommand({ spec: { ...spec, bootstrap: false }, cwd, cacheDir, which: () => null })).toBeUndefined()
  const project = put({ root: cwd, path: "node_modules/.bin/test-server", content: "#!/bin/sh\n" })
  chmodSync(project, 0o755)
  expect(await localCommand({ spec, cwd, cacheDir, which: () => null })).toEqual([project, "--stdio"])
})

test("typescript initialization and pyright virtualenv discovery allow explicit overrides", async () => {
  const cwd = tempDir()
  const tsserver = put({ root: cwd, path: "node_modules/typescript/lib/tsserver.js", content: "" })
  const python = put({ root: cwd, path: ".venv/bin/python", content: "" })
  expect(await serverInitialization({ spec: { ...fakeSpec(), id: "typescript" }, root: cwd, cwd })).toEqual({ tsserver: { path: tsserver } })
  expect(await serverInitialization({ spec: { ...fakeSpec(), id: "python" }, root: cwd, cwd })).toEqual({ pythonPath: python })
  expect(await serverInitialization({ spec: { ...fakeSpec(), id: "python", initialization: { pythonPath: "/chosen/python" } }, root: cwd, cwd })).toEqual({ pythonPath: "/chosen/python" })
})

test("go.work and Rust workspace roots take precedence over nested modules/crates", async () => {
  const cwd = tempDir(), file = put({ root: cwd, path: "pkg/src/a.rs", content: "" })
  put({ root: cwd, path: "Cargo.toml", content: "[workspace]\nmembers = [\"pkg\"]" })
  put({ root: cwd, path: "pkg/Cargo.toml", content: "[package]" })
  expect(await serverRoot({ file, cwd, spec: { ...fakeSpec(), id: "rust", rootMarkers: ["Cargo.toml"] } })).toBe(cwd)
  put({ root: cwd, path: "go.work", content: "" })
  put({ root: cwd, path: "pkg/go.mod", content: "" })
  expect(await serverRoot({ file, cwd, spec: { ...fakeSpec(), id: "go", rootMarkers: ["go.work", "go.mod"] } })).toBe(cwd)
})

test("lsp tool formats success, no results and unavailability, preserving diagnostics separately", async () => {
  const { manager, input, cwd } = boot()
  const tool = createLspTool(manager)
  const context = { cwd, signal: new AbortController().signal }
  expect(tool).toMatchObject({ name: "lsp", permission: "read" })
  const success = await tool.execute({ ...input, operation: "hover" }, context)
  expect(success).toMatchObject({ isError: false, title: "hover a.fake:3:7", meta: { available: true, results: 1 } })
  expect(JSON.parse(success.output)[0].contents.value).toContain("execute")
  expect(await tool.execute({ ...input, operation: "workspaceSymbol", query: "__empty__" }, context)).toMatchObject({ output: "No results found for workspaceSymbol", isError: false })
  expect(await tool.execute({ ...input, filePath: "gone.fake", operation: "hover" }, context)).toMatchObject({ isError: true, output: expect.stringContaining("LSP unavailable") })
})
