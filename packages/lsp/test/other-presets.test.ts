import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, utimesSync } from "node:fs"
import { dirname, join } from "node:path"
import type { runManaged } from "@mendcode/tools"
import { createLspClient, createLspManager, createOfflineBootstrap, DEFAULT_SERVERS, languageIdForFile, loadLspRegistry, localCommand, matchesFile, OTHER_SERVERS, serverInitialization, serverRoot, type LspManager } from "../src"
import type { LspClientOptions } from "../src/client"
import { put, setupLspTestCleanup, tempDir } from "./helpers"
import { installedFake, otherFixture, razorFixture } from "./other-fixtures"

setupLspTestCleanup()
const managers: LspManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.stop())) })
const preset = (id: string) => OTHER_SERVERS.find((spec) => spec.id === id)!
const result = (output = "", patch: Partial<Awaited<ReturnType<typeof runManaged>>> = {}) => ({ output, truncated: false, exitCode: 0, timedOut: false, cancelled: false, durationMs: 1, ...patch })

test("B12 registers all 24 installed-only v1 presets without substituting Ruby or Kotlin implementations", () => {
  expect(OTHER_SERVERS.map((spec) => spec.id)).toEqual(["ruby-lsp", "ty", "elixir-ls", "zls", "csharp", "razor", "fsharp", "sourcekit-lsp", "clangd", "jdtls", "kotlin-ls", "php intelephense", "prisma", "dart", "ocaml-lsp", "terraform", "texlab", "dockerfile", "gleam", "clojure-lsp", "nixd", "tinymist", "haskell-language-server", "julials"])
  expect(DEFAULT_SERVERS.slice(-24)).toEqual([...OTHER_SERVERS])
  expect(OTHER_SERVERS.every((spec) => spec.disableDownload)).toBe(true)
  expect(preset("ruby-lsp").command).toEqual(["rubocop", "--lsp"])
  expect(preset("kotlin-ls").command).toEqual(["kotlin-lsp", "--stdio"])
  expect(preset("julials").command).toEqual(["julia", "--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"])
})

test("Ty is opt-in through the experimental flag or an explicit enabled override; all presets remain configurable", async () => {
  const directory = tempDir(), previous = process.env.MENDCODE_EXPERIMENTAL_LSP_TY
  try {
    delete process.env.MENDCODE_EXPERIMENTAL_LSP_TY
    const loaded = await loadLspRegistry({ directory })
    expect(matchesFile(loaded.servers.find((spec) => spec.id === "ty")!, "a.py")).toBe(false)
    process.env.MENDCODE_EXPERIMENTAL_LSP_TY = "1"
    expect(matchesFile((await loadLspRegistry({ directory })).servers.find((spec) => spec.id === "ty")!, "a.pyi")).toBe(true)
    delete process.env.MENDCODE_EXPERIMENTAL_LSP_TY
    put({ root: directory, path: ".mendcode/lsp.json", content: JSON.stringify({ servers: { ty: { disabled: false }, "kotlin-ls": { rootMarkers: ["chosen.json"] }, dockerfile: { filenames: ["Containerfile"] }, "php intelephense": { command: ["custom-php"], initialization: { telemetry: { enabled: true } } } } }) })
    const { servers, issues } = await loadLspRegistry({ directory })
    expect(issues).toEqual([])
    expect(servers.find((spec) => spec.id === "ty")).toMatchObject({ enabled: true, disableDownload: true })
    expect(servers.find((spec) => spec.id === "kotlin-ls")?.rootGroups).toBeUndefined()
    expect(matchesFile(servers.find((spec) => spec.id === "dockerfile")!, "src/Containerfile")).toBe(true)
    expect(servers.find((spec) => spec.id === "php intelephense")).toMatchObject({ command: ["custom-php"], initialization: { telemetry: { enabled: true } } })
  } finally {
    if (previous === undefined) delete process.env.MENDCODE_EXPERIMENTAL_LSP_TY
    else process.env.MENDCODE_EXPERIMENTAL_LSP_TY = previous
  }
})

test.each(OTHER_SERVERS.map((spec) => spec.id))("%s selects its nearest v1 marker, including glob names and directory markers", async (id) => {
  const spec = preset(id), cwd = tempDir(), root = join(cwd, "project")
  const file = put({ root, path: "src/sample", content: "" })
  expect(await serverRoot({ file, cwd, spec })).toBe(cwd)
  if (spec.rootMarkers[0]) put({ root, path: spec.rootMarkers[0].replace("*", "named-project"), content: "" })
  expect(await serverRoot({ file, cwd, spec })).toBe(spec.rootMarkers.length ? root : cwd)
})

