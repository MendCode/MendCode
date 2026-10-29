import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { AGENT_OPEN_COMMANDS, BACKLOG_LIMITS, FEATURES, READ_ONLY_COMMANDS, agentCommandClass, createIdFactory, featureOn, parseCommand, type BacklogItem, type Command } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createAgentGate } from "../src/agent-origin"
import { backlogFile, changeBacklog, readBacklog } from "../src/backlog"
import { answer, boot, openSession, say } from "./native-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work() })
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const NOW = 1_800_000_000_000
const ids = createIdFactory()
const texts = (items: readonly BacklogItem[]) => items.map((item) => `${item.id}:${item.done ? "x" : " "}:${item.text}`)

describe("the backlog store", () => {
  test("items keep their number, text, state, time and origin; open ones are listed first", () => {
    const dir = temp("mend-backlog-")
    const add = (text: string, origin?: Record<string, string>) => changeBacklog({ dir, directory: dir, change: { op: "add", text, ...(origin ? { origin } : {}) }, now: NOW })
    expect(readBacklog(dir, dir)).toEqual({ directory: dir, items: [] })
    expect(add("  fix the\tflaky\nstore test  ", { sessionId: "ses_1", path: "src/store.ts", commit: "A1B2C3D" }).added).toBe(1)
    expect(add("write the migration notes").added).toBe(2)
    expect(readBacklog(dir, dir).items).toEqual([
      { id: 1, text: "fix the flaky store test", done: false, createdAt: NOW, origin: { sessionId: "ses_1", path: "src/store.ts", commit: "a1b2c3d" } },
      { id: 2, text: "write the migration notes", done: false, createdAt: NOW },
    ])
    expect(texts(changeBacklog({ dir, directory: dir, change: { op: "done", id: 1 }, now: NOW + 5 }).items)).toEqual(["2: :write the migration notes", "1:x:fix the flaky store test"])
    expect(readBacklog(dir, dir).items[1]).toMatchObject({ id: 1, done: true, doneAt: NOW + 5 })
    const reopened = changeBacklog({ dir, directory: dir, change: { op: "reopen", id: 1 }, now: NOW + 9 }).items[0]!
    expect(reopened).toMatchObject({ id: 1, done: false })
    expect(reopened.doneAt).toBeUndefined()
  })

  test("remove and clear-done take items away, and a number is never given twice", () => {
    const dir = temp("mend-backlog-")
    for (const text of ["a", "b", "c"]) changeBacklog({ dir, directory: dir, change: { op: "add", text }, now: NOW })
    changeBacklog({ dir, directory: dir, change: { op: "remove", id: 3 }, now: NOW })
    changeBacklog({ dir, directory: dir, change: { op: "done", id: 1 }, now: NOW })
    expect(texts(changeBacklog({ dir, directory: dir, change: { op: "clear-done" }, now: NOW }).items)).toEqual(["2: :b"])
    expect(changeBacklog({ dir, directory: dir, change: { op: "add", text: "d" }, now: NOW }).added).toBe(4)
    expect(() => changeBacklog({ dir, directory: dir, change: { op: "done", id: 3 }, now: NOW })).toThrow("[BACKLOG]: no item #3")
    expect(() => changeBacklog({ dir, directory: dir, change: { op: "add", text: " \n " }, now: NOW })).toThrow("needs text")
  })

  test("the list is bounded: 200 items, 300 characters each, and the refusal says what to do", () => {
    const dir = temp("mend-backlog-")
    expect(changeBacklog({ dir, directory: dir, change: { op: "add", text: "x".repeat(900) }, now: NOW }).items[0]!.text).toHaveLength(BACKLOG_LIMITS.text)
    for (let n = 1; n < BACKLOG_LIMITS.items; n++) changeBacklog({ dir, directory: dir, change: { op: "add", text: `item ${n}` }, now: NOW })
    expect(readBacklog(dir, dir).items).toHaveLength(BACKLOG_LIMITS.items)
    expect(() => changeBacklog({ dir, directory: dir, change: { op: "add", text: "one too many" }, now: NOW })).toThrow("the list holds 200 items; clear the finished ones or remove some first")
    changeBacklog({ dir, directory: dir, change: { op: "done", id: 7 }, now: NOW })
    changeBacklog({ dir, directory: dir, change: { op: "clear-done" }, now: NOW })
    expect(changeBacklog({ dir, directory: dir, change: { op: "add", text: "fits again" }, now: NOW }).added).toBe(BACKLOG_LIMITS.items + 1)
  })

  test("a file edited by hand is read item by item, and a broken one is an empty list", () => {
    const dir = temp("mend-backlog-")
    const file = backlogFile(dir, dir)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ items: [{ id: 4, text: "kept", done: true, doneAt: 5, createdAt: 1 }, { id: 4, text: "same number" }, { id: "x", text: "no number" }, { id: 9, text: "" }, "junk", { id: 6, text: "also kept", origin: { commit: "not-a-hash", path: "a.ts" } }] }))
    expect(readBacklog(dir, dir).items).toEqual([{ id: 6, text: "also kept", done: false, createdAt: 0, origin: { path: "a.ts" } }, { id: 4, text: "kept", done: true, createdAt: 1, doneAt: 5 }])
    expect(changeBacklog({ dir, directory: dir, change: { op: "add", text: "next" }, now: NOW }).added).toBe(7)
    writeFileSync(file, "{ not json")
    expect(readBacklog(dir, dir).items).toEqual([])
  })
})

