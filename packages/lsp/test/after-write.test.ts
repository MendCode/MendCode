import { afterEach, describe, expect, test } from "bun:test"
import { budgetMs } from "../../../scripts/test-budget"
import { createAfterWrite, createFormatterManager, createLspManager, loadLspRegistry, type FormatterManager, type LspManager, type LspServerSpec } from "../src"
import { fakeSpec, put, setupLspTestCleanup, tempDir, until } from "./helpers"

setupLspTestCleanup()

const managers: Array<LspManager | FormatterManager> = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()))
})
const track = <T extends LspManager | FormatterManager>(manager: T): T => (managers.push(manager), manager)
const fakeManager = (settleMs = 150, servers: LspServerSpec[] = [fakeSpec()]) => track(createLspManager({ registryLoader: () => ({ servers, issues: [] }), settleMs }))
const ERROR_LINE = (file: string, line = 1) => `${file}:${line}:1 error E001 found ERROR on line ${line}`
const timed = async <T>(work: () => Promise<T>) => {
  const start = performance.now()
  const value = await work()
  return { value, ms: performance.now() - start }
}
/** Polls `late` until it hands something out; a second read then proves it was handed out once. */
const lateText = async (hook: ReturnType<typeof createAfterWrite>, sessionId: string) => {
  let text: string | undefined
  await until({ check: () => (text = hook.late(sessionId)) !== undefined })
  return text
}

describe("a write with nothing to wait for", () => {
  test("no formatter configured and no language server running: returns at once, looks nothing up and starts nothing", async () => {
    const root = tempDir()
    put({ root, path: "package.json", content: "{}" })
    put({ root, path: "tsconfig.json", content: "{}" })
    put({ root, path: "src/a.ts", content: "export const a: number = 'no'\n" })
    const lookups: string[] = []
    let provisions = 0
    let spawns = 0
    // The builtin registry: TypeScript, Biome, Oxlint and ESLint all claim a .ts file.
    const manager = track(createLspManager({
      registryLoader: (directory) => loadLspRegistry({ directory }),
      which: (binary) => (lookups.push(binary), null),
      bootstrap: async () => (provisions++, undefined),
      clientFactory: () => { spawns++; throw new Error("a write must not start a language server") },
    }))
    const hook = createAfterWrite({ manager, formatter: track(createFormatterManager()), budgetMs: 4_000 })
    await hook({ cwd: root, paths: ["src/a.ts"], sessionId: "s" })
    const { value, ms } = await timed(() => hook({ cwd: root, paths: ["src/a.ts"], sessionId: "s" }))
    expect(value).toBeUndefined()
    expect(ms).toBeLessThan(budgetMs(10))
    expect({ lookups, provisions, spawns, running: manager.running() }).toEqual({ lookups: [], provisions: 0, spawns: 0, running: [] })
    expect(hook.late("s")).toBeUndefined()
  })

  test("a server running for another file type is not a reason to resolve or start one for this file", async () => {
    const root = tempDir()
    put({ root, path: "ok.fake", content: "fine\n" })
    put({ root, path: "main.go", content: "package main\n" })
    const lookups: string[] = []
    let provisions = 0
    const manager = track(createLspManager({
      registryLoader: () => ({ servers: [fakeSpec(), { id: "go", command: ["gopls"], extensions: [".go"], rootMarkers: [] }], issues: [] }),
      settleMs: 20,
      which: (binary) => (lookups.push(binary), null),
      bootstrap: async () => (provisions++, undefined),
    }))
    await manager.diagnostics({ path: "ok.fake", cwd: root })
    expect(manager.running()).toHaveLength(1)
    lookups.length = 0
    const { value, ms } = await timed(() => createAfterWrite({ manager })({ cwd: root, paths: ["main.go"] }))
    expect(value).toBeUndefined()
    expect(ms).toBeLessThan(budgetMs(20))
    expect({ lookups, provisions, running: manager.running().length }).toEqual({ lookups: [], provisions: 0, running: 1 })
  })
})

