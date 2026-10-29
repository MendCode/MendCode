import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import * as protocol from "../src"
import { Command, COMMAND_SCHEMAS, Frame, PROTOCOL_VERSION, createIdFactory, decodeFrame, parseCommand } from "../src"

const ids = createIdFactory()
const base = { id: ids("command"), clientId: ids("client") }
const sessionId = ids("session")

/** Runs a script in a fresh process (this file's own imports would count) and returns its JSON output. */
function probe(script: string) {
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString().trim()) as Record<string, number>
}

test("importing the protocol builds almost none of its ~880 schemas", () => {
  const { built } = probe(`const { lazyStats } = await import("./src/lazy")
await import("./src")
console.log(JSON.stringify({ built: lazyStats.built }))`)
  expect(built).toBeLessThan(30)
})

test("a command frame builds the schema of its own command, not the union of all of them", () => {
  const script = `const { lazyStats } = await import("./src/lazy")
const protocol = await import("./src")
const ids = protocol.createIdFactory()
const atImport = lazyStats.built
const line = JSON.stringify({ v: protocol.PROTOCOL_VERSION, kind: "command", body: { id: ids("command"), clientId: ids("client"), type: "client.unsubscribe", sessionId: ids("session") } })
const decoded = protocol.decodeFrame(line)
console.log(JSON.stringify({ ok: decoded.ok ? 1 : 0, built: lazyStats.built - atImport }))`
  const { ok, built } = probe(script)
  expect(ok).toBe(1)
  expect(built).toBeLessThan(8)
})

test("every command is registered under the type its schema declares", () => {
  const entries = Object.entries(COMMAND_SCHEMAS)
  expect(entries.length).toBeGreaterThan(300)
  for (const [type, schema] of entries) expect((schema as unknown as { shape: { type: { value: string } } }).shape.type.value).toBe(type)
  expect(Command.options.length).toBe(entries.length)
})

test("parseCommand returns what Command.safeParse does, success and failure", () => {
  const inputs: unknown[] = [
    { ...base, type: "session.create", directory: "/tmp/project" },
    { ...base, type: "session.create", directory: "" },
    { ...base, type: "session.create", directory: "/tmp/project", extra: true },
    { ...base, type: "turn.cancel", sessionId, turnId: ids("turn") },
    { ...base, type: "turn.cancel", sessionId: ids("turn"), turnId: ids("turn") },
    { ...base, type: "no.such.command" },
    { ...base },
    { ...base, type: 7 },
    { ...base, type: "__proto__" },
    { ...base, type: "constructor" },
    { ...base, type: "toString" },
    "session.create",
    null,
    [],
    undefined,
  ]
  for (const input of inputs) {
    const fast = parseCommand(input)
    const full = Command.safeParse(input)
    expect(fast.success).toBe(full.success)
    if (fast.success && full.success) expect(fast.data).toEqual(full.data)
    else if (!fast.success && !full.success) expect(fast.error.issues).toEqual(full.error.issues)
  }
})

test("decodeFrame answers the same for command frames as the full Frame schema", () => {
  const goodBody = { ...base, type: "session.create", directory: "/tmp/project" }
  const frames: unknown[] = [
    { v: PROTOCOL_VERSION, kind: "command", body: goodBody },
    { v: PROTOCOL_VERSION, kind: "command", body: { ...goodBody, directory: "" } },
    { v: PROTOCOL_VERSION, kind: "command", body: { ...goodBody, type: "no.such.command" } },
    { v: PROTOCOL_VERSION, kind: "command", body: goodBody, extra: 1 },
    { v: PROTOCOL_VERSION + 1, kind: "command", body: goodBody },
    { v: PROTOCOL_VERSION, kind: "command" },
    { v: PROTOCOL_VERSION, kind: "auth", id: base.id, token: "secret-token" },
    [],
    "text",
  ]
  for (const frame of frames) {
    const decoded = decodeFrame(JSON.stringify(frame))
    const full = Frame.safeParse(frame)
    expect(decoded.ok).toBe(full.success)
    if (decoded.ok && full.success) expect(decoded.frame).toEqual(full.data)
    else if (!decoded.ok && !full.success) expect(decoded.error).toBe(`[PROTOCOL]: ${z.prettifyError(full.error)}`)
  }
})

/**
 * A lazy stand-in breaks JSON Schema output for a wrapper schema (zod finds those by identity), and a schema built at
 * import defeats the laziness. Converting every export catches the first; the import count test above, the second.
 */
test("every schema the protocol exports converts to JSON Schema", () => {
  let converted = 0
  for (const [name, value] of Object.entries(protocol)) {
    if (!value || typeof value !== "object" || !("_zod" in value)) continue
    expect(() => z.toJSONSchema(value as z.ZodType, { io: "input", unrepresentable: "any" }), name).not.toThrow()
    converted++
  }
  expect(converted).toBeGreaterThan(800)
})

test("a stand-in is the schema for composition: optional, array, record, extend and the type check", () => {
  const { SessionCreate } = protocol
  expect(SessionCreate instanceof z.ZodObject).toBe(true)
  const maybe = SessionCreate.optional()
  expect(maybe.safeParse(undefined).success).toBe(true)
  expect(maybe.unwrap()).toBe(SessionCreate)
  expect(z.array(SessionCreate).safeParse([{ ...base, type: "session.create", directory: "/tmp" }]).success).toBe(true)
  expect(Object.keys(SessionCreate.shape)).toContain("directory")
  expect(SessionCreate.extend({ more: z.string() }).safeParse({ ...base, type: "session.create", directory: "/tmp", more: "x" }).success).toBe(true)
})

test("the daemon's modules never validate a command through the full union", async () => {
  const roots = ["../../daemon/src/http.ts", "../../daemon/src/session-http.ts", "../../daemon/src/daemon.ts"]
  for (const file of roots) expect(await Bun.file(path.join(import.meta.dir, file)).text()).not.toMatch(/\bCommand\.(safeParse|parse)\(/)
})
