import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { rankTurns, terms } from "../src/turn-recall"
import { recallFixture } from "./session-recall-fixture"

const cleanup: Array<() => void> = []
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run() })

/** A session whose turns each hold a request and an answer, with `compact()` recording a finished compaction after them. */
function fixture() {
  const history = recallFixture()
  cleanup.push(() => rmSync(history.dir, { recursive: true, force: true }), () => history.store.close())
  const { store, ids, sessionId } = history
  const append = store.sessionSink.append.bind(store.sessionSink)
  const turn = (user: string, assistant: string, options: { notice?: boolean; deltasOnly?: boolean } = {}) => {
    const turnId = ids("turn")
    append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    for (const [kind, text] of [["user_message", user], ["agent_message", assistant]] as const) {
      const itemId = ids("item")
      append({ type: "item.started", sessionId, turnId, itemId, kind, meta: options.notice ? { notice: true } : {} })
      append({ type: "item.delta", sessionId, itemId, text })
      append({ type: "item.completed", sessionId, itemId, status: "ok", ...(options.deltasOnly ? {} : { text }) })
    }
    append({ type: "turn.completed", sessionId, turnId })
    return turnId
  }
  const compact = (state: "packed" | "failed" = "packed") => append({ type: "compaction.updated", sessionId, turnId: ids("turn"), reason: "auto", state, followUp: "" })
  const on = (value = true) => store.settings.set({ experimental: { auto_recall: value } })
  const relevant = (query: string) => history.port.relevant!({ query, limit: 3, maxChars: 9000 })
  return { ...history, turn, compact, on, relevant }
}

test("auto_recall is off until the experiment is switched on", () => {
  const history = fixture()
  history.turn("Use pnpm, never npm, in this repository", "Noted: pnpm only.")
  history.compact()
  expect(history.relevant("which package manager, pnpm or npm")).toEqual([])
  history.on()
  expect(history.relevant("which package manager, pnpm or npm")).toMatchObject([{ turn: 1, user: "Use pnpm, never npm, in this repository", assistant: "Noted: pnpm only." }])
})

test("only turns a finished compaction packed away come back, never the ones still in the history", () => {
  const history = fixture()
  history.on()
  history.turn("The migration failed because the sqlite index was missing", "Added the index; the migration passes.")
  expect(history.relevant("sqlite migration index")).toEqual([])
  history.compact("failed")
  expect(history.relevant("sqlite migration index")).toEqual([])
  history.compact()
  history.turn("Now the sqlite migration index again", "Still fine.")
  expect(history.relevant("sqlite migration index").map((turn) => turn.turn)).toEqual([1])
})

test("a newer compaction re-reads the session, and notice or deltas-only turns are handled", () => {
  const history = fixture()
  history.on()
  history.turn("Background task finished: sqlite migration report", "Queued.", { notice: true })
  history.turn("Rename the sqlite migration helper", "Renamed it.", { deltasOnly: true })
  history.compact()
  expect(history.relevant("sqlite migration helper")).toMatchObject([{ turn: 1, user: "Rename the sqlite migration helper", assistant: "Renamed it." }])
  history.turn("Drop the legacy cache flag", "Dropped legacy cache flag.")
  history.compact()
  expect(history.relevant("legacy cache flag").map((turn) => turn.user)).toEqual(["Drop the legacy cache flag"])
})

test("ranking: accents and case fold, the best match comes first, a single shared common word recalls nothing", () => {
  expect(terms("Decisión FINAL de la API para the app")).toEqual(["decision", "final", "api", "app"])
  const turns = [
    { turn: 1, at: 0, user: "Set up the deploy script", assistant: "Deploy script added with a dry run." },
    { turn: 2, at: 0, user: "Why did the deploy fail?", assistant: "The deploy failed: the token expired. Rotated the token; deploy works." },
    { turn: 3, at: 0, user: "Fix the header colour", assistant: "Changed the header colour." },
  ]
  expect(rankTurns(turns, "the deploy token expired again", 3, 9000).map((turn) => turn.turn)).toEqual([2])
  expect(rankTurns(turns, "deploy", 3, 9000).map((turn) => turn.turn)).toEqual([2, 1])
  expect(rankTurns(turns, "update the footer layout please", 3, 9000)).toEqual([])
  expect(rankTurns(turns, "", 3, 9000)).toEqual([])
})

test("ranking bounds every recalled turn so all of them fit the budget", () => {
  const long = "deploy token ".repeat(2000)
  const hits = rankTurns([{ turn: 1, at: 0, user: long, assistant: long }, { turn: 2, at: 0, user: long, assistant: long }], "deploy token", 2, 3000)
  expect(hits).toHaveLength(2)
  for (const hit of hits) expect(hit.user.length + hit.assistant.length).toBeLessThanOrEqual(1500)
  expect(hits[0]!.assistant.endsWith("[…cut]")).toBe(true)
})