describe("the backlog through the daemon", () => {
  const start = async (dir: string) => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    let stopped = false
    const stop = async () => { if (!stopped) { stopped = true; await daemon.stop() } }
    cleanup.push(stop)
    const client = createClient({ socketPath: daemon.socketPath, name: "backlog-test", reconnect: false })
    cleanup.push(() => client.close())
    await client.connect()
    return { client, stop }
  }

  test("is off until the tier or the feature turns it on, and says how", async () => {
    const dir = temp("mend-backlog-d-")
    const { client } = await start(dir)
    expect(await client.send({ type: "backlog.get", directory: dir })).toMatchObject({ ok: false, error: { message: "[DAEMON]: the project backlog is off (/tier backlog on)" } })
    expect(await client.send({ type: "backlog.change", directory: dir, change: { op: "add", text: "x" } })).toMatchObject({ ok: false })
    await client.send({ type: "settings.set", patch: { tier: "balanced" } })
    expect(await client.send({ type: "backlog.get", directory: dir })).toMatchObject({ ok: false })
    await client.send({ type: "settings.set", patch: { features: { backlog: true } } })
    expect(await client.send({ type: "backlog.get", directory: dir })).toMatchObject({ ok: true, result: { items: [] } })
    expect(featureOn({ tier: "full" }, "backlog")).toBe(true)
    expect(featureOn({ tier: "balanced" }, "backlog")).toBe(false)
    expect(featureOn({ tier: "minimalist" }, "backlog")).toBe(false)
    expect(featureOn({}, "backlog")).toBe(false)
    expect(FEATURES.backlog.cost).toEqual([])
    expect(FEATURES.backlog.tools).toBeUndefined()
  })

  test("survives a daemon restart, is one list per project, and never enters a session's events", async () => {
    const dir = temp("mend-backlog-d-")
    const one = path.join(dir, "one"), two = path.join(dir, "two")
    mkdirSync(one)
    mkdirSync(two)
    const first = await start(dir)
    await first.client.send({ type: "settings.set", patch: { tier: "full" } })
    expect(await first.client.send({ type: "backlog.change", directory: one, change: { op: "add", text: "rename the flag", origin: { sessionId: "ses_origin", path: "src/flags.ts" } } })).toMatchObject({ ok: true, result: { added: 1, directory: one } })
    await first.client.send({ type: "backlog.change", directory: one, change: { op: "add", text: "second thing" } })
    await first.client.send({ type: "backlog.change", directory: two, change: { op: "add", text: "other project" } })
    expect(await first.client.send({ type: "backlog.change", directory: one, change: { op: "done", id: 9 } })).toMatchObject({ ok: false, error: { message: "[DAEMON]: [BACKLOG]: no item #9" } })
    expect(JSON.parse(readFileSync(backlogFile(dir, one), "utf8"))).toMatchObject({ version: 1, directory: one, next: 3 })
    first.client.close()
    await first.stop()

    const second = await start(dir)
    const listed = await second.client.send({ type: "backlog.get", directory: path.join(one, ".") })
    expect(listed.ok && texts(listed.result!.items as BacklogItem[])).toEqual(["1: :rename the flag", "2: :second thing"])
    expect(listed.ok && (listed.result!.items as BacklogItem[])[0]!.origin).toEqual({ sessionId: "ses_origin", path: "src/flags.ts" })
    const other = await second.client.send({ type: "backlog.get", directory: two })
    expect(other.ok && texts(other.result!.items as BacklogItem[])).toEqual(["1: :other project"])
    const session = await second.client.send({ type: "session.create", directory: one })
    const events = await second.client.send({ type: "session.events", sessionId: (session.ok ? session.result!.sessionId : "") as never })
    expect(JSON.stringify(events)).not.toContain("rename the flag")
  })

  test("the schema bounds what a client may send", () => {
    const parse = (change: unknown) => parseCommand({ id: ids("command"), clientId: ids("client"), type: "backlog.change", directory: "/p", change }).success
    expect(parse({ op: "add", text: "ok", origin: { sessionId: "ses_1", path: "a.ts", commit: "abc1234" } })).toBe(true)
    expect(parse({ op: "add", text: "x".repeat(BACKLOG_LIMITS.text + 1) })).toBe(false)
    expect(parse({ op: "add", text: "" })).toBe(false)
    expect(parse({ op: "add", text: "ok", origin: { commit: "zzzz" } })).toBe(false)
    expect(parse({ op: "done", id: 0 })).toBe(false)
    expect(parse({ op: "done", id: 3, text: "extra" })).toBe(false)
    expect(parse({ op: "clear-done" })).toBe(true)
    expect(parse({ op: "set", items: [] })).toBe(false)
  })
})

