import { afterEach, expect, test } from "bun:test"
import { realpathSync, symlinkSync } from "node:fs"
import path from "node:path"
import { createPtyService, type PtySocket } from "../src/pty"
import { fakePtyDriver } from "./pty-fake"
import { cleanTemps, tempDir } from "../../../apps/cli/test/session-ui-harness"

afterEach(cleanTemps)
function setup(enabled = true) {
  const fake = fakePtyDriver()
  let time = 0, active = true
  const scope = { directory: realpathSync(tempDir()), peer: { name: "owner", hash: "a".repeat(64), readOnly: false } }
  const service = createPtyService({ enabled, driver: fake.driver, now: () => time, active: () => active })
  const socket = () => {
    const output: Array<string | Uint8Array> = [], closed: number[] = []
    const socket: PtySocket = { send: (data) => { output.push(data); return 1 }, close: (code) => { closed.push(code ?? 1000) } }
    return { socket, output, closed, text: () => output.filter((value) => typeof value === "string").join(""), cursor: () => JSON.parse(new TextDecoder().decode((output.find((value) => value instanceof Uint8Array) as Uint8Array).subarray(1))).cursor }
  }
  return { ...fake, service, scope, socket, advance: (ms: number) => { time += ms }, revoke: () => { active = false } }
}

test("PTY stays off by default and denies read-only owners without spawning", () => {
  const h = setup(false)
  expect(() => h.service.create(h.scope, {})).toThrow("PTY disabled")
  const enabled = setup()
  for (const run of [() => enabled.service.shells({ ...enabled.scope, peer: { ...enabled.scope.peer, readOnly: true } }), () => enabled.service.list({ ...enabled.scope, peer: { ...enabled.scope.peer, readOnly: true } }), () => enabled.service.create({ ...enabled.scope, peer: { ...enabled.scope.peer, readOnly: true } }, {})]) expect(run).toThrow("Full token required")
  expect(h.processes).toHaveLength(0)
  expect(enabled.processes).toHaveLength(0)
})

test("PTY uses login shell defaults, custom argv/env, title and ordered resize", () => {
  const h = setup()
  expect(h.service.shells(h.scope)).toHaveLength(2)
  const pty = h.service.create(h.scope, { title: "Build", env: { APP: "local", TERM: "ignored" } })
  expect(pty).toMatchObject({ command: "/fake/sh", args: ["-l"], cwd: h.scope.directory, status: "running", pid: 101, title: "Build" })
  expect(h.processes[0]!.env).toMatchObject({ APP: "local", TERM: "xterm-256color", MENDCODE_TERMINAL: "1", OPENCODE_TERMINAL: "1" })
  expect(h.service.update(h.scope, pty.id, { title: "Tests", size: { cols: 180, rows: 50 } }).title).toBe("Tests")
  expect(h.processes[0]!.sizes).toEqual([[180, 50]])
  const custom = h.service.create(h.scope, { command: "/fake/program", args: ["--verbose"] })
  expect(custom.args).toEqual(["--verbose"])
  pty.args.push("changed")
  expect(h.service.get(h.scope, pty.id).args).toEqual(["-l"])
  h.service.dispose()
  expect(h.processes.every((process) => process.kills === 1)).toBe(true)
})

test("PTY owner and canonical project isolate metadata, mutation and tickets", () => {
  const h = setup(), pty = h.service.create(h.scope, {})
  const other = { ...h.scope, peer: { ...h.scope.peer, hash: "b".repeat(64) } }
  expect(h.service.list(other)).toEqual([])
  for (const run of [() => h.service.get(other, pty.id), () => h.service.update(other, pty.id, { title: "stolen" }), () => h.service.remove(other, pty.id), () => h.service.ticket(other, pty.id), () => h.service.get({ ...h.scope, directory: realpathSync(tempDir()) }, pty.id)]) expect(run).toThrow("PTY not found")
  const outside = realpathSync(tempDir())
  symlinkSync(outside, path.join(h.scope.directory, "outside"))
  for (const cwd of [outside, "..", "outside", "/missing/pty-directory"]) expect(() => h.service.create(h.scope, { cwd })).toThrow("outside selected project")
  expect(h.processes).toHaveLength(1)
  h.service.dispose()
})

