import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_SERVERS,
  FrameDecoder,
  STDERR_LIMIT_BYTES,
  createAfterWrite,
  createDiagnosticsTool,
  createLspClient,
  createLspManager,
  encodeMessage,
  findRoot,
  formatDiagnosticsResult,
  loadLspRegistry,
  resolveCommand,
  type LspClient,
  type LspClock,
  type LspManager,
  type LspServerSpec,
} from "../src"
import { FAKE_LSP, alive, fakeSpec, put, setupLspTestCleanup, tempDir, until } from "./helpers"

setupLspTestCleanup()

const managers: LspManager[] = []
const clients: LspClient[] = []
afterEach(async () => {
  await Promise.all([...managers.splice(0).map((m) => m.stop()), ...clients.splice(0).map((c) => c.close())])
})
const registry = (servers: LspServerSpec[] = [fakeSpec()]) => () => ({ servers, issues: [] })
const newManager = (input: Parameters<typeof createLspManager>[0] = {}) => {
  const manager = createLspManager({ registryLoader: registry(), settleMs: 150, ...input })
  managers.push(manager)
  return manager
}
const logOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])

describe("framing", () => {
  const a = { jsonrpc: "2.0", id: 1, result: "héllo ✓" }
  const b = { jsonrpc: "2.0", method: "x", params: { n: 2 } }
  test("decodes concatenated messages in one chunk", () => {
    expect(new FrameDecoder().push(Buffer.concat([encodeMessage(a), encodeMessage(b)]))).toEqual([a, b])
  })
  test("decodes messages split at every byte boundary, including inside multi-byte characters", () => {
    const bytes = Buffer.concat([encodeMessage(a), encodeMessage(b)])
    const decoder = new FrameDecoder()
    const out: unknown[] = []
    for (const byte of bytes) out.push(...decoder.push(Uint8Array.of(byte)))
    expect(out).toEqual([a, b])
  })
  test("skips a frame without Content-Length and a malformed body but stays in sync", () => {
    const decoder = new FrameDecoder()
    const bad = Buffer.from("Content-Length: 3\r\n\r\n{{{")
    const noLength = Buffer.from("X-Other: 1\r\n\r\n")
    expect(decoder.push(Buffer.concat([noLength, bad, encodeMessage(b)]))).toEqual([b])
  })
})

