import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createNativeEngine, memoryHistory, type ModelRequest } from "@mendcode/engine-native"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import type { EnginePort } from "@mendcode/kernel"
import { stop } from "../../engine-native/test/harness"
import { startDaemon, type Daemon } from "../src"

/**
 * The PR reviewer's notices reach the watching session as recorded notices (live e2e O2): shown in the transcript and stored, with no
 * model call and no engine turn, unless the user set `experimental.pr_review_prompts`. The outbox is seeded with a held notice and
 * offered when the session goes idle after one user turn; gh is never called.
 */

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const NOTICE = "PR review of acme/app#6 (head 2cd81c95): published, 1 finding."

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

/** A daemon whose session gets one user turn, after which the held PR review notice is offered; `turns` counts engine turns. */
async function deliver({ prompts, native }: { prompts?: boolean; native?: boolean } = {}) {
  const data = temp("mendd-notice-")
  const repo = temp("mendd-notice-repo-")
  let turns = 0
  const modelCalls: string[] = []
  const provider = { id: "scripted", model: "script-1", async *stream(request: ModelRequest) { modelCalls.push(JSON.stringify(request.messages).slice(-200)); yield* stop("ok") } }
  const counted = (engine: EnginePort): EnginePort => ({ ...engine, runTurn: (turn) => { turns++; return engine.runTurn(turn) } })
  const daemon: Daemon = await startDaemon({
    dir: data, socketPath: path.join(data, "mendd.sock"),
    prReview: { run: async () => ({ code: 1, out: "", err: "no gh" }), call: async () => ({ code: 1, out: "" }), intervalMs: 3_600_000, noGraph: true },
    ...(native ? { info: { engine: "native" } } : {}),
    engine: ({ clock, store, runLimits }) => counted(native
      ? createNativeEngine({ provider, tools: [], history: memoryHistory(), system: () => "sys", compactionPrompt: "summarize", cwdFor: (id) => store.sessionDirectory(id) ?? data, runLimits: (id) => runLimits.get(id) })
      : createFauxEngine({ clock, deltaMs: 1 })),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "notice" })
  await client.connect()
  cleanups.push(() => client.close())
  await client.send({ type: "settings.set", patch: { tier: "balanced", experimental: { pr_review: true, ...(prompts ? { pr_review_prompts: true } : {}) } } })
  const created = await client.send({ type: "session.create", directory: repo, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  mkdirSync(path.join(data, "pr-review"), { recursive: true })
  writeFileSync(path.join(data, "pr-review", "outbox.json"), JSON.stringify({ version: 1, sessions: { [sessionId]: [NOTICE] } }))
  // Loads the PR review service, whose outbox reads the held notice.
  expect((await client.send({ type: "pr.review", sessionId, action: "status", directory: repo })).ok).toBe(true)
  expect((await client.send({ type: "user.submit", sessionId, text: "hello", attachments: [] })).ok).toBe(true)
  const events = () => daemon.store.readAfter(sessionId, 0, 10_000) as SessionEvent[]
  const noticeItem = () => events().find((event) => event.type === "item.completed" && event.text === NOTICE)
  await until(() => !!noticeItem() && events().filter((event) => event.type === "turn.completed").length >= 2)
  await Bun.sleep(100)
  return { turns, modelCalls, events: events(), noticeItem: noticeItem()! }
}

test("a PR review notice is recorded in the session as a notice: no engine turn runs for it and no model answers it", async () => {
  const { turns, events, noticeItem } = await deliver()
  // One engine turn: the user's own message. The notice's turn never reached the engine.
  expect(turns).toBe(1)
  const started = events.find((event) => event.type === "item.started" && event.itemId === (noticeItem as Extract<SessionEvent, { type: "item.completed" }>).itemId)
  expect(started).toMatchObject({ kind: "user_message", meta: { notice: true } })
  const turnId = (started as Extract<SessionEvent, { type: "item.started" }>).turnId
  // Nothing in the notice's turn but the notice itself, and the turn completed.
  expect(events.filter((event) => event.type === "item.started" && event.turnId === turnId).map((event) => (event as { kind: string }).kind)).toEqual(["user_message"])
  expect(events.some((event) => event.type === "turn.completed" && event.turnId === turnId)).toBe(true)
  // The queued entry is stored with `noReply`, so a restart restores it as a recorded notice too.
  expect(events.find((event) => event.type === "queue.added" && event.text === NOTICE)).toMatchObject({ notice: true, turnOptions: { noReply: true } })
})

test("on the native engine a recorded notice calls no model either", async () => {
  const { modelCalls, noticeItem } = await deliver({ native: true })
  expect(noticeItem).toBeDefined()
  // The user's turn called the model once; the notice did not.
  expect(modelCalls).toHaveLength(1)
})

test("with experimental.pr_review_prompts the notice starts a turn the session's engine answers", async () => {
  const { turns } = await deliver({ prompts: true })
  expect(turns).toBe(2)
})