describe("a write while a language server is running", () => {
  test("errors published within the bound are in the write's own result and are not repeated later", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "fine\n" })
    const manager = fakeManager(20)
    await manager.diagnostics({ path: "a.fake", cwd: root })
    const hook = createAfterWrite({ manager, diagnosticsWaitMs: 2_000 })
    put({ root, path: "a.fake", content: "ERROR\n" })
    const { value, ms } = await timed(() => hook({ cwd: root, paths: ["a.fake"], sessionId: "s" }))
    expect(value).toBe(`\n\nDiagnostics:\n${ERROR_LINE("a.fake")}`)
    expect(ms).toBeLessThan(budgetMs(1_000))
    expect(hook.late("s")).toBeUndefined()
  })

  test("the wait ends at the bound; what the server says afterwards is handed out once, to that session only", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "fine\n" })
    const manager = fakeManager(50)
    await manager.diagnostics({ path: "a.fake", cwd: root })
    const hook = createAfterWrite({ manager, budgetMs: 4_000, diagnosticsWaitMs: 100 })
    put({ root, path: "a.fake", content: "SLOW500\nERROR\n" })
    const { value, ms } = await timed(() => hook({ cwd: root, paths: ["a.fake"], sessionId: "s" }))
    expect(value).toBeUndefined()
    expect(ms).toBeGreaterThanOrEqual(90)
    expect(ms).toBeLessThan(budgetMs(350))
    expect(hook.late("s")).toBeUndefined()
    expect(await lateText(hook, "s")).toBe(`\n\nDiagnostics:\n${ERROR_LINE("a.fake", 2)}`)
    expect(hook.late("s")).toBeUndefined()
    expect(hook.late("other")).toBeUndefined()
  })

  test("errors already shown at the bound are not sent again when the server settles with the same ones", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "fine\n" })
    // The server answers in a few ms but only counts as quiet after 300 ms, beyond the 150 ms bound.
    const manager = fakeManager(300)
    await manager.diagnostics({ path: "a.fake", cwd: root })
    const hook = createAfterWrite({ manager, diagnosticsWaitMs: 150 })
    put({ root, path: "a.fake", content: "ERROR\n" })
    const { value, ms } = await timed(() => hook({ cwd: root, paths: ["a.fake"], sessionId: "s" }))
    expect(value).toBe(`\n\nDiagnostics:\n${ERROR_LINE("a.fake")}`)
    expect(ms).toBeLessThan(budgetMs(290))
    await Bun.sleep(400)
    expect(hook.late("s")).toBeUndefined()
  })

  test("late errors join the session's next write result; a newer write of the same file replaces the older wait", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "fine\n" })
    put({ root, path: "b.fake", content: "fine\n" })
    const manager = fakeManager(30)
    await manager.diagnostics({ path: "a.fake", cwd: root })
    await manager.diagnostics({ path: "b.fake", cwd: root })
    const hook = createAfterWrite({ manager, budgetMs: 4_000, diagnosticsWaitMs: 60 })
    put({ root, path: "a.fake", content: "SLOW300\nERROR\n" })
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    await Bun.sleep(500)
    // The next write is of another file and is clean itself: its result carries a.fake's late error.
    put({ root, path: "b.fake", content: "still fine\n" })
    expect(await hook({ cwd: root, paths: ["b.fake"], sessionId: "s" })).toBe(`\n\nDiagnostics:\n${ERROR_LINE("a.fake", 2)}`)
    expect(hook.late("s")).toBeUndefined()

    // An error still on its way is dropped when the same file is written again and comes out clean.
    put({ root, path: "a.fake", content: "SLOW300\nSLOWER\nERROR\n" })
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    put({ root, path: "a.fake", content: "fixed\n" })
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    await Bun.sleep(600)
    expect(hook.late("s")).toBeUndefined()
  })

  test("late output is bounded to 20 lines however many errors arrive", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "fine\n" })
    const manager = fakeManager(30)
    await manager.diagnostics({ path: "a.fake", cwd: root })
    const hook = createAfterWrite({ manager, diagnosticsWaitMs: 50 })
    put({ root, path: "a.fake", content: `SLOW250\n${"ERROR\n".repeat(40)}` })
    expect(await hook({ cwd: root, paths: ["a.fake"], sessionId: "s" })).toBeUndefined()
    const lines = (await lateText(hook, "s"))!.split("\n")
    expect(lines.slice(0, 3)).toEqual(["", "", "Diagnostics:"])
    expect(lines).toHaveLength(3 + 21)
    expect(lines.at(-1)).toBe("… 20 more")
  })
})
