import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LoadedMcpConfig, McpManager } from "@mendcode/mcp"
import type { LoopService } from "@mendcode/loops"
import { createIdFactory } from "@mendcode/protocol"
import { createVirtualClock } from "@mendcode/kernel"
import { createLazyMcp } from "../src/lazy-mcp"
import { createLazyLsp } from "../src/lazy-lsp"
import { createLazyLoops } from "../src/lazy-loops"
import { createLazyCodegraph } from "../src/lazy-codegraph"

test("empty MCP discovery, invalidation and shutdown do not create a manager", async () => {
  let loads = 0
  let reads = 0
  const errors = [{ source: "config", message: "invalid file" }]
  const mcp = createLazyMcp({ configLoader: () => { reads++; return { servers: {}, errors } }, load: async () => { loads++; throw new Error("must stay cold") } })
  expect(mcp.running()).toEqual([])
  expect(mcp.cachedPrompts("project")).toEqual([])
  expect(await mcp.catalog("project")).toEqual({ resources: [], templates: [], prompts: [], issues: errors })
  expect(await mcp.listTools("project")).toEqual({ tools: [], issues: errors })
  expect(await mcp.listPrompts("project")).toEqual({ prompts: [], issues: errors })
  expect(reads).toBe(1)
  expect(await mcp.status("project")).toEqual({ servers: [], issues: errors })
  expect(reads).toBe(2)
  await mcp.catalog("other")
  await mcp.invalidate("project")
  await mcp.catalog("other")
  expect(reads).toBe(4)
  await mcp.suspend({ server: "none" })
  await mcp.catalog("other")
  expect(reads).toBe(5)
  await mcp.stop()
  expect(loads).toBe(0)
})

test("MCP loads once after configuration changes; concurrent requests share the real manager", async () => {
  let loads = 0
  let config: LoadedMcpConfig = { servers: {}, errors: [] }
  let real: McpManager | undefined
  const mcp = createLazyMcp({ configLoader: () => config, load: async (configLoader) => {
    loads++
    const { createMcpManager } = await import("@mendcode/mcp")
    return real = createMcpManager({ configLoader })
  } })
  expect(await mcp.listTools("project")).toEqual({ tools: [], issues: [] })
  config = { servers: { disabled: { command: "not-a-real-server", enabled: false } }, errors: [] }
  await mcp.invalidate("project")
  const [status, catalog] = await Promise.all([mcp.status("project"), mcp.catalog("project")])
  expect(loads).toBe(1)
  expect(status).toEqual(await real!.status("project"))
  expect(catalog).toEqual(await real!.catalog("project"))
  expect(mcp.running()).toEqual([])
  await mcp.stop()
})

test("MCP blocked project servers keep trust diagnostics without connecting", async () => {
  const config: LoadedMcpConfig = { servers: {}, errors: [], blocked: [{ name: "held", command: "server", source: "project" }] }
  const mcp = createLazyMcp({ configLoader: () => config, load: async (configLoader) => (await import("@mendcode/mcp")).createMcpManager({ configLoader }) })
  expect(await mcp.status("project")).toMatchObject({ servers: [{ name: "held", needsTrust: true, state: "stopped" }], issues: [{ server: "held", message: expect.stringContaining("needs project trust") }] })
  expect(mcp.running()).toEqual([])
  await mcp.stop()
})

test("empty loop reads stay cold; concurrent loads start once with observers already wired", async () => {
  let loads = 0
  let starts = 0
  let observed = 0
  const host = createLazyLoops(async () => {
    loads++
    return {
      start() { starts++; host.service.observe({} as never) },
      observe() { observed++ },
      list: () => [],
      dispose() {},
    } as unknown as LoopService
  })
  expect(host.service.list()).toEqual([])
  expect(host.service.reportOnlySession("session" as never)).toBe(false)
  expect(host.service.forSession("session" as never)).toBeUndefined()
  expect(loads).toBe(0)
  const [a, b] = await Promise.all([host.load(), host.load()])
  expect(a).toBe(b)
  expect({ loads, starts, observed }).toEqual({ loads: 1, starts: 1, observed: 1 })
  host.service.dispose()
})

test("loop disposal during loading never starts a scheduler", async () => {
  let release!: (service: LoopService) => void
  let starts = 0
  let disposals = 0
  const host = createLazyLoops(() => new Promise((resolve) => { release = resolve }))
  const pending = host.load()
  host.service.dispose()
  release({ start() { starts++ }, dispose() { disposals++ } } as LoopService)
  await pending
  expect({ starts, disposals }).toEqual({ starts: 0, disposals: 1 })
})

test("first loop creation uses the real scheduler and synchronous facade", async () => {
  const clock = createVirtualClock()
  const ids = createIdFactory()
  const saved: import("@mendcode/protocol").Loop[] = []
  const host = createLazyLoops(async () => (await import("@mendcode/loops")).createLoopService({
    clock, ids, store: { all: () => saved, save: (loop) => { saved.push(loop) }, remove() {} },
    createSession: () => ids("session"), submit: async () => ({ queueId: ids("queue") }),
  }))
  const service = await host.load()
  const loop = service.create({ name: "watch", directory: "project", objective: "inspect", trigger: { kind: "manual" }, budget: { mode: "monitor" } })
  expect(host.service.get(loop.loopId)).toBe(loop)
  expect(host.service.list("project")).toHaveLength(1)
  expect(host.service.pause(loop.loopId)?.state).toBe("paused")
  host.service.dispose()
})

