import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-drafts-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await daemon.stop()
  }
  cleanups.push(stop)
  return { daemon, stop }
}

async function connect(socketPath: string, options: { events?: SessionEvent[]; states?: string[]; reconnect?: boolean } = {}) {
  const client = createClient({
    socketPath,
    name: "drafts",
    reconnect: options.reconnect ?? true,
    onEvent: (e) => options.events?.push(e),
    onConnection: (state) => options.states?.push(state),
  })
  await client.connect()
  cleanups.push(() => client.close())
  return client
}

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function createSession(client: Client) {
  const reply = await client.send({ type: "session.create", directory: "/repo", title: "t" })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result?.sessionId as SessionId
}

describe("drafts", () => {
  test("a draft is kept per session, replaced by the last write and cleared when empty", async () => {
    const dir = tempDir()
    const { daemon } = await boot(dir)
    const client = await connect(daemon.socketPath)
    const sessionId = await createSession(client)
    expect(await client.send({ type: "draft.get", sessionId })).toEqual({ ok: true, result: {} })
    expect(await client.send({ type: "draft.set", sessionId, text: "half a thought" })).toEqual({ ok: true })
    expect(await client.send({ type: "draft.set", sessionId, text: "a whole thought" })).toEqual({ ok: true })
    expect(await client.send({ type: "draft.get", sessionId })).toMatchObject({ ok: true, result: { draft: { text: "a whole thought", attachments: [] } } })
    await client.send({ type: "draft.set", sessionId, text: "" })
    expect(await client.send({ type: "draft.get", sessionId })).toEqual({ ok: true, result: {} })
  })

  test("a draft for a session that does not exist is refused", async () => {
    const { daemon } = await boot(tempDir())
    const client = await connect(daemon.socketPath)
    expect(await client.send({ type: "draft.set", sessionId: createIdFactory()("session"), text: "x" })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })

  test("a closed terminal and a restarted daemon still find the draft; deleting the session removes it", async () => {
    const dir = tempDir()
    const first = await boot(dir)
    const writer = await connect(first.daemon.socketPath, { reconnect: false })
    const sessionId = await createSession(writer)
    await writer.send({ type: "draft.set", sessionId, text: "remember to update the changelog" })
    writer.close()
    await first.stop()
    const second = await boot(dir)
    const reader = await connect(second.daemon.socketPath)
    expect(await reader.send({ type: "draft.get", sessionId })).toMatchObject({ ok: true, result: { draft: { text: "remember to update the changelog" } } })
    expect(await reader.send({ type: "session.delete", sessionId })).toMatchObject({ ok: true })
    expect(await reader.send({ type: "draft.get", sessionId })).toEqual({ ok: true, result: {} })
  })
})

describe("draft list", () => {
  test("lists unsent drafts of a project with a preview, leaves out the excluded session and survives a restart", async () => {
    const dir = tempDir()
    const first = await boot(dir)
    const client = await connect(first.daemon.socketPath, { reconnect: false })
    const typed = await createSession(client)
    const current = await createSession(client)
    const elsewhere = await client.send({ type: "session.create", directory: "/elsewhere", title: "o" })
    expect(elsewhere).toMatchObject({ ok: true })
    const text = "line one\n\n   line two " + "x".repeat(400)
    await client.send({ type: "draft.set", sessionId: typed, text })
    await client.send({ type: "draft.set", sessionId: elsewhere.ok ? elsewhere.result?.sessionId as SessionId : typed, text: "other project" })
    await client.send({ type: "draft.set", sessionId: current, text: "being typed now" })
    client.close()
    await first.stop()
    const second = await boot(dir)
    const reader = await connect(second.daemon.socketPath)
    const all = await reader.send({ type: "draft.list", directory: "/repo", excludeSessionId: current })
    expect(all).toMatchObject({ ok: true, result: { drafts: [{ sessionId: typed, directory: "/repo", chars: text.length, attachments: 0 }] } })
    const preview = ((all as unknown as { result: { drafts: Array<{ preview: string }> } }).result.drafts[0]!).preview
    expect(preview.startsWith("line one line two xxxx")).toBe(true)
    expect(preview.length).toBe(160)
    expect(await reader.send({ type: "draft.list", directory: "/elsewhere" })).toMatchObject({ ok: true, result: { drafts: [{ preview: "other project" }] } })
    await reader.send({ type: "draft.set", sessionId: typed, text: "" })
    expect(await reader.send({ type: "draft.list", directory: "/repo", excludeSessionId: current })).toEqual({ ok: true, result: { drafts: [] } })
  })

  test("maxAgeDays keeps a fresh draft", async () => {
    const { daemon } = await boot(tempDir())
    const client = await connect(daemon.socketPath)
    const sessionId = await createSession(client)
    await client.send({ type: "draft.set", sessionId, text: "fresh" })
    expect(await client.send({ type: "draft.list", maxAgeDays: 1 })).toMatchObject({ ok: true, result: { drafts: [{ sessionId, chars: 5 }] } })
  })

  test("read-only peers can neither list nor read drafts", async () => {
    const { READ_ONLY_COMMANDS } = await import("@mendcode/protocol/wire")
    expect(READ_ONLY_COMMANDS as readonly string[]).not.toContain("draft.get")
    expect(READ_ONLY_COMMANDS as readonly string[]).not.toContain("draft.list")
  })
})

describe("a draft in session lists", () => {
  type Listed = Array<{ sessionId: string; title: string; draft?: { preview: string; chars: number; attachments: number; images: number } }>
  const listed = async (client: Client, directory = "/repo") => {
    const reply = await client.send({ type: "session.list", directory, limit: 50 })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result?.sessions as Listed
  }
  const untitled = async (client: Client) => {
    // What a terminal's new chat asks for: a blank chat nobody typed in (an explicit `session.create` is never one).
    const reply = await client.send({ type: "session.create", directory: "/repo", title: "", reuseEmpty: true })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result?.sessionId as SessionId
  }

  test("session.list carries the first line of the draft, and nothing for a session without one", async () => {
    const { daemon } = await boot(tempDir())
    const client = await connect(daemon.socketPath)
    const withDraft = await untitled(client)
    const without = await createSession(client)
    await client.send({ type: "draft.set", sessionId: withDraft, text: "\n  fix the retry\nloop in the sync worker" })
    const sessions = await listed(client)
    expect(sessions.find((session) => session.sessionId === withDraft)?.draft).toMatchObject({ preview: "fix the retry", chars: 40, attachments: 0, images: 0 })
    expect(sessions.find((session) => session.sessionId === without)?.draft).toBeUndefined()
  })

  test("an attachment-only draft is listed with its count and no text; whitespace is no draft at all", async () => {
    const { daemon } = await boot(tempDir())
    const client = await connect(daemon.socketPath)
    const sessionId = await untitled(client)
    const ref = { sha256: "a".repeat(64), bytes: 9, mime: "image/png", name: "a.png", label: "[Image #1]" }
    await client.send({ type: "draft.set", sessionId, text: "[Image #1] ", attachments: [ref] })
    expect((await listed(client)).find((session) => session.sessionId === sessionId)?.draft).toMatchObject({ preview: "", chars: 0, attachments: 1, images: 1 })
    await client.send({ type: "draft.set", sessionId, text: " \n ", attachments: [] })
    expect((await listed(client)).find((session) => session.sessionId === sessionId)?.draft).toBeUndefined()
    expect(await client.send({ type: "draft.get", sessionId })).toEqual({ ok: true, result: {} })
  })

  test("a draft keeps an untitled session in the people's list, and clearing it lets the empty chat go again", async () => {
    const { daemon } = await boot(tempDir())
    const client = await connect(daemon.socketPath)
    const sessionId = await untitled(client)
    const people = async () => ((await client.send({ type: "session.list", directory: "/repo", hideEmpty: true })) as unknown as { result: { sessions: Listed } }).result.sessions.map((session) => session.sessionId)
    expect(await people()).not.toContain(sessionId)
    await client.send({ type: "draft.set", sessionId, text: "half a thought" })
    expect(await people()).toContain(sessionId)
    await client.send({ type: "draft.set", sessionId, text: "" })
    expect(await people()).not.toContain(sessionId)
  })

  test("another terminal hears when the draft appears, changes its first line and goes, and not on every keystroke", async () => {
    const { daemon } = await boot(tempDir())
    const heard: Array<{ sessionId: string; draft?: { preview: string } | null }> = []
    const watcher = createClient({ socketPath: daemon.socketPath, name: "watcher", onGlobal: (event) => void (event.type === "session.activity" && heard.push({ sessionId: event.sessionId, ...(event.draft !== undefined ? { draft: event.draft } : {}) })) })
    await watcher.connect()
    cleanups.push(() => watcher.close())
    const writer = await connect(daemon.socketPath)
    const sessionId = await untitled(writer)
    const about = () => heard.filter((entry) => entry.sessionId === sessionId && entry.draft !== undefined).map((entry) => entry.draft?.preview ?? null)
    await writer.send({ type: "draft.set", sessionId, text: "fix the" })
    await writer.send({ type: "draft.set", sessionId, text: "fix the" })
    await writer.send({ type: "draft.set", sessionId, text: "fix the retry\nand more" })
    await writer.send({ type: "draft.set", sessionId, text: "fix the retry\nand more and more" })
    await writer.send({ type: "draft.set", sessionId, text: "" })
    await until(() => about().length >= 3)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(about()).toEqual(["fix the", "fix the retry", null])
  })

  test("a read-only token is told nothing of drafts: not in the list, not in activity", async () => {
    const dir = tempDir()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const local = await connect(daemon.socketPath)
    const sessionId = await untitled(local)
    await local.send({ type: "draft.set", sessionId, text: "private words" })
    const heard: unknown[] = []
    const make = async (name: string, readOnly: boolean) => {
      const token = remoteTokens(dir).create({ name, readOnly }).token
      const client = createClient({ name, remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token }, onGlobal: (event) => void (event.type === "session.activity" && readOnly && heard.push(event)) })
      await client.connect()
      cleanups.push(() => client.close())
      return client
    }
    const full = await make("full", false)
    const view = await make("view", true)
    expect((await listed(full)).find((session) => session.sessionId === sessionId)?.draft).toMatchObject({ preview: "private words" })
    expect((await listed(view)).find((session) => session.sessionId === sessionId)?.draft).toBeUndefined()
    await local.send({ type: "draft.set", sessionId, text: "something else" })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(JSON.stringify(heard)).not.toContain("something else")
    expect(heard.every((event) => (event as { draft?: unknown }).draft === undefined)).toBe(true)
  })
})

