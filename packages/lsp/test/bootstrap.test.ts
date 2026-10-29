import { afterEach, expect, test } from "bun:test"
import { chmodSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { createLspManager, createOfflineBootstrap, DEFAULT_SERVERS, installLspServer, localCommand, type LspManager } from "../src"
import type { runManaged } from "@mendcode/tools"
import { FAKE_LSP, fakeSpec, put, setupLspTestCleanup, tempDir, until } from "./helpers"

setupLspTestCleanup()
const managers: LspManager[] = []
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.stop())) })
const result = (output = "", patch: Partial<Awaited<ReturnType<typeof runManaged>>> = {}) => ({ output, truncated: false, exitCode: 0, timedOut: false, cancelled: false, durationMs: 1, ...patch })

test("missing TypeScript/Pyright bootstrap uses pnpm 11 offline with release-age protection and shares concurrent installs", async () => {
  for (const id of ["typescript", "python"]) {
    const cwd = tempDir(), cacheDir = tempDir()
    const spec = DEFAULT_SERVERS.find((server) => server.id === id)!
    const calls: Parameters<typeof runManaged>[0][] = []
    const bootstrap = createOfflineBootstrap({ cacheDir, which: (binary) => binary === "pnpm" ? "/fake/pnpm" : null, run: async (input) => {
      calls.push(input)
      if (input.argv[1] === "--version") return result("11.17.0\n")
      const path = put({ root: input.cwd, path: `node_modules/.bin/${spec.command[0]}`, content: "#!/bin/sh\n" })
      chmodSync(path, 0o755)
      return result()
    } })
    const commands = await Promise.all([bootstrap({ spec, cwd }), bootstrap({ spec, cwd })])
    expect(commands).toEqual([[join(cacheDir, id, "node_modules/.bin", spec.command[0]!), "--stdio"], [join(cacheDir, id, "node_modules/.bin", spec.command[0]!), "--stdio"]])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.argv).toEqual(["/fake/pnpm", "add", "--offline", "--ignore-scripts", "--config.minimumReleaseAge=1440", ...(id === "typescript" ? ["typescript-language-server", "typescript"] : ["pyright"])])
    expect(calls[1]?.cwd).toBe(join(cacheDir, id))
  }
})

