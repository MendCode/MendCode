import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { budgetMs } from "../../../scripts/test-budget"
import { createAfterWrite, createDiagnosticsTool, createLspClient, createLspManager, createOfflineBootstrap, DEFAULT_RETRY_MS, DEFAULT_SERVERS, loadLspRegistry, type LspManager, type LspServerSpec } from "../src"
import type { runManaged } from "@mendcode/tools"
import { FAKE_LSP, alive, fakeSpec, put, setupLspTestCleanup, tempDir, until } from "./helpers"

setupLspTestCleanup()

const managers: LspManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()))
})
/** A manager whose language servers are counted when their client is created, which is what precedes every spawn. */
const counted = (input: Parameters<typeof createLspManager>[0] = {}) => {
  const count = { clients: 0 }
  const manager = createLspManager({ registryLoader: () => ({ servers: [fakeSpec()], issues: [] }), settleMs: 20, which: () => null, clientFactory: (options) => (count.clients++, createLspClient(options)), ...input })
  managers.push(manager)
  return { manager, count }
}
const timed = async <T>(work: () => Promise<T>) => {
  const start = performance.now()
  const value = await work()
  return { value, ms: performance.now() - start }
}
/** The children the fake server itself reported: one `initialize` line, with its pid, per process that got that far. */
const children = (log: string): number[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []).filter((entry) => entry.method === "initialize").map((entry) => entry.pid)
const ERROR_LINE = (file: string, line = 1) => `${file}:${line}:1 error E001 found ERROR on line ${line}`
/** A server that is installed (an absolute, executable command) and exits before it answers `initialize`. */
const brokenSpec = (): LspServerSpec => ({ id: "fake", command: [process.execPath, "-e", "process.exit(3)"], extensions: [".fake"], rootMarkers: [] })