test.each(["jdtls", "kotlin-ls"])("%s prefers Gradle settings, then wrapper, then module build; unrelated siblings do not route", async (id) => {
  const spec = preset(id), cwd = tempDir(), root = join(cwd, "modules/app")
  const file = put({ root, path: "src/a.java", content: "" })
  put({ root, path: "build.gradle.kts", content: "" })
  put({ root: cwd, path: "sibling/settings.gradle", content: "" })
  expect(await serverRoot({ file, cwd, spec })).toBe(root)
  put({ root: cwd, path: "modules/gradlew", content: "" })
  expect(await serverRoot({ file, cwd, spec })).toBe(join(cwd, "modules"))
  put({ root: cwd, path: "settings.gradle.kts", content: "" })
  expect(await serverRoot({ file, cwd, spec })).toBe(cwd)
})

test.each([["csharp", "Project.csproj"], ["razor", "Solution.slnx"], ["fsharp", "Project.fsproj"], ["sourcekit-lsp", "App.xcodeproj"], ["terraform", "main.tf"], ["haskell-language-server", "project.cabal"], ["julials", "main.jl"]])("%s recognizes the real marker name %s instead of a literal wildcard", async (id, marker) => {
  const cwd = tempDir(), root = join(cwd, "sub")
  const file = put({ root, path: "src/file", content: "" })
  if (marker.endsWith("xcodeproj")) mkdirSync(join(root, marker), { recursive: true })
  else put({ root, path: marker, content: "" })
  expect(await serverRoot({ file, cwd, spec: preset(id) })).toBe(root)
  expect(await serverRoot({ file: join(cwd, "other/file"), cwd, spec: preset(id) })).toBe(cwd)
})

test("Prisma package exclusion and Nix flake/git fallback match v1 project routing", async () => {
  const cwd = tempDir(), root = join(cwd, "sub")
  const file = put({ root, path: "prisma/schema.prisma", content: "" })
  expect(await serverRoot({ file, cwd, spec: preset("prisma") })).toBe(join(root, "prisma"))
  put({ root: cwd, path: "package.json", content: "{}" })
  expect(await serverRoot({ file, cwd, spec: preset("prisma") })).toBeUndefined()
  put({ root: cwd, path: ".git", content: "gitdir: /unused" })
  const nix = put({ root, path: "src/a.nix", content: "" })
  expect(await serverRoot({ file: nix, cwd: root, spec: preset("nixd") })).toBe(cwd)
  put({ root, path: "flake.nix", content: "" })
  expect(await serverRoot({ file: nix, cwd, spec: preset("nixd") })).toBe(root)
})

test("language aliases and extensionless Dockerfile are synchronized with the correct LSP language id", () => {
  for (const [file, id] of [["Gem.rake", "ruby"], ["a.csx", "csharp"], ["a.fsx", "fsharp"], ["a.hh", "cpp"], ["a.kts", "kotlin"], ["a.tfvars", "terraform-vars"], ["a.tex", "latex"], ["a.bib", "bibtex"], ["a.cljc", "clojure"], ["a.lhs", "haskell"], ["a.typc", "typst"], ["src/Dockerfile", "dockerfile"]] as const) expect(languageIdForFile(file)).toBe(id)
  expect(matchesFile(preset("dockerfile"), "src/Dockerfile")).toBe(true)
  expect(matchesFile(preset("dockerfile"), "src/dockerfile")).toBe(false)
  expect(matchesFile(preset("dockerfile"), "src/custom.DOCKERFILE")).toBe(true)
  expect(languageIdForFile("src/Containerfile", "dockerfile")).toBe("dockerfile")
})

test("Ty discovers the selected virtualenv binary and Python initialization, retaining explicit initialization", async () => {
  const cwd = tempDir(), venv = join(cwd, "chosen-env")
  const ty = installedFake(venv, process.platform === "win32" ? "Scripts/ty.exe" : "bin/ty")
  const python = put({ root: venv, path: process.platform === "win32" ? "Scripts/python.exe" : "bin/python", content: "" })
  const spec = { ...preset("ty"), env: { VIRTUAL_ENV: venv } }
  expect(await localCommand({ spec, cwd, which: () => null })).toEqual([ty, "server"])
  expect(await serverInitialization({ spec, root: cwd, cwd })).toEqual({ pythonPath: python })
  expect(await serverInitialization({ spec: { ...spec, initialization: { pythonPath: "/explicit" } }, root: cwd, cwd })).toEqual({ pythonPath: "/explicit" })
  expect(await localCommand({ spec, cwd, which: () => null, signal: AbortSignal.abort() })).toBeUndefined()
})

