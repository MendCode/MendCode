import { afterEach, expect, test } from "bun:test"
import { chmodSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { runManaged } from "@mendcode/tools"
import { createLspClient, createLspManager, createOfflineBootstrap, DEFAULT_SERVERS, formatDiagnosticsResult, languageIdFor, loadLspRegistry, localCommand, serverInitialization, serverRoot, type LspManager } from "../src"
import type { LspClientOptions } from "../src/client"
import { WEB_SERVERS } from "../src/web-presets"
import { FAKE_LSP, fakeSpec, put, setupLspTestCleanup, tempDir } from "./helpers"

setupLspTestCleanup()
const managers: LspManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.stop())) })
const result = (output = "", patch: Partial<Awaited<ReturnType<typeof runManaged>>> = {}) => ({ output, truncated: false, exitCode: 0, timedOut: false, cancelled: false, durationMs: 1, ...patch })
const preset = (id: string) => WEB_SERVERS.find((spec) => spec.id === id)!
const executable = (root: string, name: string) => {
  const path = put({ root, path: `node_modules/.bin/${name}`, content: `#!/bin/sh\nif [ "$1" = "--help" ]; then printf '%s\\n' '--lsp'; exit 0; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_LSP)}\n` })
  chmodSync(path, 0o755)
  return path
}

test("B11 appends all ten v1 web/scripting presets with downloads disabled", () => {
  expect(WEB_SERVERS.map((spec) => spec.id)).toEqual(["deno", "vue", "eslint", "oxlint", "biome", "svelte", "astro", "yaml-ls", "lua-ls", "bash"])
  expect(DEFAULT_SERVERS.filter((spec) => WEB_SERVERS.some((server) => server.id === spec.id))).toEqual([...WEB_SERVERS])
  expect(WEB_SERVERS.every((spec) => spec.disableDownload)).toBe(true)
  expect(preset("deno").command).toEqual(["deno", "lsp"])
  expect(preset("oxlint").fallbacks).toEqual([["oxc_language_server"]])
  expect(preset("biome").command).toEqual(["biome", "lsp-proxy", "--stdio"])
  expect(preset("bash").command).toEqual(["bash-language-server", "start"])
  expect(preset("biome").extensions).toEqual([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".jsonc", ".vue", ".astro", ".svelte", ".css", ".graphql", ".gql", ".html"])
  expect(preset("bash").extensions).toEqual([".sh", ".bash", ".zsh", ".ksh"])
})

test("web/scripting document language ids match their servers, including YAML and shell aliases", () => {
  for (const extension of [".vue", ".svelte", ".astro", ".lua", ".css", ".html", ".json", ".jsonc"]) expect(languageIdFor(extension.toUpperCase())).toBe(extension.slice(1))
  for (const extension of [".sh", ".bash", ".zsh", ".ksh"]) expect(languageIdFor(extension)).toBe("shellscript")
  for (const extension of [".yaml", ".yml"]) expect(languageIdFor(extension)).toBe("yaml")
  expect(languageIdFor(".gql")).toBe("graphql")
})

test.each(["deno.json", "deno.jsonc"])("Deno requires %s and excludes TypeScript throughout the matching project", async (marker) => {
  const cwd = tempDir(), file = put({ root: cwd, path: "apps/deno/src/a.ts", content: "" })
  const deno = preset("deno"), typescript = DEFAULT_SERVERS[0]!
  expect(await serverRoot({ file, cwd, spec: deno })).toBeUndefined()
  expect(await serverRoot({ file, cwd, spec: typescript })).toBe(cwd)
  put({ root: cwd, path: `apps/deno/${marker}`, content: "{}" })
  put({ root: cwd, path: "apps/deno/src/package.json", content: "{}" })
  expect(await serverRoot({ file, cwd, spec: deno })).toBe(join(cwd, "apps/deno"))
  expect(await serverRoot({ file, cwd, spec: typescript })).toBeUndefined()
  expect(await serverRoot({ file: join(cwd, "apps/node/a.ts"), cwd, spec: typescript })).toBe(cwd)
})

