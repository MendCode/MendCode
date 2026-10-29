import { afterEach, expect, test } from "bun:test"
import { createClient } from "@mendcode/client"
import { createIdFactory, type GlobalEvent } from "@mendcode/protocol"
import { boot, hang, openSession, say, stop, until, type NativeHarness } from "./native-harness"

let h: NativeHarness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

test("archive and restore reach the client, keep history accessible and broadcast visibility to another terminal", async () => {
  h = await boot({ steps: [stop("preserved answer"), stop("still usable")] })
  const id = await openSession(h)
  await say(h, id, "preserved prompt")
  const before = h.store.readAfter(id, 0)
  const history = h.store.engineMessages.load(id, "native")
  const activity: GlobalEvent[] = []
  const observer = createClient({ socketPath: h.daemon.socketPath, name: "archive-observer", onGlobal: (event) => activity.push(event) })
  try {
    await observer.connect()
    const archived = await h.client.archiveSession(id)
    expect(archived).toMatchObject({ ok: true, session: { sessionId: id, title: "preserved prompt", archivedAt: expect.any(Number) } })
    await until(() => activity.some((event) => event.type === "session.activity" && event.archivedAt != null))
    expect(h.store.readAfter(id, 0)).toEqual(before)
    expect(h.store.engineMessages.load(id, "native")).toEqual(history)
    expect(await h.client.send({ type: "session.list" })).toMatchObject({ ok: true, result: { sessions: [] } })
    expect(await h.client.send({ type: "session.list", archived: true, search: "preserved", limit: 1 })).toMatchObject({ ok: true, result: { sessions: [{ sessionId: id, archivedAt: expect.any(Number) }] } })
    expect(await h.client.history(id)).toMatchObject({ ok: true, history: { turns: [{ preview: "preserved prompt" }] } })
    expect(await h.client.send({ type: "session.export", sessionId: id, format: "markdown" })).toMatchObject({ ok: true, result: { text: expect.stringContaining("preserved answer") } })
    await say(h, id, "continue while archived")
    expect((await h.client.getSession(id))).toMatchObject({ ok: true, session: { archivedAt: expect.any(Number) } })
    const restored = await h.client.archiveSession(id, true)
    expect(restored).toMatchObject({ ok: true, session: { sessionId: id } })
    if (restored.ok) expect(restored.session).not.toHaveProperty("archivedAt")
    await until(() => activity.some((event) => event.type === "session.activity" && event.archivedAt === null))
    expect(await h.client.send({ type: "session.list", search: "preserved" })).toMatchObject({ ok: true, result: { sessions: [{ sessionId: id }] } })
    expect(await h.client.archiveSession(createIdFactory()("session"))).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  } finally { observer.close() }
})

test("archiving a running session leaves its turn and queued input intact", async () => {
  h = await boot({ steps: [hang] })
  const id = await openSession(h)
  await h.client.send({ type: "user.submit", sessionId: id, text: "running", attachments: [] })
  await until(() => h!.requests.length === 1)
  await h.client.send({ type: "user.submit", sessionId: id, text: "queued", attachments: [] })
  const snapshot = h.store.lastSeq(id)
  expect(await h.client.archiveSession(id)).toMatchObject({ ok: true, session: { state: "generating", queued: 1, archivedAt: expect.any(Number) } })
  expect(h.store.lastSeq(id)).toBe(snapshot)
  expect(h.requests[0]!.signal.aborted).toBe(false)
  expect(await h.client.archiveSession(id, true)).toMatchObject({ ok: true, session: { state: "generating", queued: 1 } })
})
