import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { GlobalEvent, ItemId, SessionId, SessionSummary } from "@mendcode/protocol"
import { startDaemon } from "../src"

type Activity = Extract<GlobalEvent, { type: "session.activity" }>

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * The faux engine, plus the shapes another engine reports: `/agent-bg` launches a Claude Code style background agent (its call completes
 * with `background`, its end comes in a later turn as `/agent-end`), `/agent-fg` runs a foreground one until `release()`, and `/compact`
 * holds a compaction item open until `release()`.
 */
async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-sidebar-live-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let release: () => void = () => {}
  let launched = "" as ItemId
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    engine: ({ clock }) => {
      const faux = createFauxEngine({ clock, deltaMs: 1 })
      return {
        ...faux,
        async runTurn(input) {
          const text = input.text.trim()
          const held = () => new Promise<void>((resolve) => { release = resolve })
          if (text === "/agent-bg") {
            launched = input.newItemId()
            input.emit({ type: "item.started", itemId: launched, kind: "tool_call", meta: { tool: "agent explore", subagent: true, background: true } })
            input.emit({ type: "item.completed", itemId: launched, status: "ok", text: "running in the background", meta: { subagent: true, background: true, tool: "agent explore" } })
            return { status: "ok" }
          }
          if (text === "/agent-end") {
            const itemId = input.newItemId()
            input.emit({ type: "item.started", itemId, kind: "agent_message", meta: { agentParent: launched } })
            input.emit({ type: "item.completed", itemId, status: "ok", text: "found it", meta: { agentParent: launched, agentEnd: true } })
            return { status: "ok" }
          }
          if (text === "/agent-fg" || text === "/compact") {
            const itemId = input.newItemId()
            input.emit({ type: "item.started", itemId, kind: text === "/compact" ? "compaction" : "tool_call", meta: text === "/compact" ? {} : { tool: "agent review", subagent: true } })
            await held()
            input.emit({ type: "item.completed", itemId, status: "ok", text: "done" })
            return { status: "ok" }
          }
          return faux.runTurn(input)
        },
      }
    },
  })
  cleanups.push(() => daemon.stop())
  const activity: Activity[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "sidebar-live", onGlobal: (e) => void (e.type === "session.activity" && activity.push(e)) })
  await client.connect()
  cleanups.push(() => client.close())
  const create = async (title: string, parentId?: SessionId) => {
    const created = await client.send({ type: "session.create", directory: "/repo", title, ...(parentId ? { parentId } : {}) })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    return sessionId
  }
  const submit = (sessionId: SessionId, text: string) => client.send({ type: "user.submit", sessionId, text, attachments: [] })
  const last = (sessionId: SessionId) => activity.filter((a) => a.sessionId === sessionId).at(-1)
  const listed = async (sessionId: SessionId) => {
    const reply = await client.send({ type: "session.list", limit: 50 })
    return ((reply.ok ? (reply.result?.sessions as SessionSummary[]) : []) ?? []).find((session) => session.sessionId === sessionId)
  }
  const turns = (sessionId: SessionId) => daemon.store.readAfter(sessionId, 0).filter((e) => e.type === "turn.completed").length
  return { create, submit, last, listed, turns, release: () => release() }
}

describe("what the left list hears of sub-agents and compaction", () => {
  test("a resting session counts its child sessions while their turns run, in the push and in the list", async () => {
    const h = await boot()
    const parent = await h.create("parent")
    const one = await h.create("one", parent)
    const two = await h.create("two", parent)
    await h.submit(one, "/tool 400")
    await h.submit(two, "/tool 400")
    await until(() => h.last(parent)?.agents === 2)
    expect(h.last(parent)).toMatchObject({ state: "idle", agents: 2 })
    expect(await h.listed(parent)).toMatchObject({ agents: 2 })
    await until(() => h.turns(one) === 1 && h.turns(two) === 1)
    await until(() => h.last(parent)?.agents === undefined)
    expect((await h.listed(parent))?.agents).toBeUndefined()
  })

  test("an engine's own agent call counts while it runs, and a background one until its end is reported", async () => {
    const h = await boot()
    const id = await h.create("claude")
    await h.submit(id, "/agent-fg")
    await until(() => h.last(id)?.agents === 1)
    h.release()
    await until(() => h.turns(id) === 1)
    await until(() => h.last(id)?.agents === undefined)

    await h.submit(id, "/agent-bg")
    await until(() => h.turns(id) === 2)
    // The turn ended, the agent still runs: the session rests with one at work.
    await until(() => h.last(id)?.state === "idle" && h.last(id)?.agents === 1)
    expect(await h.listed(id)).toMatchObject({ agents: 1 })
    await h.submit(id, "/agent-end")
    await until(() => h.turns(id) === 3)
    await until(() => h.last(id)?.state === "idle" && h.last(id)?.agents === undefined)
  })

  test("a compaction item marks the session compacting until it completes", async () => {
    const h = await boot()
    const id = await h.create("long")
    await h.submit(id, "/compact")
    await until(() => h.last(id)?.compacting === true)
    expect(await h.listed(id)).toMatchObject({ compacting: true })
    h.release()
    await until(() => h.turns(id) === 1)
    await until(() => h.last(id)?.compacting === undefined && h.last(id)?.state === "idle")
  })
})