describe("registry", () => {
  test("defaults cover typescript, python, go and rust with extensions and root markers", () => {
    expect(DEFAULT_SERVERS.slice(0, 4).map((s) => s.id)).toEqual(["typescript", "python", "go", "rust"])
    const ts = DEFAULT_SERVERS[0]!
    expect(ts.command).toEqual(["typescript-language-server", "--stdio"])
    expect(ts.extensions).toContain(".tsx")
    expect(ts.rootMarkers).toContain("tsconfig.json")
    expect(DEFAULT_SERVERS[1]!.fallbacks).toEqual([["basedpyright-langserver", "--stdio"]])
  })
  test(".mendcode/lsp.json overrides, disables and adds servers; invalid ones are reported", async () => {
    const directory = tempDir()
    put({
      root: directory,
      path: ".mendcode/lsp.json",
      content: JSON.stringify({
        servers: {
          go: { command: ["my-gopls", "serve"] },
          rust: { disabled: true },
          typescript: { extensions: [".ts"] },
          zig: { command: ["zls"], extensions: [".zig"], rootMarkers: ["build.zig"] },
          half: { command: ["x"] },
          broken: { extensions: ["ts"] },
        },
      }),
    })
    const { servers, issues } = await loadLspRegistry({ directory })
    expect(servers.map((s) => s.id).sort()).toEqual([...DEFAULT_SERVERS.filter((server) => server.id !== "rust").map((server) => server.id), "zig"].sort())
    expect(servers.find((s) => s.id === "go")).toMatchObject({ command: ["my-gopls", "serve"], extensions: [".go"], rootMarkers: ["go.work", "go.mod"] })
    expect(servers.find((s) => s.id === "typescript")).toMatchObject({ extensions: [".ts"], command: ["typescript-language-server", "--stdio"] })
    expect(servers.find((s) => s.id === "zig")).toMatchObject({ command: ["zls"], extensions: [".zig"] })
    expect(issues.map((i) => i.server).sort()).toEqual(["broken", "half"])
  })
  test("no config file means defaults; invalid JSON is an issue, not a throw", async () => {
    const directory = tempDir()
    expect((await loadLspRegistry({ directory })).servers).toHaveLength(DEFAULT_SERVERS.length)
    put({ root: directory, path: ".mendcode/lsp.json", content: "{ nope" })
    const loaded = await loadLspRegistry({ directory })
    expect(loaded.servers).toHaveLength(DEFAULT_SERVERS.length)
    expect(loaded.issues[0]?.message).toContain("invalid JSON")
  })
  test("resolveCommand picks the first installed candidate and never installs anything", () => {
    const python = DEFAULT_SERVERS[1]!
    expect(resolveCommand({ spec: python, which: (b) => (b === "pyright-langserver" ? "/bin/pyright-langserver" : null) })).toEqual(["pyright-langserver", "--stdio"])
    expect(resolveCommand({ spec: python, which: (b) => (b === "basedpyright-langserver" ? "/bin/x" : null) })).toEqual(["basedpyright-langserver", "--stdio"])
    expect(resolveCommand({ spec: python, which: () => null })).toBeUndefined()
  })
  test("findRoot picks the nearest marker below cwd, else cwd", async () => {
    const root = tempDir()
    put({ root, path: "pkg/a/package.json", content: "{}" })
    put({ root, path: "pkg/a/src/deep/x.ts", content: "" })
    const exists = async (p: string) => existsSync(p)
    expect(await findRoot({ file: join(root, "pkg/a/src/deep/x.ts"), cwd: root, markers: ["package.json"], exists })).toBe(join(root, "pkg/a"))
    expect(await findRoot({ file: join(root, "pkg/a/src/deep/x.ts"), cwd: root, markers: ["nothing.json"], exists })).toBe(root)
  })
})