describe("warm-up after a write", () => {
  test("the first write returns at once with nothing started; the server starts afterwards and the second write gets diagnostics", async () => {
    const root = tempDir()
    const log = join(root, "fake.log")
    process.env.FAKE_LOG = log
    put({ root, path: "a.fake", content: "ERROR\n" })
    const { manager, count } = counted()
    let asked = 0
    const hook = createAfterWrite({ manager, diagnosticsWaitMs: 2_000, warmUp: () => (asked++, true) })
    const first = await timed(() => hook({ cwd: root, paths: ["a.fake"], sessionId: "s" }))
    // Nothing happened by the time the write's result exists: not even the feature gate was asked.
    expect({ value: first.value, asked, clients: count.clients, running: manager.running() }).toEqual({ value: undefined, asked: 0, clients: 0, running: [] })
    expect(first.ms).toBeLessThan(budgetMs(10))
    await until({ check: () => children(log).length === 1 })
    expect({ asked, clients: count.clients, running: manager.running().map((entry) => entry.server) }).toEqual({ asked: 1, clients: 1, running: ["fake"] })

    put({ root, path: "a.fake", content: "fine\nERROR\n" })
    const second = await timed(() => hook({ cwd: root, paths: ["a.fake"], sessionId: "s" }))
    expect(second.value).toBe(`\n\nDiagnostics:\n${ERROR_LINE("a.fake", 2)}`)
    expect(second.ms).toBeLessThan(budgetMs(1_000))
    expect({ clients: count.clients, children: children(log).length }).toEqual({ clients: 1, children: 1 })
  })

  test("a server that takes longer than the write's wait reports late, on the session's next tool result", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "fine\n" })
    const { manager } = counted({ settleMs: 30 })
    const hook = createAfterWrite({ manager, budgetMs: 4_000, diagnosticsWaitMs: 60, warmUp: () => true })
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    await until({ check: () => manager.running().some((entry) => entry.pid !== undefined) })
    put({ root, path: "a.fake", content: "SLOW300\nERROR\n" })
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    let late: string | undefined
    await until({ check: () => (late = hook.late("s")) !== undefined })
    expect(late).toBe(`\n\nDiagnostics:\n${ERROR_LINE("a.fake", 2)}`)
  })

  test("several files and repeated writes share one attempt per project root and server", async () => {
    const root = tempDir()
    const log = join(root, "fake.log")
    process.env.FAKE_LOG = log
    put({ root, path: "a.fake", content: "fine\n" })
    put({ root, path: "b.fake", content: "fine\n" })
    const { manager, count } = counted()
    const hook = createAfterWrite({ manager, warmUp: () => true })
    await hook({ cwd: root, paths: ["a.fake", "b.fake"] })
    await hook({ cwd: root, paths: ["b.fake"] })
    await hook({ cwd: root, paths: ["a.fake"] })
    await until({ check: () => children(log).length === 1 })
    await Bun.sleep(150)
    expect({ clients: count.clients, children: children(log).length, running: manager.running().length }).toEqual({ clients: 1, children: 1, running: 1 })
  })

  test("no server installed locally: the write looks nothing up, the warm-up looks once, never provisions and starts nothing", async () => {
    const root = tempDir()
    put({ root, path: "package.json", content: "{}" })
    put({ root, path: "tsconfig.json", content: "{}" })
    put({ root, path: "src/a.ts", content: "export const a: number = 'no'\n" })
    const lookups: string[] = []
    let provisions = 0
    let spawns = 0
    // The builtin registry: TypeScript, Biome, Oxlint and ESLint all claim a .ts file, and TypeScript is provisionable.
    const manager = createLspManager({
      registryLoader: (directory) => loadLspRegistry({ directory }),
      which: (binary) => (lookups.push(binary), null),
      bootstrap: async () => (provisions++, undefined),
      clientFactory: () => { spawns++; throw new Error("nothing is installed, so nothing may start") },
    })
    managers.push(manager)
    const hook = createAfterWrite({ manager, warmUp: () => true })
    const { value, ms } = await timed(() => hook({ cwd: root, paths: ["src/a.ts"], sessionId: "s" }))
    expect(value).toBeUndefined()
    expect(ms).toBeLessThan(budgetMs(10))
    expect({ lookups, provisions, spawns }).toEqual({ lookups: [], provisions: 0, spawns: 0 })
    await until({ check: () => lookups.includes("typescript-language-server") })
    await Bun.sleep(100)
    expect({ provisions, spawns, running: manager.running() }).toEqual({ provisions: 0, spawns: 0, running: [] })

    // What was missing is remembered: the next write's warm-up does not look again.
    lookups.length = 0
    expect(await hook({ cwd: root, paths: ["src/a.ts"], sessionId: "s" })).toBeUndefined()
    await Bun.sleep(100)
    expect({ lookups, provisions, spawns }).toEqual({ lookups: [], provisions: 0, spawns: 0 })
    expect(hook.late("s")).toBeUndefined()
  })

  test("the feature gate is asked after the write and a no starts nothing; without a gate there is no warm-up", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "ERROR\n" })
    const lookups: string[] = []
    const { manager, count } = counted({ which: (binary) => (lookups.push(binary), null) })
    let asked = 0
    const off = createAfterWrite({ manager, warmUp: () => (asked++, false) })
    expect(await off({ cwd: root, paths: ["a.fake"] })).toBeUndefined()
    expect(asked).toBe(0)
    await until({ check: () => asked === 1 })
    expect(await createAfterWrite({ manager })({ cwd: root, paths: ["a.fake"] })).toBeUndefined()
    expect(await createAfterWrite({ manager, warmUp: () => { throw new Error("settings unreadable") } })({ cwd: root, paths: ["a.fake"] })).toBeUndefined()
    await Bun.sleep(150)
    expect({ asked, lookups, clients: count.clients, running: manager.running() }).toEqual({ asked: 1, lookups: [], clients: 0, running: [] })
  })

  test("a warm-up that fails is remembered, never reaches a write's result and is tried again after the interval", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "ERROR\n" })
    let clock = 1_000_000
    const { manager, count } = counted({ registryLoader: () => ({ servers: [brokenSpec()], issues: [] }), now: () => clock })
    const hook = createAfterWrite({ manager, warmUp: () => true })
    const failedOnce = async (clients: number) => {
      await until({ check: () => count.clients === clients })
      await until({ check: () => manager.running().length === 0 })
    }
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    await failedOnce(1)

    for (const elapsed of [0, DEFAULT_RETRY_MS - 1]) {
      clock = 1_000_000 + elapsed
      expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
      await Bun.sleep(100)
      expect(count.clients).toBe(1)
    }
    expect(hook.late("s")).toBeUndefined()

    clock = 1_000_000 + DEFAULT_RETRY_MS
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    await failedOnce(2)
    // The memory is the warm-up's alone: asking for diagnostics still tries, and says why it failed.
    const asked = await manager.diagnostics({ path: "a.fake", cwd: root, timeoutMs: 500 })
    expect("unavailable" in asked && asked.unavailable).toContain("fake: language server fake")
  })
})