test("Dockerfile basename overrides route semantic requests and diagnostics with dockerfile language id", async () => {
  const cwd = tempDir(), { spec } = otherFixture(cwd, "dockerfile")
  put({ root: cwd, path: "Containerfile", content: "ERROR" })
  const manager = createLspManager({ registryLoader: () => ({ servers: [{ ...spec, filenames: ["Containerfile"] }], issues: [] }), which: () => null, settleMs: 20 })
  managers.push(manager)
  expect(await manager.query({ cwd, filePath: "Containerfile", operation: "hover", line: 1, character: 1 })).toMatchObject({ result: [{ contents: {} }] })
  expect(await manager.diagnostics({ cwd, path: "Containerfile" })).toMatchObject({ diagnostics: [{ code: "E001" }] })
  expect(await manager.query({ cwd, filePath: "Dockerfile", operation: "hover", line: 1, character: 1 })).toMatchObject({ unavailable: "No LSP server available for this file type." })
  const messages = readFileSync(spec.env!.FAKE_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  expect(messages.find((message) => message.method === "textDocument/didOpen").params.textDocument.languageId).toBe("dockerfile")
})

test("SourceKit discovers the Xcode toolchain with a bounded cancellable xcrun probe", async () => {
  const cwd = tempDir(), binary = installedFake(cwd, "toolchain/sourcekit-lsp"), calls: Parameters<typeof runManaged>[0][] = []
  const signal = new AbortController().signal
  const run: typeof runManaged = async (input) => { calls.push(input); return result(binary + "\n") }
  expect(await localCommand({ spec: preset("sourcekit-lsp"), cwd, which: (name) => name === "xcrun" ? "/fake/xcrun" : null, run, signal })).toEqual([binary])
  expect(calls[0]).toMatchObject({ argv: ["/fake/xcrun", "--find", "sourcekit-lsp"], timeoutMs: 2_000, signal })
  expect(await localCommand({ spec: preset("sourcekit-lsp"), cwd, which: (name) => name === "xcrun" ? "/fake/xcrun" : null, run: async () => result(binary, { timedOut: true }) })).toBeUndefined()
})

test("Razor requires all three installed extension assets and selects the latest complete extension", async () => {
  const cwd = tempDir(), extensions = join(cwd, "extensions")
  const old = razorFixture(extensions, "1.0.0"), recent = razorFixture(extensions, "2.0.0")
  utimesSync(join(dirname(old[0]!), ".."), 1, 1)
  utimesSync(join(dirname(recent[0]!), ".."), 2, 2)
  const spec = { ...preset("razor"), env: { VSCODE_EXTENSIONS: extensions } }
  const command = await localCommand({ spec, cwd, which: () => "/fake/roslyn" })
  expect(command).toEqual(["/fake/roslyn", "--stdio", "--autoLoadProjects", `--razorSourceGenerator=${recent[0]}`, `--razorDesignTimePath=${recent[1]}`, "--extension", recent[2]!])
  expect(await localCommand({ spec: { ...spec, command: ["custom-razor"] }, cwd, which: () => "/fake/custom" })).toEqual(["/fake/custom"])
})

test.each(["csharp", "fsharp"])("%s finds an installed dotnet tool outside PATH without installing it", async (id) => {
  const cwd = tempDir(), spec = { ...preset(id), env: { DOTNET_CLI_HOME: join(cwd, "dotnet") } }
  const binary = installedFake(spec.env.DOTNET_CLI_HOME, `.dotnet/tools/${spec.command[0]}${process.platform === "win32" ? ".exe" : ""}`)
  expect(await localCommand({ spec, cwd, which: () => null })).toEqual([binary, ...spec.command.slice(1)])
})

test.each([["elixir-ls", "elixir-ls-master/release/language_server.sh"], ["kotlin-ls", "kotlin-ls/kotlin-lsp.sh"], ["clangd", "clangd_20/bin/clangd"]])("%s resolves a preinstalled distribution without provisioning", async (id, relative) => {
  const cwd = tempDir(), cacheDir = tempDir(), spec = preset(id)
  const binary = installedFake(cacheDir, relative)
  expect(await localCommand({ spec, cwd, cacheDir, which: () => null })).toEqual([binary, ...spec.command.slice(1)])
  expect(await localCommand({ spec: { ...spec, bootstrap: false }, cwd, cacheDir, which: () => null })).toBeUndefined()
})

test("JDTLS requires Java 21+, uses cached jar/configuration, and isolates writable data by root", async () => {
  const cwd = tempDir(), cacheDir = tempDir(), java = installedFake(cwd, "java")
  const spec = preset("jdtls"), signal = new AbortController().signal
  const jar = put({ root: cacheDir, path: "jdtls/plugins/org.eclipse.equinox.launcher_1.0.jar", content: "" })
  mkdirSync(join(cacheDir, "jdtls", process.platform === "darwin" ? "config_mac" : process.platform === "win32" ? "config_win" : "config_linux"), { recursive: true })
  const which = (name: string) => name === "java" ? java : null
  const calls: Parameters<typeof runManaged>[0][] = []
  const run: typeof runManaged = async (input) => { calls.push(input); return result('openjdk version "21.0.4"') }
  const command = await localCommand({ spec, cwd, cacheDir, which, run, signal })
  expect(command).toContain(jar)
  expect(command!.slice(-2, -1)).toEqual(["-data"])
  expect(command!.at(-1)).toStartWith(join(cacheDir, "jdtls/workspaces/"))
  expect(calls[0]).toMatchObject({ argv: [java, "-version"], timeoutMs: 2_000, signal })
  const other = await localCommand({ spec, cwd, root: join(cwd, "other"), cacheDir, which, run })
  expect(other!.at(-1)).not.toBe(command!.at(-1))
  for (const version of ['openjdk version "17.0.1"', "bad version"]) expect(await localCommand({ spec, cwd, cacheDir, which, run: async () => result(version) })).toBeUndefined()
  expect(await localCommand({ spec, cwd, cacheDir, which, run: async () => result('java version "21.0.1"', { cancelled: true }) })).toBeUndefined()
})

test("B12 never invokes even an offline installer and retains v1 server initialization", async () => {
  let installs = 0
  const cwd = tempDir(), cacheDir = tempDir(), bootstrap = createOfflineBootstrap({ cacheDir, which: () => null, run: async () => { installs++; return result() } })
  for (const preset of OTHER_SERVERS) {
    const spec = { ...preset, env: { DOTNET_CLI_HOME: cwd, VSCODE_EXTENSIONS: cwd, VIRTUAL_ENV: cwd } }
    expect(await bootstrap({ spec, cwd })).toBeUndefined()
    expect(await bootstrap({ spec: { ...spec, disableDownload: false }, cwd })).toBeUndefined()
  }
  expect(installs).toBe(0)
  expect(await serverInitialization({ spec: preset("php intelephense"), cwd, root: cwd })).toEqual({ telemetry: { enabled: false } })
  expect(await serverInitialization({ spec: preset("terraform"), cwd, root: cwd })).toEqual({ experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true } })
})