describe("client", () => {
  const newClient = (root: string) => {
    const client = createLspClient({ id: "fake", command: [process.execPath, FAKE_LSP], root })
    clients.push(client)
    return client
  }
  test("handshakes, syncs with versions and collects diagnostics with 1-based positions", async () => {
    const root = tempDir()
    const log = join(root, "log.jsonl")
    process.env.FAKE_LOG = log
    const client = newClient(root)
    const file = join(root, "a.fake")
    const first = await client.sync({ path: file, languageId: "fake", text: "ok\nsome ERROR here\n" })
    expect(first.changed).toBe(true)
    const waited = await client.waitForDiagnostics({ path: file, after: first.after, settleMs: 100, timeoutMs: 3000 })
    expect(waited).toEqual({ settled: true, diagnostics: [{ line: 2, col: 6, severity: "error", message: "found ERROR on line 2", source: "fake", code: "E001" }] })
    const same = await client.sync({ path: file, languageId: "fake", text: "ok\nsome ERROR here\n" })
    expect(same.changed).toBe(false)
    const second = await client.sync({ path: file, languageId: "fake", text: "all good\n" })
    expect(second.after).toBe(1)
    expect((await client.waitForDiagnostics({ path: file, after: second.after, settleMs: 100, timeoutMs: 3000 })).diagnostics).toEqual([])
    const entries = logOf(log)
    expect(entries.find((e) => e.method === "initialize")).toMatchObject({ rootUri: `file://${root}`, publish: { versionSupport: true } })
    expect(entries.filter((e) => e.method?.startsWith("textDocument/")).map((e) => [e.method, e.version])).toEqual([["textDocument/didOpen", 1], ["textDocument/didChange", 2]])
    await until({ check: () => logOf(log).filter((e) => e.response).length === 2 })
    expect(logOf(log).filter((e) => e.response).map((e) => [e.response, e.result])).toEqual([[9001, [null, null]], [9002, null]])
  })
  test("works when the server writes in tiny pieces", async () => {
    process.env.FAKE_CHUNKY = "1"
    const root = tempDir()
    const client = newClient(root)
    const file = join(root, "a.fake")
    const { after } = await client.sync({ path: file, languageId: "fake", text: "ERROR" })
    expect((await client.waitForDiagnostics({ path: file, after, settleMs: 100, timeoutMs: 5000 })).diagnostics).toHaveLength(1)
  })
  test("settles on the last publish: an early empty publish does not end the wait", async () => {
    process.env.FAKE_DOUBLE = "1"
    const root = tempDir()
    const client = newClient(root)
    const file = join(root, "a.fake")
    const { after } = await client.sync({ path: file, languageId: "fake", text: "ERROR" })
    const waited = await client.waitForDiagnostics({ path: file, after, settleMs: 400, timeoutMs: 5000 })
    expect(waited.settled).toBe(true)
    expect(waited.diagnostics).toHaveLength(1)
  })
  test("a wait with no publish ends at the timeout with unknown diagnostics", async () => {
    const root = tempDir()
    const client = newClient(root)
    await client.start()
    const started = Date.now()
    const waited = await client.waitForDiagnostics({ path: join(root, "never.fake"), after: 0, settleMs: 100, timeoutMs: 300 })
    expect(waited).toEqual({ diagnostics: undefined, settled: false })
    expect(Date.now() - started).toBeLessThan(1500)
  })
  test("stderr is a bounded ring buffer keeping the newest output", async () => {
    const root = tempDir()
    const client = newClient(root)
    const file = join(root, "a.fake")
    await client.sync({ path: file, languageId: "fake", text: "SPAM" })
    await until({ check: () => client.stderr().length > STDERR_LIMIT_BYTES / 2 })
    await Bun.sleep(200)
    expect(Buffer.byteLength(client.stderr())).toBeLessThanOrEqual(STDERR_LIMIT_BYTES)
  })
  test("a server that cannot start reports an error", async () => {
    const client = createLspClient({ id: "x", command: ["/nonexistent/binary"], root: tempDir() })
    clients.push(client)
    await expect(client.start()).rejects.toThrow(/could not start/)
  })
  test("close kills the process group", async () => {
    const root = tempDir()
    const client = newClient(root)
    await client.start()
    const pid = client.pid!
    await client.close()
    await until({ check: () => !alive(pid) })
    await expect(client.start()).rejects.toThrow(/closed/)
  })
})