test.each(["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"])("web presets use the nearest %s instead of a nested package.json", async (marker) => {
  const cwd = tempDir(), file = put({ root: cwd, path: "apps/web/src/a.vue", content: "" })
  put({ root: cwd, path: marker, content: "" })
  put({ root: cwd, path: `apps/web/${marker}`, content: "" })
  put({ root: cwd, path: "apps/web/src/package.json", content: "{}" })
  for (const id of ["vue", "eslint", "svelte", "astro", "yaml-ls"]) expect(await serverRoot({ file, cwd, spec: preset(id) })).toBe(join(cwd, "apps/web"))
})

test("Oxlint, Biome and Lua recognize v1 project markers; Bash stays at the project directory", async () => {
  const cwd = tempDir(), file = put({ root: cwd, path: "sub/src/a.lua", content: "" })
  for (const [id, marker] of [["oxlint", ".oxlintrc.json"], ["biome", "biome.jsonc"], ["lua-ls", "selene.yml"]] as const) {
    put({ root: cwd, path: `sub/${marker}`, content: "{}" })
    expect(await serverRoot({ file, cwd, spec: preset(id) })).toBe(join(cwd, "sub"))
  }
  expect(await serverRoot({ file, cwd, spec: preset("bash") })).toBe(cwd)
})

test("preset overrides preserve routing/download policy and allow explicit command/init/root changes", async () => {
  const directory = tempDir()
  put({ root: directory, path: ".mendcode/lsp.json", content: JSON.stringify({ servers: { deno: { env: { DENO_DIR: "cache" } }, oxlint: { command: ["custom-oxlint"] }, astro: { initialization: { typescript: { tsdk: "/chosen/sdk" } } }, "yaml-ls": { disabled: true }, "lua-ls": { rootMarkers: ["lua.json"], rootRequired: true, rootExcludes: ["skip.json"], disableDownload: false } } }) })
  const { servers, issues } = await loadLspRegistry({ directory })
  expect(issues).toEqual([])
  expect(servers.find((spec) => spec.id === "deno")).toMatchObject({ rootRequired: true, disableDownload: true, env: { DENO_DIR: "cache" } })
  expect(servers.find((spec) => spec.id === "oxlint")?.fallbacks).toBeUndefined()
  expect(servers.find((spec) => spec.id === "astro")?.initialization).toEqual({ typescript: { tsdk: "/chosen/sdk" } })
  expect(servers.some((spec) => spec.id === "yaml-ls")).toBe(false)
  expect(servers.find((spec) => spec.id === "lua-ls")).toMatchObject({ rootMarkers: ["lua.json"], rootRequired: true, rootExcludes: ["skip.json"], disableDownload: false })
})

test("Astro requires project TypeScript and sends its tsdk; ESLint requires its local dependency", async () => {
  const cwd = tempDir(), root = join(cwd, "apps/web")
  put({ root: cwd, path: "apps/web/package.json", content: "{}" })
  expect(await serverInitialization({ spec: preset("astro"), root, cwd })).toBeUndefined()
  expect(await serverInitialization({ spec: preset("eslint"), root, cwd })).toBeUndefined()
  const tsserver = put({ root: cwd, path: "node_modules/typescript/lib/tsserver.js", content: "" })
  expect(await serverInitialization({ spec: preset("astro"), root, cwd })).toEqual({ typescript: { tsdk: join(tsserver, "..") } })
  expect(await serverInitialization({ spec: { ...preset("astro"), initialization: { typescript: { tsdk: "/explicit" } } }, root, cwd })).toEqual({ typescript: { tsdk: "/explicit" } })
  put({ root: cwd, path: "node_modules/eslint/package.json", content: '{"name":"eslint","main":"index.js"}' })
  put({ root: cwd, path: "node_modules/eslint/index.js", content: "" })
  expect(await serverInitialization({ spec: preset("eslint"), root, cwd })).toEqual({})
  expect(await serverInitialization({ spec: { ...preset("astro"), command: ["custom-astro"] }, root: tempDir(), cwd: tempDir() })).toEqual({})
})