test("missing gopls provisions only from Go's offline module/toolchain cache", async () => {
  const cwd = tempDir(), cacheDir = tempDir()
  const calls: Parameters<typeof runManaged>[0][] = []
  const bootstrap = createOfflineBootstrap({ cacheDir, which: (binary) => binary === "go" ? "/fake/go" : null, run: async (input) => {
    calls.push(input)
    const path = put({ root: cacheDir, path: "bin/gopls", content: "#!/bin/sh\n" })
    chmodSync(path, 0o755)
    return result()
  } })
  expect(await bootstrap({ spec: DEFAULT_SERVERS[2]!, cwd })).toEqual([join(cacheDir, "bin/gopls")])
  expect(calls[0]).toMatchObject({ argv: ["/fake/go", "install", "golang.org/x/tools/gopls@latest"], env: { GOBIN: join(cacheDir, "bin"), GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" } })
})

test("lsp install downloads with pnpm online (no scripts, release-age guard) and gopls through the Go proxy; an installed server is left alone", async () => {
  const cwd = tempDir(), cacheDir = tempDir()
  const calls: Parameters<typeof runManaged>[0][] = []
  const run = async (input: Parameters<typeof runManaged>[0]) => {
    calls.push(input)
    if (input.argv[1] === "--version") return result("11.17.0\n")
    const path = input.argv[1] === "install" ? put({ root: cacheDir, path: "bin/gopls", content: "#!/bin/sh\n" }) : put({ root: input.cwd, path: "node_modules/.bin/typescript-language-server", content: "#!/bin/sh\n" })
    chmodSync(path, 0o755)
    return result()
  }
  const which = (binary: string) => binary === "pnpm" ? "/fake/pnpm" : binary === "go" ? "/fake/go" : null
  expect(await installLspServer({ id: "typescript", cwd, cacheDir, which, run })).toMatchObject({ id: "typescript", command: [join(cacheDir, "typescript/node_modules/.bin/typescript-language-server"), "--stdio"] })
  expect(calls[1]).toMatchObject({ argv: ["/fake/pnpm", "add", "--ignore-scripts", "--config.minimumReleaseAge=1440", "typescript-language-server", "typescript"], timeoutMs: 180_000 })
  expect(await installLspServer({ id: "go", cwd, cacheDir, which, run })).toMatchObject({ command: [join(cacheDir, "bin/gopls")] })
  expect(calls[2]!.env).toMatchObject({ GOBIN: join(cacheDir, "bin"), GOTOOLCHAIN: "local" })
  expect(calls[2]!.env.GOPROXY).not.toBe("off")
  calls.length = 0
  expect(await installLspServer({ id: "typescript", cwd, cacheDir, which, run })).toMatchObject({ already: true })
  expect(calls).toEqual([])
  expect(await installLspServer({ id: "python", cwd, cacheDir: tempDir(), which: () => null, run })).toEqual({ id: "python", reason: "pnpm is not on PATH" })
})

test("disableDownload/bootstrap=false, cancelled, rust and custom commands never provision", async () => {
  let calls = 0
  const bootstrap = createOfflineBootstrap({ cacheDir: tempDir(), which: () => null, run: async () => {
    calls++
    return result()
  } })
  const spec = DEFAULT_SERVERS[0]!, cwd = tempDir()
  for (const input of [{ spec, cwd, disabled: true }, { spec: { ...spec, disableDownload: true }, cwd }, { spec: { ...spec, bootstrap: false }, cwd }, { spec, cwd, signal: AbortSignal.abort() }, { spec: DEFAULT_SERVERS[3]!, cwd }, { spec: { ...fakeSpec(), command: ["custom-server"] }, cwd }, { spec: { ...spec, command: ["custom-ts"] }, cwd }]) expect(await bootstrap(input)).toBeUndefined()
  expect(calls).toBe(0)
})

test("older/invalid pnpm and offline cache misses fail gracefully without a server", async () => {
  for (const output of ["10.0.0", "not a version", "11.17.0"]) {
    const calls: string[][] = []
    const bootstrap = createOfflineBootstrap({ cacheDir: tempDir(), which: (binary) => binary === "pnpm" ? "/fake/pnpm" : null, run: async (input) => {
      calls.push(input.argv)
      return input.argv[1] === "--version" ? result(output) : result("cache miss", { exitCode: 1 })
    } })
    expect(await bootstrap({ spec: DEFAULT_SERVERS[0]!, cwd: tempDir() })).toBeUndefined()
    expect(calls.length).toBe(output === "11.17.0" ? 2 : 1)
  }
})

test("manager uses the provisioned command and global disable prevents even an injected installer", async () => {
  const cwd = tempDir(), cacheDir = tempDir()
  put({ root: cwd, path: "a.fake", content: "function execute() {}" })
  const spec = { ...fakeSpec(), id: "typescript", command: ["typescript-language-server", FAKE_LSP] }
  let calls = 0
  const bootstrap = createOfflineBootstrap({ cacheDir, which: (binary) => binary === "pnpm" ? "/fake/pnpm" : null, run: async (input) => {
    calls++
    if (input.argv[1] === "--version") return result("11.17.0")
    const target = put({ root: input.cwd, path: "node_modules/.bin/placeholder", content: "" })
    symlinkSync(process.execPath, join(target, "..", "typescript-language-server"))
    return result()
  } })
  const manager = createLspManager({ registryLoader: () => ({ servers: [spec], issues: [] }), bootstrap, cacheDir, which: () => null })
  managers.push(manager)
  expect((await manager.query({ cwd, filePath: "a.fake", line: 1, character: 1, operation: "hover" })).result).toHaveLength(1)
  expect(calls).toBe(2)
  let attempted = false
  const disabled = createLspManager({ registryLoader: () => ({ servers: [spec], issues: [], disableDownload: true }), which: () => null, bootstrap: async () => {
    attempted = true
    return [process.execPath, FAKE_LSP]
  } })
  managers.push(disabled)
  expect(await disabled.query({ cwd, filePath: "a.fake", line: 1, character: 1, operation: "hover" })).toMatchObject({ unavailable: expect.stringContaining("downloads disabled") })
  expect(attempted).toBe(false)
})

test("manager stop cancels pending bootstrap and leaves no server running", async () => {
  const cwd = tempDir()
  put({ root: cwd, path: "a.fake", content: "" })
  let entered = false
  const manager = createLspManager({ registryLoader: () => ({ servers: [{ ...fakeSpec(), command: ["missing-server"] }], issues: [] }), which: () => null, bootstrap: async ({ signal }) => {
    entered = true
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }))
    return undefined
  } })
  const query = manager.query({ cwd, filePath: "a.fake", line: 1, character: 1, operation: "hover" })
  await until({ check: () => entered })
  await manager.stop()
  expect(await query).toEqual({ result: [], unavailable: "cancelled" })
  expect(manager.running()).toEqual([])
})

test("custom relative commands and env PATH resolve in the project without using the daemon's PATH", async () => {
  const cwd = tempDir()
  const binary = put({ root: cwd, path: "bin/custom-server", content: "#!/bin/sh\n" })
  chmodSync(binary, 0o755)
  expect(await localCommand({ spec: { ...fakeSpec(), command: ["./bin/custom-server", "--stdio"] }, cwd, which: () => null })).toEqual([binary, "--stdio"])
  expect(await localCommand({ spec: { ...fakeSpec(), command: ["custom-server"], env: { PATH: "bin" } }, cwd, which: () => "/wrong/path" })).toEqual([binary])
})