describe("manager", () => {
  test("is lazy: nothing runs until a file is checked, and one server serves a root", async () => {
    const root = tempDir()
    put({ root, path: "fake.marker", content: "" })
    put({ root, path: "a.fake", content: "fine\n" })
    put({ root, path: "sub/b.fake", content: "has ERROR\n" })
    const manager = newManager()
    expect(manager.running()).toEqual([])
    expect(await manager.diagnostics({ path: "a.fake", cwd: root })).toEqual({ file: join(root, "a.fake"), diagnostics: [], settled: true })
    const second = await manager.diagnostics({ path: "sub/b.fake", cwd: root })
    expect(second).toMatchObject({ file: join(root, "sub/b.fake"), diagnostics: [{ line: 1, col: 5, severity: "error", code: "E001" }] })
    expect(manager.running().map((r) => r.server)).toEqual(["fake"])
  })
  test("uses the given content instead of the disk, and does not wait again when nothing changed", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "fine\n" })
    const manager = newManager({ settleMs: 300 })
    const dirty = await manager.diagnostics({ path: "a.fake", cwd: root, content: "ERROR\n" })
    expect("diagnostics" in dirty && dirty.diagnostics).toHaveLength(1)
    const started = Date.now()
    const again = await manager.diagnostics({ path: "a.fake", cwd: root, content: "ERROR\n" })
    expect(Date.now() - started).toBeLessThan(200)
    expect("diagnostics" in again && again.diagnostics).toHaveLength(1)
    const fixed = await manager.diagnostics({ path: "a.fake", cwd: root, content: "fine\n" })
    expect("diagnostics" in fixed && fixed.diagnostics).toEqual([])
  })
  test("separate roots get separate servers", async () => {
    const root = tempDir()
    put({ root, path: "one/fake.marker", content: "" })
    put({ root, path: "one/a.fake", content: "" })
    put({ root, path: "two/fake.marker", content: "" })
    put({ root, path: "two/a.fake", content: "" })
    const manager = newManager()
    await manager.diagnostics({ path: "one/a.fake", cwd: root })
    await manager.diagnostics({ path: "two/a.fake", cwd: root })
    expect(manager.running().map((r) => r.root).sort()).toEqual([join(root, "one"), join(root, "two")])
  })
  test("unavailable: unknown extension, missing binary, unreadable file", async () => {
    const root = tempDir()
    put({ root, path: "a.txt", content: "" })
    const manager = newManager({ registryLoader: registry([fakeSpec(), { id: "go", command: ["gopls"], extensions: [".go"], rootMarkers: [] }]), which: (b) => (b === "gopls" ? null : "/x") })
    expect(await manager.diagnostics({ path: "a.txt", cwd: root })).toEqual({ unavailable: "no language server configured for .txt" })
    const missing = await manager.diagnostics({ path: "main.go", cwd: root })
    expect("unavailable" in missing && missing.unavailable).toContain("gopls is not installed")
    expect(await manager.diagnostics({ path: "gone.fake", cwd: root })).toEqual({ unavailable: `cannot read ${join(root, "gone.fake")}` })
    expect(manager.running()).toEqual([])
  })
  test("stops idle servers using the injected clock and starts again on next use", async () => {
    const timers = new Map<number, { callback: () => void; ms: number }>()
    let next = 1
    const clock: LspClock = { setTimeout: (callback, ms) => (timers.set(next, { callback, ms }), next++), clearTimeout: (h) => void timers.delete(h as number) }
    const root = tempDir()
    put({ root, path: "a.fake", content: "" })
    const manager = newManager({ clock, idleMs: 4321 })
    await manager.diagnostics({ path: "a.fake", cwd: root, content: "x" })
    const pid = manager.running()[0]!.pid!
    expect([...timers.values()].map((t) => t.ms)).toEqual([4321])
    for (const [id, timer] of [...timers]) (timers.delete(id), timer.callback())
    expect(manager.running()).toEqual([])
    await until({ check: () => !alive(pid) })
    await manager.diagnostics({ path: "a.fake", cwd: root, content: "x" })
    expect(manager.running()[0]!.pid).not.toBe(pid)
  })
  test("a crash mid-check restarts the server once; a server that keeps crashing reports unavailable", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "" })
    const manager = newManager()
    await manager.diagnostics({ path: "a.fake", cwd: root, content: "fine" })
    const before = manager.running()[0]!.pid!
    const crashed = await manager.diagnostics({ path: "a.fake", cwd: root, content: "CRASH" })
    expect("unavailable" in crashed && crashed.unavailable).toMatch(/stopped while waiting|exited/)
    const recovered = await manager.diagnostics({ path: "a.fake", cwd: root, content: "ERROR" })
    expect("diagnostics" in recovered && recovered.diagnostics).toHaveLength(1)
    expect(manager.running()[0]!.pid).not.toBe(before)
    await until({ check: () => !alive(before) })
  })
  test("a timeout with no publish still returns (not settled) and keeps the server", async () => {
    process.env.FAKE_DELAY = "1500"
    const root = tempDir()
    const manager = newManager()
    const result = await manager.diagnostics({ path: "a.fake", cwd: root, content: "ERROR", timeoutMs: 300 })
    expect(result).toEqual({ file: join(root, "a.fake"), diagnostics: [], settled: false })
    expect(manager.running()).toHaveLength(1)
  })
  test("stop leaves no processes and clears timers", async () => {
    const root = tempDir()
    put({ root, path: "one/fake.marker", content: "" })
    const manager = createLspManager({ registryLoader: registry(), settleMs: 100 })
    await manager.diagnostics({ path: "a.fake", cwd: root, content: "x" })
    await manager.diagnostics({ path: "one/a.fake", cwd: root, content: "x" })
    const pids = manager.running().map((r) => r.pid!)
    expect(pids).toHaveLength(2)
    expect(pids.every(alive)).toBe(true)
    await manager.stop()
    expect(manager.running()).toEqual([])
    await until({ check: () => pids.every((pid) => !alive(pid)) })
  })
})

