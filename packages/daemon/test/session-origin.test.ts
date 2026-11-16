import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { AGENT_CALLER_CAPABILITY, type SessionId, type SessionOrigin } from "@mendcode/protocol"
import { startDaemon, type Daemon } from "../src"
import { connectionOrigin } from "../src/agent-origin"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-origin-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("connectionOrigin: from the connection, never the client's word", () => {
  test("the table", () => {
    expect(connectionOrigin({ dialogs: true })).toBe("tui")
    expect(connectionOrigin({ peer: { name: "web" } })).toBe("tui")
    expect(connectionOrigin({ remoteAddress: "10.0.0.2" })).toBe("tui")
    expect(connectionOrigin({})).toBe("cli")
    expect(connectionOrigin({ client: { name: "mendcode", callerAgent: false } })).toBe("cli")
    expect(connectionOrigin({ client: { name: "mendcode", callerAgent: true } })).toBe("agent")
    expect(connectionOrigin({ client: { name: "telegram-bridge", callerAgent: false } })).toBe("agent")
    expect(connectionOrigin({ agent: { via: "process" } })).toBe("agent")
  })

  test("an agent-origin connection stays an agent even when it also says it has dialogs", () => {
    expect(connectionOrigin({ agent: { via: "process" }, dialogs: true })).toBe("agent")
  })

  test("a claim can lower cli to agent but never raise anything to tui", () => {
    expect(connectionOrigin({ client: { name: "mendcode-tui", callerAgent: false } })).toBe("cli")
    expect(connectionOrigin({ client: { name: "anything", callerAgent: true } })).toBe("agent")
  })
})

describe("what the daemon records", () => {
  async function boot() {
    const dir = temp()
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    return daemon
  }
  async function connect(daemon: Daemon, name: string, capabilities: string[] = []) {
    const client = createClient({ socketPath: daemon.socketPath, name, capabilities })
    await client.connect()
    cleanups.push(() => client.close())
    return client
  }
  async function create(client: Client) {
    const reply = await client.send({ type: "session.create", directory: "/repo", title: "t" })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result?.sessionId as SessionId
  }
  const originsOf = (daemon: Daemon, sessionId: SessionId) => daemon.store.readExactAfter(sessionId, 0, 1_000).flatMap((event) => (event.type === "queue.added" ? [event.origin] : []))

  test("each kind of client creates sessions and sends messages under its own origin", async () => {
    const daemon = await boot()
    const kinds: Array<{ name: string; capabilities: string[]; origin: SessionOrigin }> = [
      { name: "mendcode", capabilities: ["extension-dialogs"], origin: "tui" },
      { name: "mendcode", capabilities: [], origin: "cli" },
      { name: "mendcode", capabilities: [AGENT_CALLER_CAPABILITY], origin: "agent" },
      { name: "telegram-bridge", capabilities: [], origin: "agent" },
    ]
    for (const kind of kinds) {
      const client = await connect(daemon, kind.name, kind.capabilities)
      const sessionId = await create(client)
      expect(daemon.store.sessionSummary(sessionId)?.origin).toBe(kind.origin)
      const sent = await client.send({ type: "user.submit", sessionId, text: "hello", attachments: [] })
      expect(sent.ok).toBe(true)
      expect(originsOf(daemon, sessionId)).toEqual([kind.origin])
      expect(daemon.store.sessionSummary(sessionId)?.lastHumanAt !== undefined).toBe(kind.origin === "tui")
    }
  })

  test("session.list exposes origin and lastHumanAt, and a session made without a person has no lastHumanAt", async () => {
    const daemon = await boot()
    const person = await connect(daemon, "mendcode", ["extension-dialogs"])
    const script = await connect(daemon, "mendcode")
    const typed = await create(person)
    const scripted = await create(script)
    await person.send({ type: "user.submit", sessionId: typed, text: "hi", attachments: [] })
    await script.send({ type: "user.submit", sessionId: scripted, text: "hi", attachments: [] })
    const listed = await person.send({ type: "session.list" })
    if (!listed.ok) throw new Error(listed.error.message)
    const sessions = new Map((listed.result?.sessions as Array<{ sessionId: string; origin?: string; lastHumanAt?: number }>).map((session) => [session.sessionId, session]))
    expect(sessions.get(typed)?.origin).toBe("tui")
    expect(typeof sessions.get(typed)?.lastHumanAt).toBe("number")
    expect(sessions.get(scripted)?.origin).toBe("cli")
    expect(sessions.get(scripted)).not.toHaveProperty("lastHumanAt")
  })

  test("a message sent to a session another kind of client made is recorded under the sender, not the creator", async () => {
    const daemon = await boot()
    const script = await connect(daemon, "mendcode")
    const person = await connect(daemon, "mendcode", ["extension-dialogs"])
    const sessionId = await create(script)
    await person.send({ type: "user.submit", sessionId, text: "I take over", attachments: [] })
    expect(daemon.store.sessionSummary(sessionId)?.origin).toBe("cli")
    expect(originsOf(daemon, sessionId)).toEqual(["tui"])
    expect(daemon.store.sessionSummary(sessionId)?.lastHumanAt).toBeNumber()
  })
})