test.each(["biome", "oxlint"])("%s prefers nearest project executables over PATH and finds ancestor node_modules", async (id) => {
  const cwd = tempDir(), root = join(cwd, "apps/web")
  put({ root: cwd, path: "apps/web/package.json", content: "{}" })
  const binary = executable(cwd, id)
  const spec = preset(id)
  const run: typeof runManaged = async () => result("--lsp")
  expect(await localCommand({ spec, cwd, root, which: () => "/global/server", run })).toEqual([binary, ...spec.command.slice(1)])
  const nested = executable(root, id)
  expect(await localCommand({ spec, cwd, root, which: () => "/global/server", run })).toEqual([nested, ...spec.command.slice(1)])
})

test("Oxlint probes --help with a bounded cancellable process, then falls back to oxc_language_server", async () => {
  const cwd = tempDir(), calls: Parameters<typeof runManaged>[0][] = []
  const spec = preset("oxlint")
  const signal = new AbortController().signal
  const run: typeof runManaged = async (input) => { calls.push(input); return result("no LSP support") }
  expect(await localCommand({ spec, cwd, which: (binary) => `/fake/${binary}`, run, signal })).toEqual(["/fake/oxc_language_server"])
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ argv: ["/fake/oxlint", "--help"], cwd, timeoutMs: 2_000, signal })
  expect(await localCommand({ spec, cwd, which: (binary) => binary === "oxlint" ? "/fake/oxlint" : null, run })).toBeUndefined()
  expect(await localCommand({ spec, cwd, which: (binary) => `/fake/${binary}`, run: async () => result("--lsp", { timedOut: true }) })).toEqual(["/fake/oxc_language_server"])
  expect(await localCommand({ spec, cwd, which: () => "/fake/server", run, signal: AbortSignal.abort() })).toBeUndefined()
})

test("B11 never provisions automatically, even when a cached offline installer is available", async () => {
  let calls = 0
  const cwd = tempDir(), cacheDir = tempDir()
  const bootstrap = createOfflineBootstrap({ cacheDir, which: () => null, run: async () => { calls++; return result("11.17.0") } })
  for (const spec of WEB_SERVERS) {
    expect(await bootstrap({ spec, cwd })).toBeUndefined()
    expect(await bootstrap({ spec: { ...spec, disableDownload: false }, cwd })).toBeUndefined()
  }
  expect(calls).toBe(0)
  const binary = executable(cwd, "svelteserver")
  expect(await bootstrap({ spec: preset("svelte"), cwd })).toEqual([binary, "--stdio"])
})

test.each(WEB_SERVERS.map((spec) => spec.id))("%s starts the installed preset command, synchronizes its language id and serves semantics/diagnostics", async (id) => {
  const cwd = tempDir(), spec = preset(id), root = id === "bash" ? cwd : join(cwd, "apps/web")
  const file = put({ root, path: `src/sample${spec.extensions[0]}`, content: "ERROR" })
  if (spec.rootMarkers[0]) put({ root, path: spec.rootMarkers[0], content: "{}" })
  if (id === "astro") put({ root: cwd, path: "node_modules/typescript/lib/tsserver.js", content: "" })
  if (id === "eslint") {
    put({ root: cwd, path: "node_modules/eslint/package.json", content: '{"name":"eslint","main":"index.js"}' })
    put({ root: cwd, path: "node_modules/eslint/index.js", content: "" })
  }
  const binary = executable(cwd, spec.command[0]!)
  const log = join(cwd, "server.log"), clients: LspClientOptions[] = []
  const manager = createLspManager({ registryLoader: () => ({ servers: [{ ...spec, env: { FAKE_LOG: log } }], issues: [] }), which: () => null, settleMs: 20, clientFactory: (input) => { clients.push(input); return createLspClient(input) } })
  managers.push(manager)
  expect(await manager.query({ cwd, filePath: file, operation: "hover", line: 1, character: 1 })).toMatchObject({ result: [{ contents: { value: "function execute(): Promise<void>" } }] })
  expect(await manager.diagnostics({ cwd, path: file })).toMatchObject({ file, settled: true, diagnostics: [{ code: "E001" }] })
  expect(clients).toHaveLength(1)
  expect(clients[0]).toMatchObject({ id, root, command: [binary, ...spec.command.slice(1)] })
  const messages = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  expect(messages.find((message) => message.method === "initialize").rootUri).toBe(pathToFileURL(root).href)
  expect(messages.find((message) => message.method === "textDocument/didOpen").params.textDocument.languageId).toBe(languageIdFor(spec.extensions[0]!))
})