describe("tool and afterWrite", () => {
  const context = (cwd: string) => ({ cwd, signal: new AbortController().signal })
  test("formats errors first, positions, codes, and 'no problems'", async () => {
    const root = tempDir()
    put({ root, path: "src/bad.fake", content: "ok\nERROR one\nERROR two\n" })
    put({ root, path: "src/good.fake", content: "fine\n" })
    const tool = createDiagnosticsTool(newManager())
    const bad = await tool.execute({ path: "src/bad.fake" }, context(root))
    expect(bad.output).toBe("src/bad.fake:2:1 error E001 found ERROR on line 2\nsrc/bad.fake:3:1 error E001 found ERROR on line 3")
    expect(bad).toMatchObject({ isError: false, meta: { available: true, problems: 2 } })
    expect((await tool.execute({ path: "src/good.fake" }, context(root))).output).toBe("no problems")
    expect(tool).toMatchObject({ name: "diagnostics", permission: "read" })
  })
  test("says clearly when no language server is available", async () => {
    const root = tempDir()
    const tool = createDiagnosticsTool(newManager({ registryLoader: registry([{ id: "go", command: ["gopls"], extensions: [".go"], rootMarkers: [] }]), which: () => null }))
    const result = await tool.execute({ path: "main.go" }, context(root))
    expect(result.output).toContain("diagnostics unavailable: go: gopls is not installed")
    expect(result).toMatchObject({ isError: false, meta: { available: false } })
  })
  test("orders severities, caps the list at 50 and clips long messages", () => {
    const diagnostics = [
      ...Array.from({ length: 60 }, (_, i) => ({ line: i + 1, col: 1, severity: "warning" as const, message: "w" })),
      { line: 99, col: 2, severity: "error" as const, message: "e".repeat(500), code: "X1" },
    ]
    const lines = formatDiagnosticsResult({ result: { file: "/p/a.ts", diagnostics, settled: true }, cwd: "/p" }).split("\n")
    expect(lines).toHaveLength(51)
    expect(lines[0]).toMatch(/^a\.ts:99:2 error X1 e+…$/)
    expect(lines[1]).toBe("a.ts:1:1 warning w")
    expect(lines.at(-1)).toBe("… 11 more")
    expect(formatDiagnosticsResult({ result: { file: "/p/a.ts", diagnostics: [], settled: false }, cwd: "/p" })).toContain("results may be incomplete")
  })
  test("afterWrite returns only errors of written files, and nothing when clean or unavailable", async () => {
    const root = tempDir()
    put({ root, path: "a.fake", content: "ERROR\n" })
    put({ root, path: "b.fake", content: "fine\n" })
    const manager = newManager()
    const afterWrite = createAfterWrite({ manager, budgetMs: 3000, diagnosticsWaitMs: 2000 })
    // The hook reads only servers that already run; `diagnostics` is what starts one.
    await manager.diagnostics({ path: "b.fake", cwd: root })
    expect(await afterWrite({ cwd: root, paths: ["a.fake", "b.fake", "c.txt"] })).toBe("\n\nDiagnostics:\na.fake:1:1 error E001 found ERROR on line 1")
    expect(await afterWrite({ cwd: root, paths: ["b.fake", "c.txt"] })).toBeUndefined()
  })
})