describe("stopping the manager", () => {
  test("a warm-up that has not started yet never starts", async () => {
    const root = tempDir()
    const log = join(root, "fake.log")
    process.env.FAKE_LOG = log
    put({ root, path: "a.fake", content: "fine\n" })
    const { manager, count } = counted()
    await createAfterWrite({ manager, warmUp: () => true })({ cwd: root, paths: ["a.fake"] })
    await manager.stop()
    await Bun.sleep(150)
    expect({ clients: count.clients, children: children(log), running: manager.running() }).toEqual({ clients: 0, children: [], running: [] })
    // A write after the stop does not bring anything back.
    manager.warm({ paths: ["a.fake"], cwd: root })
    await Bun.sleep(100)
    expect(count.clients).toBe(0)
  })

  test("servers started by warm-ups, mid-handshake or ready, are killed: no child is left", async () => {
    const pids: Array<number | undefined> = []
    const roots = [tempDir(), tempDir()]
    const log = join(roots[0]!, "fake.log")
    process.env.FAKE_LOG = log
    const clients: Array<ReturnType<typeof createLspClient>> = []
    const { manager } = counted({ clientFactory: (options) => { const client = createLspClient(options); clients.push(client); return client } })
    const hook = createAfterWrite({ manager, warmUp: () => true })
    put({ root: roots[0]!, path: "a.fake", content: "fine\n" })
    put({ root: roots[1]!, path: "b.fake", content: "fine\n" })
    await hook({ cwd: roots[0]!, paths: ["a.fake"] })
    await until({ check: () => children(log).length === 1 })
    // The second server is stopped as soon as its process exists, before its handshake can have finished.
    await hook({ cwd: roots[1]!, paths: ["b.fake"] })
    await until({ check: () => clients.length === 2 && clients[1]!.pid !== undefined })
    pids.push(...clients.map((client) => client.pid))
    await manager.stop()
    await until({ check: () => pids.every((pid) => !alive(pid!)) })
    expect(pids).toHaveLength(2)
    expect(children(log).every((pid) => !alive(pid))).toBe(true)
    expect(manager.running()).toEqual([])
  })
})