describe("sending while the daemon is away", () => {
  test("a message sent while reconnecting waits and is delivered once the daemon is back", async () => {
    const dir = tempDir()
    const first = await boot(dir)
    const events: SessionEvent[] = []
    const states: string[] = []
    const client = await connect(first.daemon.socketPath, { events, states })
    const sessionId = await createSession(client)
    await client.subscribe(sessionId, 0)
    await first.stop()
    await until(() => states.includes("reconnecting"))
    const sent = client.send({ type: "user.submit", sessionId, text: "typed while offline", attachments: [] })
    expect(client.unanswered).toBe(1)
    await boot(dir)
    expect(await sent).toMatchObject({ ok: true })
    await until(() => events.some((e) => e.type === "turn.completed"))
    expect(events.filter((e) => e.type === "queue.added").map((e) => (e as { text?: string }).text)).toEqual(["typed while offline"])
    expect(client.unanswered).toBe(0)
  })

  test("a command whose connection dropped before the answer is sent again and answered once", async () => {
    const dir = tempDir()
    const { daemon } = await boot(dir)
    const events: SessionEvent[] = []
    const client = await connect(daemon.socketPath, { events })
    const sessionId = await createSession(client)
    await client.subscribe(sessionId, 0)
    const sent = client.send({ type: "user.submit", sessionId, text: "once", attachments: [] })
    client.dropConnection()
    expect(await sent).toMatchObject({ ok: true })
    await until(() => events.some((e) => e.type === "turn.completed"))
    // The daemon answered the repeated id from its cache: one message, one turn.
    expect(events.filter((e) => e.type === "queue.added")).toHaveLength(1)
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1)
  })

  test("a client that will not reconnect fails its pending commands at once", async () => {
    const dir = tempDir()
    const first = await boot(dir)
    const client = await connect(first.daemon.socketPath, { reconnect: false })
    await first.stop()
    await until(() => client.unanswered === 0)
    expect(await client.send({ type: "session.list", limit: 1 })).toMatchObject({ ok: false })
  })
})