test("PTY reconnect replays once from UTF-16 cursor; -1 skips replay and binary metadata carries current cursor", () => {
  const h = setup(), pty = h.service.create(h.scope, {})
  const process = h.processes[0]!
  process.data("hello 🌿\r\n")
  const first = h.socket(), connection = h.service.connect(h.scope, pty.id, first.socket)
  expect(first.text()).toBe("hello 🌿\r\n")
  expect(first.cursor()).toBe(10)
  connection.message("echo next\n")
  expect(process.writes).toEqual(["echo next\n"])
  connection.close()
  process.data("next")
  expect(first.text()).toBe("hello 🌿\r\n")
  const second = h.socket()
  h.service.connect(h.scope, pty.id, second.socket, first.cursor())
  expect(second.text()).toBe("next")
  expect(second.cursor()).toBe(14)
  const live = h.socket()
  h.service.connect(h.scope, pty.id, live.socket, -1)
  expect(live.text()).toBe("")
  process.data("!")
  expect(live.text()).toBe("!")
  for (const cursor of [-2, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => h.service.connect(h.scope, pty.id, h.socket().socket, cursor)).toThrow("Invalid PTY cursor")
  h.service.dispose()
})

test("PTY replay buffer, connections, ticket storage and slow readers are bounded", () => {
  const h = setup(), pty = h.service.create(h.scope, {})
  h.processes[0]!.data("x".repeat(2 * 1024 * 1024 + 64))
  const replay = h.socket()
  const connection = h.service.connect(h.scope, pty.id, replay.socket)
  expect(replay.text()).toHaveLength(2 * 1024 * 1024)
  expect(replay.output.filter((value) => typeof value === "string").every((value) => value.length <= 65536)).toBe(true)
  expect(replay.cursor()).toBe(2 * 1024 * 1024 + 64)
  connection.close()
  const slow = h.socket()
  slow.socket.send = () => -1
  h.service.connect(h.scope, pty.id, slow.socket)
  expect(slow.closed).toEqual([1013])
  for (let i = 0; i < 8; i++) h.service.connect(h.scope, pty.id, h.socket().socket, -1)
  expect(() => h.service.connect(h.scope, pty.id, h.socket().socket)).toThrow("connection limit")
  for (let i = 0; i < 1024; i++) h.service.ticket(h.scope, pty.id)
  expect(() => h.service.ticket(h.scope, pty.id)).toThrow("ticket limit")
  h.advance(60_000)
  expect(h.service.ticket(h.scope, pty.id).expires_in).toBe(60)
  h.service.dispose()
})

test("PTY tickets are single-use, expire at 60s, stay scoped and die with owner revocation", () => {
  const h = setup(), pty = h.service.create(h.scope, {}), second = h.service.create(h.scope, {})
  const issued = h.service.ticket(h.scope, pty.id)
  expect(issued.expires_in).toBe(60)
  expect(h.service.consume(h.scope.directory, second.id, issued.ticket)).toBeUndefined()
  expect(h.service.consume(realpathSync(tempDir()), pty.id, issued.ticket)).toBeUndefined()
  expect(h.service.consume(h.scope.directory, pty.id, issued.ticket)).toEqual(h.scope.peer)
  expect(h.service.consume(h.scope.directory, pty.id, issued.ticket)).toBeUndefined()
  const expired = h.service.ticket(h.scope, pty.id)
  h.advance(60_000)
  expect(h.service.consume(h.scope.directory, pty.id, expired.ticket)).toBeUndefined()
  const revoked = h.service.ticket(h.scope, pty.id)
  const socket = h.socket()
  h.service.connect(h.scope, pty.id, socket.socket)
  h.revoke()
  expect(h.service.consume(h.scope.directory, pty.id, revoked.ticket)).toBeUndefined()
  h.service.sweep()
  expect(socket.closed).toEqual([1000])
  expect(h.processes.every((process) => process.kills === 1)).toBe(true)
})

test("PTY input limits and exit/removal close subscribers, invalidate tickets and release capacity", () => {
  const h = setup(), pty = h.service.create(h.scope, {})
  const socket = h.socket(), connection = h.service.connect(h.scope, pty.id, socket.socket)
  connection.message("x".repeat(128 * 1024 + 1))
  expect(socket.closed).toEqual([1008])
  expect(h.processes[0]!.writes).toEqual([])
  const ticket = h.service.ticket(h.scope, pty.id)
  h.processes[0]!.exit(0)
  expect(h.service.list(h.scope)).toEqual([])
  expect(h.service.consume(h.scope.directory, pty.id, ticket.ticket)).toBeUndefined()
  for (let i = 0; i < 64; i++) h.service.create(h.scope, {})
  expect(() => h.service.create(h.scope, {})).toThrow("session limit")
  const removed = h.service.list(h.scope)[0]!
  expect(h.service.remove(h.scope, removed.id)).toBe(true)
  expect(() => h.service.remove(h.scope, removed.id)).toThrow("PTY not found")
  expect(h.service.create(h.scope, {})).toBeDefined()
  h.service.dispose()
})

test("PTY spawn failure never retains a session or echoes argv/env", () => {
  const scope = { directory: realpathSync(tempDir()) }
  const service = createPtyService({ enabled: true, driver: { shells: () => [], spawn: () => { throw new Error("private-secret") } } })
  expect(() => service.create(scope, { env: { PRIVATE: "private-secret" } })).toThrow("PTY runtime unavailable or spawn failed")
  expect(service.list(scope)).toEqual([])
})

test("PTY environment hook sees validated cwd/PTY id and overrides env before fixed markers", async () => {
  const h = setup()
  const pty = await h.service.createWithEnvironment(h.scope, { env: { SOURCE: "input", TERM: "input" } }, async (ref) => {
    expect(ref.cwd).toBe(h.scope.directory)
    expect(ref.id).toMatch(/^pty_[a-f0-9]{32}$/)
    expect(h.processes).toHaveLength(0)
    return { SOURCE: "extension", TERM: "extension" }
  })
  expect(h.processes[0]!.env).toMatchObject({ SOURCE: "extension", TERM: "xterm-256color" })
  expect(pty.id).toMatch(/^pty_/)
  h.service.dispose()
})

test("PTY creation cannot outlive disposal or HTTP abort while a shell.env hook is pending", async () => {
  const h = setup()
  for (const action of ["dispose", "abort"] as const) {
    let finish!: (value: Record<string, string>) => void
    const controller = new AbortController()
    const pending = h.service.createWithEnvironment(h.scope, {}, () => new Promise((resolve) => { finish = resolve }), controller.signal)
    if (action === "dispose") h.service.dispose(h.scope.directory)
    else controller.abort()
    finish({})
    await expect(pending).rejects.toThrow("PTY creation interrupted")
  }
  expect(h.processes).toHaveLength(0)
  let finish!: (value: Record<string, string>) => void
  const pending = h.service.createWithEnvironment(h.scope, {}, () => new Promise((resolve) => { finish = resolve }))
  h.service.dispose(realpathSync(tempDir()))
  finish({})
  expect(await pending).toBeDefined()
  h.service.dispose()
})