describe("a failed bootstrap is remembered", () => {
  const context = (cwd: string) => ({ cwd, signal: new AbortController().signal })
  const missingSpec = (): LspServerSpec => ({ id: "fake", command: ["fake-ls", FAKE_LSP], extensions: [".fake"], rootMarkers: [] })
  const REASON = "pnpm add --offline fake-ls exited with code 1"

  test("the second diagnostics call answers at once with the same message; provisioning is retried after ten minutes", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "ERROR\n" })
    let clock = 5_000
    let provisions = 0
    const { manager } = counted({
      registryLoader: () => ({ servers: [missingSpec()], issues: [] }),
      now: () => clock,
      bootstrap: async ({ explain }) => {
        provisions++
        await Bun.sleep(200)
        explain?.(REASON)
        return undefined
      },
    })
    const tool = createDiagnosticsTool(manager)
    const first = await timed(() => tool.execute({ path: "a.fake" }, context(root)))
    expect(first.value.output).toBe(`diagnostics unavailable: fake: fake-ls is not installed (not found on PATH); offline provisioning failed (${REASON}), next attempt in 10 min; install it to get diagnostics for .fake files`)
    expect(first.ms).toBeGreaterThanOrEqual(190)

    const second = await timed(() => tool.execute({ path: "a.fake" }, context(root)))
    expect(second.value.output).toBe(first.value.output)
    expect(second.ms).toBeLessThan(budgetMs(20))
    // `lsp` shares the memory.
    const query = await timed(() => manager.query({ cwd: root, filePath: "a.fake", line: 1, character: 1, operation: "hover" }))
    expect(query.value.unavailable).toBe(`fake: fake-ls is not installed; offline provisioning failed (${REASON}), next attempt in 10 min; install the language server locally`)
    expect(query.ms).toBeLessThan(budgetMs(20))
    clock = 5_000 + DEFAULT_RETRY_MS - 1
    await tool.execute({ path: "a.fake" }, context(root))
    expect(provisions).toBe(1)

    clock = 5_000 + DEFAULT_RETRY_MS
    expect((await tool.execute({ path: "a.fake" }, context(root))).output).toBe(first.value.output)
    expect(provisions).toBe(2)
    await tool.execute({ path: "a.fake" }, context(root))
    expect(provisions).toBe(2)
  })

  test("a binary that appears in the project's node_modules is used at once, inside the interval", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "ERROR\n" })
    let provisions = 0
    const { manager } = counted({ registryLoader: () => ({ servers: [missingSpec()], issues: [] }), now: () => 0, bootstrap: async () => (provisions++, undefined) })
    const tool = createDiagnosticsTool(manager)
    expect((await tool.execute({ path: "a.fake" }, context(root))).output).toContain("fake-ls is not installed")
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
    symlinkSync(process.execPath, join(root, "node_modules", ".bin", "fake-ls"))
    expect((await tool.execute({ path: "a.fake" }, context(root))).output).toBe(ERROR_LINE("a.fake"))
    expect(provisions).toBe(1)
  })

  test("a cancelled provisioning is not remembered; each project root has its own memory", async () => {
    const roots = [tempDir(), tempDir()]
    for (const root of roots) put({ root, path: "a.fake", content: "fine\n" })
    let provisions = 0
    const { manager } = counted({ registryLoader: () => ({ servers: [missingSpec()], issues: [] }), bootstrap: async () => (provisions++, undefined) })
    const cancelled = new AbortController()
    const pending = manager.diagnostics({ path: "a.fake", cwd: roots[0]!, signal: cancelled.signal })
    cancelled.abort()
    expect(await pending).toEqual({ unavailable: "cancelled" })
    const before = provisions
    await manager.diagnostics({ path: "a.fake", cwd: roots[0]! })
    await manager.diagnostics({ path: "a.fake", cwd: roots[0]! })
    expect(provisions).toBe(before + 1)
    await manager.diagnostics({ path: "a.fake", cwd: roots[1]! })
    expect(provisions).toBe(before + 2)
  })

  test("the offline bootstrap says why it provisioned nothing, to every caller of a shared install", async () => {
    const result = (output = "", patch: Partial<Awaited<ReturnType<typeof runManaged>>> = {}) => ({ output, truncated: false, exitCode: 0, timedOut: false, cancelled: false, durationMs: 1, ...patch })
    const spec = DEFAULT_SERVERS[0]!
    const reasons = async (which: (binary: string) => string | null, run: typeof runManaged) => {
      const bootstrap = createOfflineBootstrap({ cacheDir: tempDir(), which, run })
      const said: string[] = []
      const cwd = tempDir()
      expect(await Promise.all([bootstrap({ spec, cwd, explain: (why) => said.push(why) }), bootstrap({ spec, cwd, explain: (why) => said.push(why) })])).toEqual([undefined, undefined])
      return said
    }
    const pnpm = (binary: string) => binary === "pnpm" ? "/fake/pnpm" : null
    expect(await reasons(() => null, async () => result())).toEqual(["pnpm is not on PATH", "pnpm is not on PATH"])
    expect(await reasons(pnpm, async () => result("10.2.0"))).toEqual(["pnpm 11 or newer is required", "pnpm 11 or newer is required"])
    const miss = "pnpm add --offline typescript-language-server typescript exited with code 1"
    expect(await reasons(pnpm, async (input) => input.argv[1] === "--version" ? result("11.17.0") : result("cache miss", { exitCode: 1 }))).toEqual([miss, miss])
    expect(await reasons(pnpm, async (input) => input.argv[1] === "--version" ? result("11.17.0") : result("", { exitCode: 1, timedOut: true }))).toEqual(Array(2).fill("pnpm add --offline typescript-language-server typescript timed out"))
  })
})
