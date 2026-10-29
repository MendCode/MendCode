import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { SessionId, SessionSummary } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-fork-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let store: Store | undefined
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock, store: s }) => ((store = s), createFauxEngine({ clock, deltaMs: 1 })) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "fork" })
  await client.connect()
  cleanups.push(() => client.close())
  return { client, store: () => store! }
}

describe("session.fork", () => {
  test("a fork continues the conversation in a new listed session; a side chat starts in plan mode", async () => {
    const { client, store } = await boot()
    const created = await client.send({ type: "session.create", directory: "/repo", title: "refactor auth" })
    const source = created.ok ? (created.result!.sessionId as SessionId) : ("" as SessionId)
    const history = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello", toolCalls: [] }]
    store().engineMessages.save(source, "native", history)
    await client.send({ type: "session.permission.set", sessionId: source, mode: "edits" })

    const fork = await client.send({ type: "session.fork", sessionId: source })
    expect(fork).toMatchObject({ ok: true, result: { copied: 2 } })
    const forkId = fork.ok ? (fork.result!.sessionId as SessionId) : ("" as SessionId)
    expect(store().engineMessages.load(forkId, "native")).toEqual(history)
    expect(store().permissionModeOf(forkId)).toBe("edits")

    const side = await client.send({ type: "session.fork", sessionId: source, readOnly: true })
    const sideId = side.ok ? (side.result!.sessionId as SessionId) : ("" as SessionId)
    expect(store().readAfter(sideId, 0).filter((e) => e.type === "session.permission")).toMatchObject([{ mode: "plan" }])
    const listed = await client.send({ type: "session.list", directory: "/repo" })
    const titles = (listed.ok ? (listed.result!.sessions as SessionSummary[]) : []).map((s) => s.title).sort()
    expect(titles).toEqual(["fork: refactor auth", "refactor auth", "side: refactor auth"])
    // The source keeps its own history untouched.
    expect(store().engineMessages.load(source, "native")).toEqual(history)
  })

  test("forking an unknown session is an error", async () => {
    const { client } = await boot()
    expect(await client.send({ type: "session.fork", sessionId: "ses_01M3K99AR430RP1AGHZQN64R74" as SessionId })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })
})