test("LSP passive reads and late notes remain empty; first query preserves unavailable output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lazy-lsp-"))
  const services = createLazyLsp({ cacheDir: join(dir, "cache"), warmUp: () => false })
  expect(services.lsp.status?.(dir)).toEqual([])
  expect(services.lsp.running()).toEqual([])
  expect(await services.lsp.workspaceSymbols({ cwd: dir, query: "nothing" })).toEqual({ result: [] })
  expect(await services.lsp.live({ cwd: dir, path: "a.unknown", boundMs: 0 })).toBeUndefined()
  expect(services.afterWrite.late("session")).toBeUndefined()
  const report = await services.lsp.query({ cwd: dir, filePath: "a.unknown", operation: "hover", line: 1, character: 1 })
  const real = (await import("@mendcode/lsp")).createLspManager({ cacheDir: join(dir, "cache") })
  const { createLspTool, createDiagnosticsTool } = await import("@mendcode/lsp")
  const definition = ({ execute, ...rest }: import("@mendcode/tools").Tool) => rest
  expect(definition(services.lspTool)).toEqual(definition(createLspTool(real)))
  expect(definition(services.diagnosticsTool)).toEqual(definition(createDiagnosticsTool(real)))
  const context = { cwd: dir, signal: new AbortController().signal }
  expect(await services.diagnosticsTool.execute({ path: "a.unknown" }, context)).toEqual(await createDiagnosticsTool(real).execute({ path: "a.unknown" }, context))
  expect(report).toEqual(await real.query({ cwd: dir, filePath: "a.unknown", operation: "hover", line: 1, character: 1 }))
  await Promise.all([real.stop(), services.lsp.stop(), services.formatter.stop()])
})

test("formatting and after-write stay functional without a language server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lazy-format-"))
  writeFileSync(join(dir, "a.unknown"), "unchanged")
  const services = createLazyLsp({ cacheDir: join(dir, "cache"), warmUp: () => false })
  expect(await services.afterWrite({ cwd: dir, paths: ["a.unknown"], sessionId: "session" })).toBeUndefined()
  expect(services.afterWrite.late("session")).toBeUndefined()
  expect(services.lsp.running()).toEqual([])
  await Promise.all([services.lsp.stop(), services.formatter.stop()])
  expect(await services.formatter.file({ cwd: dir, path: "a.unknown" })).toMatchObject({ unavailable: "cancelled" })
})

test("graph definitions match eager tools; first tool and overview share one graph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lazy-graph-"))
  writeFileSync(join(dir, "one.ts"), "export function one() { return 1 }")
  const graph = createLazyCodegraph({ cacheDir: join(dir, "cache"), mode: () => "on", enabled: () => false, publish() {}, log() {} })
  const signal = new AbortController().signal
  graph.autopilot.note({ cwd: dir, reason: "session" })
  expect(graph.autopilot.state(dir)).toBe("none")
  expect(await graph.autopilot.need({ cwd: dir, signal })).toEqual({ ready: true })
  const { createCodeGraphTools } = await import("@mendcode/codegraph")
  const eager = createCodeGraphTools({ cacheDir: join(dir, "other") })
  expect(graph.tools.map(({ execute, ...definition }) => definition)).toEqual(eager.map(({ execute, ...definition }) => definition))
  const result = await graph.tools.find((tool) => tool.name === "graph_find")!.execute({ query: "one" }, { cwd: dir, signal })
  expect(result.output).toContain("one.ts:1")
  expect(await graph.overview({ directory: dir, signal })).toMatchObject({ state: "ready", total: { files: 1, symbols: 1 } })
  expect((await graph.tools.find((tool) => tool.name === "graph_impact")!.execute({ path: "one.ts" }, { cwd: dir, signal })).output).not.toContain("no cached orientation")
  graph.autopilot.stop()
})

test("enabled graph autopilot starts on note and stops cleanly during first load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lazy-autopilot-"))
  writeFileSync(join(dir, "one.ts"), "export function one() { return 1 }")
  let indexed = 0
  const options = { cacheDir: join(dir, "cache"), mode: () => "on" as const, enabled: () => true, publish: (status: import("@mendcode/codegraph").IndexStatus) => { if (status.state === "indexed") indexed++ }, log() {} }
  const stopped = createLazyCodegraph(options)
  stopped.autopilot.note({ cwd: dir, reason: "session" })
  stopped.autopilot.stop()
  await stopped.autopilot.idle(dir)
  expect(indexed).toBe(0)
  const graph = createLazyCodegraph(options)
  graph.autopilot.note({ cwd: dir, reason: "session" })
  await graph.autopilot.idle(dir)
  expect(indexed).toBe(1)
  graph.autopilot.stop()
})
