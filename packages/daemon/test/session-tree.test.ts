import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { type ModelChoice, type SessionEvent, type SessionId, type SessionTreeNode, type TimelineEntry } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { RECAP_SYSTEM } from "../src/recap"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Complete = (input: { system: string; prompt: string; signal: AbortSignal; model?: ModelChoice }) => Promise<string>

async function boot(complete?: Complete, existing?: string) {
  const dir = existing ?? realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-tree-")))
  if (!existing) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), ...(complete ? { complete } : {}) })
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "tree", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const created = await client.send({ type: "session.create", directory: dir, title: "refactor auth" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  return { client, sessionId, events, dir }
}

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Booted = Awaited<ReturnType<typeof boot>>
async function say(h: Booted, text: string) {
  const done = () => h.events.filter((event) => event.type === "turn.completed").length
  const before = done()
  await h.client.send({ type: "user.submit", sessionId: h.sessionId, text, attachments: [] })
  await until(() => done() > before)
}
async function timeline(h: Booted, sessionId = h.sessionId) {
  const reply = await h.client.send({ type: "session.timeline", sessionId })
  return (reply.ok ? reply.result!.entries : []) as TimelineEntry[]
}
async function tree(h: Booted, sessionId = h.sessionId) {
  const reply = await h.client.send({ type: "session.tree", sessionId })
  return (reply.ok ? reply.result!.nodes : []) as SessionTreeNode[]
}

describe("session.tree", () => {
  test("forks at a message build a tree seen from every node, with the fork point and its preview", async () => {
    const h = await boot()
    await say(h, "first idea")
    await say(h, "second idea")
    const [first] = await timeline(h)
    const branch = await h.client.send({ type: "session.fork", sessionId: h.sessionId, atItemId: first!.itemId })
    const branchId = (branch.ok ? branch.result!.sessionId : "") as SessionId
    expect(branchId).not.toBe("")
    const deeper = await h.client.send({ type: "session.fork", sessionId: branchId })
    const deeperId = (deeper.ok ? deeper.result!.sessionId : "") as SessionId

    for (const from of [h.sessionId, branchId, deeperId]) {
      const nodes = await tree(h, from)
      expect(nodes.map((node) => node.sessionId)).toEqual([h.sessionId, branchId, deeperId])
      expect(nodes.find((node) => node.current)?.sessionId).toBe(from)
    }
    const nodes = await tree(h)
    expect(nodes[0]).toMatchObject({ title: "refactor auth", labels: [] })
    expect(nodes[0]!.parentId).toBeUndefined()
    expect(nodes[1]).toMatchObject({ parentId: h.sessionId, atItemId: first!.itemId, atPreview: "first idea" })
    expect(nodes[2]).toMatchObject({ parentId: branchId })

    expect(await h.client.send({ type: "session.tree", sessionId: "ses_01M3K99AR430RP1AGHZQN64R74" as SessionId })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })

  test("deleting a parent leaves its branches as their own tree", async () => {
    const h = await boot()
    await say(h, "only message")
    const branch = await h.client.send({ type: "session.fork", sessionId: h.sessionId })
    const branchId = (branch.ok ? branch.result!.sessionId : "") as SessionId
    expect(await h.client.send({ type: "session.delete", sessionId: h.sessionId })).toMatchObject({ ok: true })
    expect((await tree(h, branchId)).map((node) => node.sessionId)).toEqual([branchId])
  })
})

describe("session.label", () => {
  test("labels show in the timeline and the tree, can be cleared, and travel to a branch", async () => {
    const h = await boot()
    await say(h, "first idea")
    await say(h, "second idea")
    const [first, second] = await timeline(h)
    expect(await h.client.send({ type: "session.label", sessionId: h.sessionId, itemId: first!.itemId, label: "  good\nstart  " })).toMatchObject({ ok: true, result: { label: "good start" } })
    await h.client.send({ type: "session.label", sessionId: h.sessionId, itemId: second!.itemId, label: "bad turn" })
    expect((await timeline(h)).map((entry) => entry.label)).toEqual(["good start", "bad turn"])
    expect((await tree(h))[0]!.labels).toEqual([
      { itemId: first!.itemId, label: "good start", preview: "first idea" },
      { itemId: second!.itemId, label: "bad turn", preview: "second idea" },
    ])

    const branch = await h.client.send({ type: "session.fork", sessionId: h.sessionId, atItemId: first!.itemId })
    const branchId = (branch.ok ? branch.result!.sessionId : "") as SessionId
    expect((await timeline(h, branchId)).map((entry) => entry.label)).toEqual(["good start"])

    expect(await h.client.send({ type: "session.label", sessionId: h.sessionId, itemId: second!.itemId })).toMatchObject({ ok: true, result: { itemId: second!.itemId } })
    expect((await timeline(h)).map((entry) => entry.label)).toEqual(["good start", undefined])
  })

  test("refuses an item that is not a message of the session", async () => {
    const h = await boot()
    await say(h, "hello")
    const reply = await h.client.send({ type: "session.label", sessionId: h.sessionId, itemId: "itm_01M3K99AR430RP1AGHZQN64R74" as never, label: "x" })
    expect(reply).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  })

  test("labels and fork lineage survive a daemon restart", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-tree-restart-")))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot(undefined, dir)
    await say(first, "keep me")
    const [entry] = await timeline(first)
    await first.client.send({ type: "session.label", sessionId: first.sessionId, itemId: entry!.itemId, label: "keeper" })
    const fork = await first.client.send({ type: "session.fork", sessionId: first.sessionId })
    const forkId = (fork.ok ? fork.result!.sessionId : "") as SessionId
    const [removeDir, ...running] = cleanups.splice(0)
    for (const stop of running.reverse()) await stop()
    cleanups.push(removeDir!)

    const second = await bootExisting(dir)
    expect((await tree(second, forkId)).map((node) => [node.sessionId, node.parentId])).toEqual([[first.sessionId, undefined], [forkId, first.sessionId]])
    expect((await timeline(second, first.sessionId))[0]!.label).toBe("keeper")
  })
})

async function bootExisting(dir: string) {
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "tree2" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  return { client, sessionId: "" as SessionId, events: [] as SessionEvent[], dir }
}

describe("session.recap", () => {
  test("asks the model for a recap of the transcript, caches it until the session grows and refreshes on request", async () => {
    const calls: Array<{ system: string; prompt: string }> = []
    const h = await boot(async (input) => (calls.push(input), `  Goal: auth refactor (call ${calls.length})  `))
    await say(h, "split the auth module")
    const first = await h.client.send({ type: "session.recap", sessionId: h.sessionId })
    expect(first).toMatchObject({ ok: true, result: { text: "Goal: auth refactor (call 1)", cached: false } })
    expect(calls[0]!.system).toBe(RECAP_SYSTEM)
    expect(calls[0]!.prompt).toContain("User: split the auth module")
    expect(calls[0]!.prompt).toContain("Assistant: echo: split the auth module")

    expect(await h.client.send({ type: "session.recap", sessionId: h.sessionId })).toMatchObject({ ok: true, result: { text: "Goal: auth refactor (call 1)", cached: true } })
    expect(calls).toHaveLength(1)
    expect(await h.client.send({ type: "session.recap", sessionId: h.sessionId, refresh: true })).toMatchObject({ ok: true, result: { cached: false, text: "Goal: auth refactor (call 2)" } })
    await say(h, "now the tests")
    expect(await h.client.send({ type: "session.recap", sessionId: h.sessionId })).toMatchObject({ ok: true, result: { cached: false, text: "Goal: auth refactor (call 3)" } })
  })

  test("is refused without a model and on an empty session", async () => {
    const empty = await boot(async () => "never")
    expect(await empty.client.send({ type: "session.recap", sessionId: empty.sessionId })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    const bare = await boot()
    await say(bare, "hello")
    expect(await bare.client.send({ type: "session.recap", sessionId: bare.sessionId })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  })
})
