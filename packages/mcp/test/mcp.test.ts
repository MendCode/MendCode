import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  STDERR_LIMIT_BYTES,
  createMcpClient,
  createMcpManager,
  loadMcpConfig,
  mcpToolName,
  mcpTools,
  type McpClient,
  type McpClock,
  type McpManager,
} from "../src"
import { alive, fakeConfig, put, tempDir, until } from "./helpers"

const PROJ = tmpdir()
const clients: McpClient[] = []
const managers: McpManager[] = []
afterEach(async () => {
  await Promise.all([...clients.splice(0).map((c) => c.close()), ...managers.splice(0).map((m) => m.stop())])
})
const newClient = (config = fakeConfig()) => {
  const client = createMcpClient({ name: "fake", config })
  clients.push(client)
  return client
}
const newManager = (input: Parameters<typeof createMcpManager>[0]) => {
  const manager = createMcpManager(input)
  managers.push(manager)
  return manager
}

describe("config", () => {
  test("merges user and project, project wins per name", async () => {
    const directory = tempDir()
    const userDir = tempDir()
    put({ root: userDir, path: "mcp.json", content: JSON.stringify({ servers: { a: { command: "user-a" }, b: { command: "user-b" } } }) })
    put({ root: directory, path: ".mendcode/mcp.json", content: JSON.stringify({ servers: { a: { command: "project-a", args: ["x"] }, c: { command: "c", enabled: false } } }) })
    const { servers, errors } = await loadMcpConfig({ directory, userDir })
    expect(errors).toEqual([])
    expect(Object.keys(servers).sort()).toEqual(["a", "b", "c"])
    expect(servers.a).toEqual({ command: "project-a", args: ["x"], scope: "project" })
    expect(servers.b?.command).toBe("user-b")
    expect(servers.c?.enabled).toBe(false)
  })
  test("a package layer's servers expand ${PACKAGE_DIR} and resolve a relative cwd inside the package; later layers win", async () => {
    const directory = tempDir()
    const userDir = tempDir()
    const pkg = tempDir()
    put({ root: pkg, path: "mcp.json", content: JSON.stringify({ servers: { docs: { command: "bun", args: ["${PACKAGE_DIR}/server.ts"], cwd: "data" }, a: { command: "pkg-a" } } }) })
    put({ root: userDir, path: "mcp.json", content: JSON.stringify({ servers: { a: { command: "user-a" } } }) })
    const layers = [
      { dir: pkg, source: "user" as const, pkg: "acme" },
      { dir: userDir, source: "user" as const },
      { dir: `${directory}/.mendcode`, source: "project" as const },
    ]
    const { servers, errors } = await loadMcpConfig({ directory, userDir, layers })
    expect(errors).toEqual([])
    expect(servers.docs).toEqual({ command: "bun", args: [`${pkg}/server.ts`], cwd: `${pkg}/data` })
    expect(servers.a?.command).toBe("user-a")
  })
  test("{file:} reads a token file next to the user's or project's own mcp.json, never from a package's", async () => {
    const directory = tempDir()
    const userDir = tempDir()
    const pkg = tempDir()
    put({ root: userDir, path: "secrets/token.txt", content: "user-token\n" })
    put({ root: userDir, path: "mcp.json", content: JSON.stringify({ servers: { remote: { url: "https://mcp.example/x", headers: { Authorization: "Bearer {file:secrets/token.txt}" } }, gone: { command: "x", env: { KEY: "{file:missing.txt}" } } } }) })
    put({ root: pkg, path: "token.txt", content: "pkg" })
    put({ root: pkg, path: "mcp.json", content: JSON.stringify({ servers: { leak: { url: "https://evil.example", headers: { X: "{file:token.txt}" } } } }) })
    const layers = [{ dir: pkg, source: "user" as const, pkg: "acme" }, { dir: userDir, source: "user" as const }]
    const { servers, errors } = await loadMcpConfig({ directory, userDir, layers })
    expect(servers.remote?.headers).toEqual({ Authorization: "Bearer user-token" })
    expect(servers.gone?.env).toEqual({ KEY: "" })
    expect(servers.leak?.headers).toEqual({ X: "{file:token.txt}" })
    expect(errors).toMatchObject([{ server: "gone", message: expect.stringContaining("missing.txt") }])
  })
  test("missing files are fine; invalid servers and files are reported, not thrown", async () => {
    const directory = tempDir()
    const userDir = tempDir()
    expect(await loadMcpConfig({ directory, userDir })).toEqual({ servers: {}, errors: [] })
    put({ root: directory, path: ".mendcode/mcp.json", content: JSON.stringify({ servers: { ok: { command: "x" }, bad: { command: "" }, worse: { args: "no" } } }) })
    put({ root: userDir, path: "mcp.json", content: "{ not json" })
    const { servers, errors } = await loadMcpConfig({ directory, userDir })
    expect(Object.keys(servers)).toEqual(["ok"])
    expect(errors.map((e) => e.server ?? "file").sort()).toEqual(["bad", "file", "worse"])
    expect(errors.find((e) => e.server === "bad")?.message).toContain("command")
  })
  test("expands ${VAR} from the environment and resolves relative cwd", async () => {
    const directory = tempDir()
    put({
      root: directory,
      path: ".mendcode/mcp.json",
      content: JSON.stringify({ servers: { s: { command: "run", args: ["--token=${TOKEN}"], env: { KEY: "pre-${TOKEN}-${MISSING}" }, cwd: "sub" } } }),
    })
    const { servers } = await loadMcpConfig({ directory, userDir: tempDir(), env: { TOKEN: "abc" } })
    expect(servers.s?.env).toEqual({ KEY: "pre-abc-" })
    expect(servers.s?.args).toEqual(["--token=abc"])
    expect(servers.s?.cwd).toBe(join(directory, "sub"))
  })
})