test("Deno selection skips TypeScript before bootstrap, while matching linters still contribute diagnostics", async () => {
  const cwd = tempDir(), log = join(cwd, "deno.log")
  put({ root: cwd, path: "deno.json", content: "{}" })
  put({ root: cwd, path: "a.ts", content: "ERROR" })
  let installs = 0
  const servers = [DEFAULT_SERVERS[0]!, { ...preset("deno"), command: [process.execPath, FAKE_LSP], env: { FAKE_LOG: log } }, { ...preset("biome"), command: [process.execPath, FAKE_LSP] }]
  const manager = createLspManager({ registryLoader: () => ({ servers, issues: [] }), which: () => null, settleMs: 20, bootstrap: async () => { installs++; return undefined } })
  managers.push(manager)
  expect(await manager.query({ cwd, filePath: "a.ts", line: 1, character: 1, operation: "hover" })).toMatchObject({ result: [{ contents: {} }, { contents: {} }] })
  expect(await manager.diagnostics({ cwd, path: "a.ts" })).toMatchObject({ settled: true, diagnostics: [{ code: "E001" }, { code: "E001" }] })
  expect(manager.running().map((entry) => entry.server).sort()).toEqual(["biome", "deno"])
  expect(installs).toBe(0)
})

test("a missing linter cannot mask diagnostics from an available server", async () => {
  const cwd = tempDir()
  put({ root: cwd, path: "a.fake", content: "ERROR" })
  const missing = { ...fakeSpec(), id: "biome", command: ["biome", "lsp-proxy", "--stdio"], disableDownload: true }
  const manager = createLspManager({ registryLoader: () => ({ servers: [missing, fakeSpec()], issues: [] }), which: () => null, settleMs: 20 })
  managers.push(manager)
  const report = await manager.diagnostics({ cwd, path: "a.fake" })
  expect(report).toMatchObject({ settled: true, diagnostics: [{ code: "E001" }], issues: [{ server: "biome", message: expect.stringContaining("downloads disabled") }] })
  expect(formatDiagnosticsResult({ result: report, cwd })).toContain("biome: diagnostics unavailable")
  const clean = await manager.diagnostics({ cwd, path: "a.fake", content: "clean" })
  expect(formatDiagnosticsResult({ result: clean, cwd })).toContain("no problems reported by available servers")
})

test("missing Astro/ESLint dependencies report actionable unavailability without launching a process", async () => {
  const cwd = tempDir()
  put({ root: cwd, path: "a.astro", content: "" })
  put({ root: cwd, path: "a.vue", content: "" })
  const manager = createLspManager({ registryLoader: () => ({ servers: [preset("astro"), preset("eslint")], issues: [] }), which: () => "/installed/server" })
  managers.push(manager)
  expect(await manager.query({ cwd, filePath: "a.astro", line: 1, character: 1, operation: "hover" })).toMatchObject({ unavailable: "astro: project TypeScript dependency is not installed" })
  expect(await manager.diagnostics({ cwd, path: "a.vue" })).toEqual({ unavailable: "eslint: project ESLint dependency is not installed" })
  expect(manager.running()).toEqual([])
})
