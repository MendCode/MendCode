import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { GOALS_KEPT_PER_SESSION, openStore } from "../src"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const ids = createIdFactory()

function open() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-goals-"))
  dirs.push(dir)
  let now = 1_000
  const store = openStore({ dir, now: () => now })
  const session = ids("session")
  store.createSession({ id: session, directory: "/repo", title: "t" })
  return { store, session, dir, tick: (ms = 10) => void (now += ms) }
}

describe("goals store", () => {
  test("a new goal is active with no usage; the session's current goal is the one not superseded", () => {
    const { store, session } = open()
    expect(store.goals.current(session)).toBeUndefined()
    const goalId = ids("goal")
    const { created, replaced } = store.goals.insert({ goalId, sessionId: session, objective: "ship", tokenBudget: 5000 })
    expect(replaced).toBeUndefined()
    expect(created).toEqual({ goal: { goalId, sessionId: session, objective: "ship", status: "active", tokenBudget: 5000, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1_000, updatedAt: 1_000 }, budgetNoticeSent: false })
    expect(store.goals.current(session)?.goal.goalId).toBe(goalId)
    expect(store.goals.activeSessions()).toEqual([session])
    store.close()
  })

  test("a replacement keeps the old row as history; clear supersedes without deleting", () => {
    const { store, session, tick } = open()
    const first = ids("goal")
    store.goals.insert({ goalId: first, sessionId: session, objective: "one" })
    tick()
    const second = ids("goal")
    const { replaced } = store.goals.insert({ goalId: second, sessionId: session, objective: "two" })
    expect(replaced?.goal.goalId).toBe(first)
    expect(store.goals.current(session)?.goal.goalId).toBe(second)
    expect(store.goals.history(session).map((goal) => goal.objective)).toEqual(["two", "one"])
    tick()
    expect(store.goals.clear(session)?.goal.goalId).toBe(second)
    expect(store.goals.current(session)).toBeUndefined()
    expect(store.goals.clear(session)).toBeUndefined()
    expect(store.goals.history(session).map((goal) => goal.objective)).toEqual(["two", "one"])
    store.close()
  })

  test("update changes the named fields; null clears an optional one; usage adds up atomically and time is reported in whole seconds", () => {
    const { store, session, tick } = open()
    const goalId = ids("goal")
    store.goals.insert({ goalId, sessionId: session, objective: "o", tokenBudget: 100 })
    tick()
    const updated = store.goals.update(goalId, { status: "blocked", note: "needs a key", stalled: "x", tokenBudget: null, objectiveFile: "/tmp/o.md", activeSince: 1_500, budgetNoticeSent: true, pendingSteer: "objective_updated" })!
    expect(updated.goal).toMatchObject({ status: "blocked", note: "needs a key", stalled: "x", objectiveFile: "/tmp/o.md", activeSince: 1_500, updatedAt: 1_010 })
    expect(updated.goal.tokenBudget).toBeUndefined()
    expect(updated).toMatchObject({ budgetNoticeSent: true, pendingSteer: "objective_updated" })
    const cleared = store.goals.update(goalId, { note: null, stalled: null, activeSince: null, pendingSteer: null })!
    expect(cleared.goal.note).toBeUndefined()
    expect(cleared.goal.stalled).toBeUndefined()
    expect(cleared.goal.activeSince).toBeUndefined()
    expect(cleared.pendingSteer).toBeUndefined()
    store.goals.addUsage(goalId, { tokens: 120, ms: 400 })
    const summed = store.goals.addUsage(goalId, { tokens: 30.9, ms: 700 })!
    expect(summed.goal).toMatchObject({ tokensUsed: 150, timeUsedSeconds: 1 })
    expect(store.goals.addUsage(goalId, { tokens: -5, ms: -5 })!.goal.tokensUsed).toBe(150)
    expect(store.goals.update(ids("goal"), { status: "paused" })).toBeUndefined()
    store.close()
  })

  test("activeSessions lists only active, unstalled current goals; withRunningTurn finds goals whose turn never closed", () => {
    const { store, session, tick } = open()
    const other = ids("session")
    store.createSession({ id: other, directory: "/repo", title: "o" })
    const a = ids("goal")
    const b = ids("goal")
    store.goals.insert({ goalId: a, sessionId: session, objective: "a" })
    store.goals.insert({ goalId: b, sessionId: other, objective: "b" })
    expect(store.goals.activeSessions().sort()).toEqual([session, other].sort())
    store.goals.update(b, { stalled: "failed" })
    expect(store.goals.activeSessions()).toEqual([session])
    store.goals.update(a, { status: "paused", activeSince: 1_100 })
    expect(store.goals.activeSessions()).toEqual([])
    expect(store.goals.withRunningTurn().map((entry) => entry.goal.goalId)).toEqual([a])
    tick()
    store.close()
  })

  test("only the newest goals of a session are kept, and deleting the session deletes its goals", () => {
    const { store, session, tick } = open()
    for (let i = 0; i < GOALS_KEPT_PER_SESSION + 5; i++) {
      tick()
      store.goals.insert({ goalId: ids("goal"), sessionId: session, objective: `goal ${i}` })
    }
    const history = store.goals.history(session, 100)
    expect(history).toHaveLength(GOALS_KEPT_PER_SESSION)
    expect(history[0]!.objective).toBe(`goal ${GOALS_KEPT_PER_SESSION + 4}`)
    expect(store.goals.current(session)?.goal.objective).toBe(`goal ${GOALS_KEPT_PER_SESSION + 4}`)
    store.deleteSession(session)
    expect(store.goals.history(session, 100)).toEqual([])
    store.close()
  })

  test("goals survive reopening the store", () => {
    const { store, session, dir } = open()
    const goalId = ids("goal")
    store.goals.insert({ goalId, sessionId: session, objective: "persist me" })
    store.goals.addUsage(goalId, { tokens: 7 })
    store.close()
    const again = openStore({ dir })
    expect(again.goals.current(session)?.goal).toMatchObject({ objective: "persist me", tokensUsed: 7, status: "active" })
    again.close()
  })

  test("a goal.changed event is stored like any session event", () => {
    const { store, session } = open()
    const goalId = ids("goal")
    const { created } = store.goals.insert({ goalId, sessionId: session, objective: "evented" })
    const event = store.sessionSink.append({ type: "goal.changed", sessionId: session, change: "created", goal: created.goal, by: "user" })
    expect(event).toMatchObject({ type: "goal.changed", change: "created", by: "user", goal: { objective: "evented" } })
    expect(store.readAfter(session, 0).at(-1)).toEqual(event)
    store.close()
  })
})