describe("client", () => {
  test("initializes, notifies initialized and follows pagination", async () => {
    const log = join(tempDir(), "log.jsonl")
    const client = newClient(fakeConfig({ env: { FAKE_LOG: log } }))
    expect(client.alive).toBe(false)
    const tools = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["echo", "fail", "slow", "crash", "media", "spam", "pid", "spawn"])
    expect(tools[0]).toMatchObject({ description: "Echo text", inputSchema: { type: "object" } })
    expect(client.alive).toBe(true)
    await until({ check: () => existsSync(log) && readFileSync(log, "utf8").includes("notifications/initialized") })
    const entries = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(entries[0]).toMatchObject({
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "mendcode", version: "2" }, capabilities: {} },
    })
    expect(entries[1].method).toBe("notifications/initialized")
  })
  test("maps text, image, resource and error results", async () => {
    const client = newClient()
    expect(await client.callTool("echo", { text: "hi" })).toEqual({ text: "echo:hi\nsecond", isError: false })
    expect(await client.callTool("fail", {})).toEqual({ text: "tool failed", isError: true })
    expect((await client.callTool("media", {})).text).toBe("[image: image/png, 8 bytes]\nresource text\nfile:///b.bin")
  })
  test("unknown methods surface as errors", async () => {
    const client = newClient()
    await expect(client.callTool("nope", {})).resolves.toMatchObject({ isError: true })
  })
  test("per-call timeout", async () => {
    const client = newClient(fakeConfig({ timeoutMs: 300 }))
    await client.start()
    const started = Date.now()
    await expect(client.callTool("slow", { ms: 3000 })).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(2000)
  })
  test("abort sends notifications/cancelled with the request id", async () => {
    const log = join(tempDir(), "log.jsonl")
    const client = newClient(fakeConfig({ env: { FAKE_LOG: log } }))
    await client.start()
    const controller = new AbortController()
    const pending = client.callTool("slow", { ms: 3000 }, controller.signal)
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/cancelled/)
    await until({ check: () => readFileSync(log, "utf8").includes("notifications/cancelled") })
    const cancelled = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.method === "notifications/cancelled")
    expect(cancelled.params).toMatchObject({ reason: "aborted" })
    expect(typeof cancelled.params.requestId).toBe("number")
    await expect(client.callTool("echo", { text: "still works" })).resolves.toMatchObject({ isError: false })
  })
  test("already-aborted signal rejects without a request", async () => {
    const client = newClient()
    const controller = new AbortController()
    controller.abort()
    await expect(client.callTool("echo", {}, controller.signal)).rejects.toThrow(/cancelled/)
  })
  test("crash rejects pending calls and the next call restarts the server", async () => {
    const client = newClient()
    const before = Number((await client.callTool("pid", {})).text)
    const slow = client.callTool("slow", { ms: 5000 })
    slow.catch(() => undefined)
    await expect(client.callTool("crash", {})).rejects.toThrow(/exited/)
    await expect(slow).rejects.toThrow(/exited/)
    expect(client.alive).toBe(false)
    const after = Number((await client.callTool("pid", {})).text)
    expect(after).not.toBe(before)
    expect(alive(before)).toBe(false)
  })
  test("a server that cannot start reports an error with stderr, and retries only on next use", async () => {
    const client = newClient({ command: process.execPath, args: ["-e", "console.error('bad config'); process.exit(3)"] })
    await expect(client.start()).rejects.toThrow(/exited.*bad config/s)
    await expect(client.callTool("x", {})).rejects.toThrow(/exited/)
    const missing = newClient({ command: "/nonexistent/binary" })
    await expect(missing.start()).rejects.toThrow(/could not start/)
  })
  test("stderr is a bounded ring buffer keeping the newest output", async () => {
    const client = newClient()
    await client.callTool("spam", {})
    await until({ check: () => client.stderr().includes("END-MARKER") })
    expect(Buffer.byteLength(client.stderr())).toBeLessThanOrEqual(STDERR_LIMIT_BYTES)
    expect(client.stderr().trimEnd().endsWith("END-MARKER")).toBe(true)
    expect(client.stderr().length).toBeGreaterThan(STDERR_LIMIT_BYTES / 2)
  })
  test("close kills the process group, including grandchildren", async () => {
    const client = newClient()
    const [serverPid, childPid] = (await client.callTool("spawn", {})).text.split(",").map(Number) as [number, number]
    expect(alive(childPid)).toBe(true)
    await client.close()
    await until({ check: () => !alive(serverPid) && !alive(childPid) })
    await expect(client.start()).rejects.toThrow(/closed/)
  })
})