describe("the model and the backlog", () => {
  test("a session's own shell may read the list and is refused every write: a proposal is never added by the model", () => {
    expect(agentCommandClass("backlog.get")).toBe("open")
    expect(agentCommandClass("backlog.change")).toBe("owner")
    expect((AGENT_OPEN_COMMANDS as readonly string[]).includes("backlog.change")).toBe(false)
    // The list is the user's text: a read-only remote token does not get it either (like the scratchpad).
    expect((READ_ONLY_COMMANDS as readonly string[]).some((type) => type.startsWith("backlog."))).toBe(false)
    const gate = createAgentGate({ modeOf: () => "full" })
    const command = (body: Record<string, unknown>) => ({ id: "cmd_1", clientId: "cli_1", ...body }) as unknown as Command
    for (const change of [{ op: "add", text: "left undone: the docs" }, { op: "done", id: 1 }, { op: "reopen", id: 1 }, { op: "remove", id: 1 }, { op: "clear-done" }]) {
      const refusal = gate.check({ via: "process", sessionId: "ses_full" }, command({ type: "backlog.change", directory: "/p", change }))
      expect(refusal).toContain("[DAEMON]: refused: backlog.change")
      expect(refusal).toContain("only the user can")
    }
    expect(gate.check({ via: "process", sessionId: "ses_full" }, command({ type: "backlog.get", directory: "/p" }))).toBeUndefined()
    expect(gate.check({ via: "declared" }, command({ type: "backlog.change", directory: "/p", change: { op: "clear-done" } }))).toContain("refused")
  })

  test("no model request carries the list, and a change to it leaves the next request's prefix as it was", async () => {
    const h = await boot({ steps: [answer("First", { input: 100, output: 10 }), answer("Second", { input: 120, output: 10 }), answer("Third", { input: 140, output: 10 })] })
    cleanup.push(h.cleanup)
    await h.client.send({ type: "settings.set", patch: { tier: "full" } })
    await h.client.send({ type: "backlog.change", directory: h.project, change: { op: "add", text: "BACKLOG-MARKER-ONE" } })
    const sessionId = await openSession(h)
    await say(h, sessionId, "one")
    await say(h, sessionId, "two")
    await h.client.send({ type: "backlog.change", directory: h.project, change: { op: "add", text: "BACKLOG-MARKER-TWO" } })
    await h.client.send({ type: "backlog.change", directory: h.project, change: { op: "done", id: 1 } })
    await say(h, sessionId, "three")
    expect(h.requests).toHaveLength(3)
    const head = (index: number) => JSON.stringify({ ...h.requests[index]!, messages: undefined })
    // Between two turns with no change, and between two turns with the list changed, everything ahead of the messages is the same bytes.
    expect(head(1)).toBe(head(0))
    expect(head(2)).toBe(head(1))
    const shared = h.requests[1]!.messages.length
    expect(JSON.stringify(h.requests[2]!.messages.slice(0, shared))).toBe(JSON.stringify(h.requests[1]!.messages))
    expect(JSON.stringify(h.requests)).not.toContain("BACKLOG-MARKER")
    const names = JSON.stringify(h.requests[2]!.tools ?? [])
    expect(names).not.toContain("backlog")
  })
})