test.each(OTHER_SERVERS.map((spec) => spec.id))("%s launches its installed command and transports hover/diagnostics with real initialization and language ids", async (id) => {
  const cwd = tempDir(), { spec, filePath } = otherFixture(cwd, id), clients: LspClientOptions[] = []
  const manager = createLspManager({ which: () => null, settleMs: 20, clientFactory: (input) => { clients.push(input); return createLspClient(input) } })
  managers.push(manager)
  expect(await manager.query({ cwd, filePath, operation: "hover", line: 1, character: 1 })).toMatchObject({ result: [{ contents: { value: "function execute(): Promise<void>" } }] })
  expect(await manager.diagnostics({ cwd, path: filePath, content: "ERROR" })).toMatchObject({ settled: true, diagnostics: [{ code: "E001" }] })
  expect(clients).toHaveLength(1)
  expect(clients[0]!.id).toBe(id)
  expect(clients[0]!.command.slice(0, spec.command.length)).toEqual([join(cwd, "node_modules/.bin", spec.command[0]!), ...spec.command.slice(1)])
  const messages = readFileSync(spec.env!.FAKE_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  expect(messages.find((message) => message.method === "textDocument/didOpen").params.textDocument.languageId).toBe(languageIdForFile(filePath))
  expect(messages.find((message) => message.method === "initialize").params.initializationOptions).toEqual(clients[0]!.initialization)
})