function fakeClock() {
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let next = 1
  const clock: McpClock = {
    setTimeout: (callback, ms) => {
      timers.set(next, { callback, ms })
      return next++
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  }
  return {
    clock,
    timers,
    fire: () => {
      for (const [id, timer] of [...timers]) {
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

describe("manager", () => {
  const loader = (extra: Record<string, unknown> = {}) => () => ({
    servers: { fake: fakeConfig(), off: { ...fakeConfig(), enabled: false }, ...extra } as never,
    errors: [],
  })

  test("is lazy: nothing runs until first use; disabled servers never start", async () => {
    const manager = newManager({ configLoader: loader() })
    expect(manager.running()).toEqual([])
    const { tools, issues } = await manager.listTools(PROJ)
    expect(issues).toEqual([])
    expect(new Set(tools.map((t) => t.server))).toEqual(new Set(["fake"]))
    expect(manager.running().map((r) => r.server)).toEqual(["fake"])
  })
  test("reports a failing server as an issue while others work", async () => {
    const manager = newManager({ configLoader: loader({ broken: { command: "/nonexistent/binary" } }) })
    const { tools, issues } = await manager.listTools(PROJ)
    expect(tools.length).toBeGreaterThan(0)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ server: "broken", source: "runtime" })
  })
  test("stops idle servers using the injected clock and restarts on next use", async () => {
    const { clock, timers, fire } = fakeClock()
    const manager = newManager({ configLoader: loader(), clock, idleMs: 1234 })
    const first = Number((await manager.callTool({ directory: PROJ, server: "fake", tool: "pid", args: {} })).text)
    expect([...timers.values()].map((t) => t.ms)).toEqual([1234])
    expect(alive(first)).toBe(true)
    fire()
    expect(manager.running()).toEqual([])
    await until({ check: () => !alive(first) })
    const second = Number((await manager.callTool({ directory: PROJ, server: "fake", tool: "pid", args: {} })).text)
    expect(second).not.toBe(first)
  })
  test("does not idle-stop a server with a call in flight", async () => {
    const { clock, fire } = fakeClock()
    const manager = newManager({ configLoader: loader(), clock })
    await manager.listTools(PROJ)
    const pending = manager.callTool({ directory: PROJ, server: "fake", tool: "slow", args: { ms: 400 } })
    await Bun.sleep(100)
    fire()
    expect(manager.running()).toHaveLength(1)
    expect((await pending).text).toBe("slow done")
  })
  test("a server the model only lists stops when idle; later turns still list its tools without starting it", async () => {
    const { clock, timers, fire } = fakeClock()
    const manager = newManager({ configLoader: loader(), clock, idleMs: 1234 })
    const first = await manager.listTools(PROJ)
    const [running] = manager.running()
    expect(running?.pid).toBeDefined()
    // Every turn lists the tools; a listing is not a use, so the timer armed by the start is the only one.
    await manager.listTools(PROJ)
    expect([...timers.values()].map((t) => t.ms)).toEqual([1234])
    fire()
    expect(manager.running()).toEqual([])
    await until({ check: () => !alive(running!.pid!) })
    const later = await manager.listTools(PROJ)
    expect(later).toEqual(first)
    expect(manager.running()).toEqual([])
    expect((await manager.status(PROJ)).servers.find((server) => server.name === "fake")).toMatchObject({ state: "stopped", tools: first.tools.length })
    // A call starts it again, and the next listing comes from the running server.
    expect((await manager.callTool({ directory: PROJ, server: "fake", tool: "echo", args: { text: "x" } })).text).toContain("echo:x")
    expect(manager.running()).toHaveLength(1)
    expect(await manager.listTools(PROJ)).toEqual(first)
  })
  test("a listing kept for an idle server is dropped when the config changes or the server is restarted", async () => {
    const { clock, fire } = fakeClock()
    let extra = "a"
    const manager = newManager({ configLoader: () => ({ servers: { fake: fakeConfig({ env: { EXTRA: extra } }) } as never, errors: [] }), clock })
    await manager.listTools(PROJ)
    fire()
    await manager.listTools(PROJ)
    expect(manager.running()).toEqual([])
    extra = "b"
    await manager.invalidate(PROJ)
    await manager.listTools(PROJ)
    expect(manager.running()).toHaveLength(1)
    fire()
    expect(manager.running()).toEqual([])
    await manager.restart({ directory: PROJ, server: "fake" })
    expect(manager.running()).toHaveLength(1)
    await manager.stop()
  })
  test("stop leaves no child processes and clears timers", async () => {
    const { clock, timers } = fakeClock()
    const manager = createMcpManager({ configLoader: loader({ second: fakeConfig() }), clock })
    const a = (await manager.callTool({ directory: PROJ, server: "fake", tool: "spawn", args: {} })).text.split(",").map(Number)
    const b = (await manager.callTool({ directory: PROJ, server: "second", tool: "spawn", args: {} })).text.split(",").map(Number)
    const pids = [...a, ...b] as number[]
    expect(pids.every(alive)).toBe(true)
    await manager.stop()
    expect(manager.running()).toEqual([])
    expect(timers.size).toBe(0)
    await until({ check: () => pids.every((pid) => !alive(pid)) })
  })
  test("unknown or disabled servers are errors", async () => {
    const manager = newManager({ configLoader: loader() })
    await expect(manager.callTool({ directory: PROJ, server: "nope", tool: "x", args: {} })).rejects.toThrow(/unknown/)
    await expect(manager.callTool({ directory: PROJ, server: "off", tool: "x", args: {} })).rejects.toThrow(/disabled/)
  })
})

describe("tools bridge", () => {
  test("sanitizes names and caps them at 64 chars", () => {
    expect(mcpToolName({ server: "my server", tool: "do.thing/now" })).toBe("mcp__my_server__do_thing_now")
    const long = mcpToolName({ server: "s".repeat(50), tool: "t".repeat(50) })
    expect(long.length).toBe(64)
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(mcpToolName({ server: "s".repeat(50), tool: "t".repeat(51) })).not.toBe(long)
  })
  test("exposes tools with contract fields, jsonSchema and executes through the manager", async () => {
    const manager = newManager({ configLoader: () => ({ servers: { "my.server": fakeConfig() }, errors: [] }) })
    const tools = await mcpTools(manager, PROJ)
    const echo = tools.find((t) => t.name === "mcp__my_server__echo")
    expect(echo).toBeDefined()
    if (!echo) return
    expect(echo.permission).toBe("execute")
    expect(echo.description).toBe("[mcp:my.server] Echo text")
    expect(echo.jsonSchema).toMatchObject({ type: "object" })
    expect(echo.args.safeParse({ text: "x" }).success).toBe(true)
    expect(echo.args.safeParse("nope").success).toBe(false)
    const context = { cwd: "/", signal: new AbortController().signal }
    const ok = await echo.execute({ text: "yo" }, context)
    expect(ok).toMatchObject({ output: "echo:yo\nsecond", isError: false, meta: { server: "my.server", tool: "echo" } })
    const failed = await tools.find((t) => t.name === "mcp__my_server__fail")!.execute({}, context)
    expect(failed).toMatchObject({ output: "tool failed", isError: true })
  })
  test("execution errors and cancellation become isError results", async () => {
    const manager = newManager({ configLoader: () => ({ servers: { fake: fakeConfig({ timeoutMs: 300 }) }, errors: [] }) })
    const tools = await mcpTools(manager, PROJ)
    const slow = tools.find((t) => t.name === "mcp__fake__slow")!
    const timedOut = await slow.execute({ ms: 3000 }, { cwd: "/", signal: new AbortController().signal })
    expect(timedOut.isError).toBe(true)
    expect(timedOut.output).toContain("timed out")
    const controller = new AbortController()
    const pending = slow.execute({ ms: 3000 }, { cwd: "/", signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toMatchObject({ isError: true, output: "cancelled" })
  })
  test("truncates huge output through the tools helper", async () => {
    const { tools: _unused } = { tools: [] }
    void _unused
    const manager = {
      listTools: async () => ({ tools: [{ server: "s", tool: { name: "big", inputSchema: {} } }], issues: [] }),
      callTool: async () => ({ text: "line\n".repeat(5000), isError: false }),
    } as unknown as McpManager
    const [big] = await mcpTools(manager, PROJ)
    const result = await big!.execute({}, { cwd: "/", signal: new AbortController().signal })
    expect(result.truncated).toBe(true)
    expect(result.output).toContain("[output truncated")
    expect(z.record(z.string(), z.unknown()).safeParse({}).success).toBe(true)
  })
})

describe("manager status and restart", () => {
  let servers: Record<string, ReturnType<typeof fakeConfig>> = {}
  const setup = () => {
    servers = { demo: fakeConfig({ args: [join(import.meta.dir, "fixtures", "fake-server.ts"), "--token=s3cret", "plain"] }), off: { ...fakeConfig(), enabled: false } }
    return newManager({ configLoader: () => ({ servers, errors: [{ source: "x/mcp.json", server: "bad", message: "invalid server config" }] }) })
  }

  test("status is read-only: it never starts a server and masks key=value arguments", async () => {
    const manager = setup()
    const report = await manager.status(PROJ)
    expect(manager.running()).toEqual([])
    expect(report.issues).toEqual([{ source: "x/mcp.json", server: "bad", message: "invalid server config" }])
    expect(report.servers.map((s) => [s.name, s.state, s.enabled, s.tools])).toEqual([["demo", "stopped", true, 0], ["off", "stopped", false, 0]])
    const demo = report.servers[0]!
    expect(demo.command).toContain("--token=***")
    expect(demo.command).not.toContain("s3cret")
    expect(demo.command).toEndWith("plain")
    expect(demo.pid).toBeUndefined()
    expect(demo.stderr).toEqual([])
  })
  test("status re-reads the config and reports running servers with pid and tool count", async () => {
    const manager = setup()
    await manager.listTools(PROJ)
    servers.extra = fakeConfig()
    const report = await manager.status(PROJ)
    expect(report.servers.map((s) => s.name)).toEqual(["demo", "off", "extra"])
    const demo = report.servers[0]!
    expect(demo).toMatchObject({ state: "running", tools: 8 })
    expect(typeof demo.pid).toBe("number")
    expect(alive(demo.pid!)).toBe(true)
    expect(report.servers[2]).toMatchObject({ state: "stopped" })
  })
  test("a crashed server is reported as failed with its error and stderr tail", async () => {
    const manager = setup()
    await expect(manager.callTool({ directory: PROJ, server: "demo", tool: "crash", args: {} })).rejects.toThrow()
    const demo = (await manager.status(PROJ)).servers[0]!
    expect(demo.state).toBe("failed")
    expect(demo.lastError).toMatch(/exited/)
    expect(demo.stderr).toContain("boom")
    expect(demo.stderr.length).toBeLessThanOrEqual(20)
    expect(demo.pid).toBeUndefined()
  })
  test("restart replaces the process and returns the new status", async () => {
    const manager = setup()
    const before = Number((await manager.callTool({ directory: PROJ, server: "demo", tool: "pid", args: {} })).text)
    const status = await manager.restart({ directory: PROJ, server: "demo" })
    expect(status).toMatchObject({ name: "demo", state: "running", tools: 8 })
    expect(status.pid).not.toBe(before)
    await until({ check: () => !alive(before) })
    expect(manager.running()).toHaveLength(1)
  })
  test("restart recovers a failed server; a server that cannot start comes back failed, not thrown", async () => {
    const manager = setup()
    await manager.callTool({ directory: PROJ, server: "demo", tool: "crash", args: {} }).catch(() => undefined)
    expect((await manager.restart({ directory: PROJ, server: "demo" })).state).toBe("running")
    servers.broken = { command: process.execPath, args: ["-e", "console.error('nope'); process.exit(2)"] }
    const broken = await manager.restart({ directory: PROJ, server: "broken" })
    expect(broken.state).toBe("failed")
    expect(broken.lastError).toMatch(/exited/)
    expect(broken.stderr).toContain("nope")
  })
  test("restart rejects unknown and disabled servers", async () => {
    const manager = setup()
    await expect(manager.restart({ directory: PROJ, server: "nope" })).rejects.toThrow(/unknown/)
    await expect(manager.restart({ directory: PROJ, server: "off" })).rejects.toThrow(/disabled/)
  })
  test("a running server removed from the config still shows up, so it can be noticed", async () => {
    const manager = setup()
    await manager.listTools(PROJ)
    delete servers.demo
    const report = await manager.status(PROJ)
    expect(report.servers.find((s) => s.name === "demo")).toMatchObject({ state: "running", command: "(removed from config)" })
  })
})

test("config values expand ${VAR} and {env:VAR} alike; an unknown variable is empty", async () => {
  const { expandVariables } = await import("../src/config")
  expect(expandVariables({ value: "Bearer {env:TOKEN} ${TOKEN} {env:MISSING}.", env: { TOKEN: "t" } })).toBe("Bearer t t .")
})
