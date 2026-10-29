import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import type { ModelInfo, SessionEvent, SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { startDaemon } from "../src"
import { CLAUDE_MODELS } from "../src/claude-models"

/** Portable handoff between engines, merge-back of forks and the lineage tree, on the daemon with a recording engine and no process spawned. */
const NATIVE: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" }]
const ACP: ModelInfo = { id: "acp:fake", name: "fake · ACP", efforts: [] }

type Seen = { text: string; authority: string | undefined }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-portable-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-portable-proj-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
  const seen: Seen[] = []
  let store!: Store
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    info: { engine: "native", model: "gpt-6-luna" },
    models: { selectable: true, defaults: { model: "gpt-6-luna" }, list: () => [...NATIVE, ...CLAUDE_MODELS, ACP] },
    engine: ({ store: s }) => {
      store = s
      const engine: EnginePort = {
        async runTurn(turn: TurnInput) {
          seen.push({ text: turn.text, authority: turn.authority?.text })
          const request = turn.authority?.text ?? turn.text
          if (request === "boom") return { status: "error", code: "internal", message: "engine failed" }
          if (request.startsWith("run:")) {
            const tool = turn.newItemId()
            turn.emit({ type: "item.started", itemId: tool, kind: "tool_call", meta: { tool: "shell", input: JSON.stringify({ command: "bun test" }) } })
            turn.emit({ type: "item.completed", itemId: tool, status: "ok", text: "3 pass\n0 fail" })
          }
          const itemId = turn.newItemId()
          turn.emit({ type: "item.started", itemId, kind: "agent_message" })
          turn.emit({ type: "item.completed", itemId, status: "ok", text: `answer to ${request}` })
          return { status: "ok" }
        },
        needsCompaction: () => false,
        // As the native engine answers: nothing of its own to pack until its history has messages.
        compact: async (turn) => (store.engineMessages.load(turn.sessionId, "native").length ? { status: "ok", compacted: true } : { status: "ok", empty: true, note: "Nothing to compact: this model has not run a turn of this session yet." }),
      }
      return engine
    },
  })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "portable-test", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  const open = async (model: string) => {
    const created = await client.send({ type: "session.create", directory: project, choice: { model } })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    return sessionId
  }
  const say = async (sessionId: SessionId, text: string) => {
    const before = store.turns.list(sessionId).filter((turn) => turn.status !== "running").length
    const ack = await client.send({ type: "user.submit", sessionId, text, attachments: [] })
    if (ack.ok) await until(() => store.turns.list(sessionId).filter((turn) => turn.status !== "running").length > before)
    return ack
  }
  const use = (sessionId: SessionId, model: string) => client.send({ type: "session.model.set", sessionId, choice: { model } })
  return { client, seen, open, say, use, events, store: () => store }
}

describe("engine switch", () => {
  test("native to Claude Code hands over the earlier turns with command outcomes once; back to native rebuilds only what native missed as its own messages", async () => {
    const h = await boot()
    const session = await h.open("gpt-6-luna")
    await h.say(session, "first request")
    await h.say(session, "run: the tests")
    const switched = await h.use(session, "claude-opus")
    expect(switched).toMatchObject({ ok: true, result: { handoff: { from: "native", to: "Claude Code", turns: 2, omitted: 0 } } })
    await h.say(session, "continue")
    const handed = h.seen.at(-1)!.text
    expect(handed).toContain("continues on Claude Code")
    expect(handed).toContain("User: first request")
    expect(handed).toContain("Assistant: answer to run: the tests")
    expect(handed).toContain("- $ bun test -> ok: 3 pass 0 fail")
    expect(handed.endsWith("[End of handoff]\n\ncontinue")).toBe(true)
    expect(h.seen.at(-1)!.authority).toBe("continue")
    await h.say(session, "more")
    expect(h.seen.at(-1)!.text).toBe("more")
    const before = h.store().engineMessages.load(session, "native").length
    const back = await h.use(session, "gpt-6-luna")
    expect(back).toMatchObject({ ok: true, result: { handoff: { from: "Claude Code", to: "gpt-6-luna", turns: 2, omitted: 0, rebuilt: true } } })
    const rebuilt = h.store().engineMessages.load(session, "native").slice(before) as Array<{ role: string; content: string }>
    expect(rebuilt.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(rebuilt[0]!.content).toContain("ran on Claude Code until now and continues on gpt-6-luna")
    expect(rebuilt[0]!.content.endsWith("[End of handoff]\n\ncontinue")).toBe(true)
    expect(rebuilt.at(-1)!.content).toBe("answer to more")
    expect(JSON.stringify(rebuilt)).not.toContain("first request")
    // Already in its history: the next message goes as it is, and switching again rebuilds nothing.
    await h.say(session, "back")
    expect(h.seen.at(-1)!.text).toBe("back")
    expect(await h.use(session, "gpt-6-luna")).not.toMatchObject({ result: { handoff: expect.anything() } })
  })

  test("Claude Code's tool calls come to the native engine as records with their outputs, and a /compact of a session that moved earlier packs them", async () => {
    const h = await boot()
    const session = await h.open("claude-opus")
    await h.say(session, "first request")
    await h.say(session, "run: the tests")
    // A session that moved before rebuilding existed: its model changed without the switch command.
    h.store().setSessionModel(session, { model: "gpt-6-luna" })
    await h.client.send({ type: "session.compact", sessionId: session })
    await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state !== "writing"))
    expect(h.events.find((event) => event.type === "compaction.updated" && event.state !== "writing")).toMatchObject({ state: "packed" })
    const rebuilt = JSON.stringify(h.store().engineMessages.load(session, "native"))
    expect(rebuilt).toContain("[ran shell")
    expect(rebuilt).toContain("3 pass")
    expect(rebuilt).toContain("first request")
  })

  test("another ACP agent is a switch too, and staying on the same engine hands nothing", async () => {
    const h = await boot()
    const session = await h.open("claude-opus")
    await h.say(session, "one")
    expect(h.seen.at(-1)!.text).toBe("one")
    await h.say(session, "two")
    expect(h.seen.at(-1)!.text).toBe("two")
    expect(await h.use(session, "acp:fake")).toMatchObject({ ok: true, result: { handoff: { from: "Claude Code", to: "fake (ACP)", turns: 2 } } })
    await h.say(session, "three")
    expect(h.seen.at(-1)!.text).toContain("User: two")
  })

  test("handoffTokenCap sets the budget and 0 turns the automatic handoff off", async () => {
    const h = await boot()
    const session = await h.open("gpt-6-luna")
    for (let i = 0; i < 6; i++) await h.say(session, `question ${i} ${"y".repeat(900)}`)
    expect(await h.client.send({ type: "settings.set", patch: { handoffTokenCap: 800 } })).toMatchObject({ ok: true })
    const preview = await h.use(session, "claude-opus")
    const handoff = (preview as { result?: { handoff?: { turns: number; omitted: number; tokens: number } } }).result?.handoff
    expect(handoff!.omitted).toBeGreaterThan(0)
    expect(handoff!.tokens).toBeLessThanOrEqual(800)
    await h.say(session, "go")
    const text = h.seen.at(-1)!.text
    expect(text).toContain("Original request:\nquestion 0 ")
    expect(text).toContain("question 5 ")
    expect(text).toMatch(/\d+ earlier turns? (is|are) not included/)
    expect(text.length).toBeLessThan(800 * 4 + 600)
    const quiet = await h.open("gpt-6-luna")
    await h.client.send({ type: "settings.set", patch: { handoffTokenCap: 0 } })
    await h.say(quiet, "alpha")
    expect(await h.use(quiet, "claude-opus")).not.toMatchObject({ result: { handoff: expect.anything() } })
    await h.say(quiet, "beta")
    expect(h.seen.at(-1)!.text).toBe("beta")
  })

  test("a turn that fails hands the same context again on the next try", async () => {
    const h = await boot()
    const session = await h.open("gpt-6-luna")
    await h.say(session, "history to carry")
    await h.use(session, "claude-opus")
    await h.say(session, "boom")
    expect(h.seen.at(-1)!.text).toContain("User: history to carry")
    await h.say(session, "next")
    expect(h.seen.at(-1)!.text).toContain("User: history to carry")
    await h.say(session, "after")
    expect(h.seen.at(-1)!.text).toBe("after")
  })
})

describe("merge-back", () => {
  test("a fork's own turns arrive as context with the parent's next message, once, and only the new ones the next time", async () => {
    const h = await boot()
    const parent = await h.open("gpt-6-luna")
    await h.say(parent, "plan the work")
    const forked = await h.client.send({ type: "session.fork", sessionId: parent, transcript: true })
    if (!forked.ok) throw new Error(forked.error.message)
    const fork = forked.result!.sessionId as SessionId
    await h.client.subscribe(fork, 0)
    expect(await h.client.send({ type: "session.merge", sessionId: fork })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    await h.say(fork, "try approach B")
    expect(await h.client.send({ type: "session.merge", sessionId: fork })).toMatchObject({ ok: true, result: { fromSessionId: fork, intoSessionId: parent, turns: 1, omitted: 0, pending: 1 } })
    await h.say(parent, "what did B find?")
    const merged = h.seen.at(-1)!.text
    expect(merged).toContain("Merged back from the fork")
    expect(merged).toContain("User: try approach B")
    expect(merged).toContain("Assistant: answer to try approach B")
    expect(merged).not.toContain("User: plan the work")
    expect(merged.endsWith("[End of handoff]\n\nwhat did B find?")).toBe(true)
    await h.say(parent, "later")
    expect(h.seen.at(-1)!.text).toBe("later")
    expect(await h.client.send({ type: "session.merge", sessionId: fork })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    await h.say(fork, "and approach C")
    expect(await h.client.send({ type: "session.merge", sessionId: fork })).toMatchObject({ ok: true, result: { turns: 1 } })
    await h.say(parent, "C?")
    expect(h.seen.at(-1)!.text).toContain("User: and approach C")
    expect(h.seen.at(-1)!.text).not.toContain("approach B")
  })

  test("only a fork can be merged, into a session of its own family", async () => {
    const h = await boot()
    const parent = await h.open("gpt-6-luna")
    await h.say(parent, "root")
    const other = await h.open("gpt-6-luna")
    expect(await h.client.send({ type: "session.merge", sessionId: parent })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    const forked = await h.client.send({ type: "session.fork", sessionId: parent, transcript: true })
    const fork = (forked.ok ? forked.result!.sessionId : undefined) as SessionId
    await h.client.subscribe(fork, 0)
    await h.say(fork, "work")
    expect(await h.client.send({ type: "session.merge", sessionId: fork, intoSessionId: other })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(await h.client.send({ type: "session.merge", sessionId: "ses_01M41W58SPKJXXVP8B2YTCCR71" as SessionId })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })
})

describe("lineage tree", () => {
  test("session.tree carries sub-agents under their parent with model, state and result headline, and forks with their unmerged turns", async () => {
    const h = await boot()
    const parent = await h.open("gpt-6-luna")
    await h.say(parent, "root work")
    const forked = await h.client.send({ type: "session.fork", sessionId: parent, transcript: true })
    const fork = (forked.ok ? forked.result!.sessionId : undefined) as SessionId
    await h.client.subscribe(fork, 0)
    await h.say(fork, "fork work")
    const store = h.store()
    const child = "ses_01M41W58SPKJXXVP8B2YTCCR70" as SessionId
    store.createSession({ id: child, directory: store.sessionDirectory(parent)!, title: "scan the repo", parentId: parent })
    store.setSessionModel(child, { model: "claude-haiku" })
    store.tasks.put({ taskId: child, parentId: parent, rootId: parent, depth: 1, generation: 1, description: "scan the repo", agent: "explore", background: false, state: "completed", result: "\nFound 3 entry points\nmore detail", createdAt: 1, updatedAt: 2 })
    const reply = await h.client.send({ type: "session.tree", sessionId: fork })
    if (!reply.ok) throw new Error(reply.error.message)
    const nodes = reply.result!.nodes as Array<Record<string, unknown>>
    const root = nodes.find((node) => node.sessionId === parent)!
    const branch = nodes.find((node) => node.sessionId === fork)!
    const task = nodes.find((node) => node.sessionId === child)!
    expect(root).toMatchObject({ kind: "fork", model: "gpt-6-luna", state: "idle" })
    expect(branch).toMatchObject({ kind: "fork", parentId: parent, current: true, unmerged: 1 })
    expect(task).toMatchObject({ kind: "task", parentId: parent, model: "claude-haiku", state: "completed", agent: "explore", description: "scan the repo", headline: "Found 3 entry points" })
    // Opened from the sub-agent itself, the tree still starts at the session that started it.
    const fromChild = await h.client.send({ type: "session.tree", sessionId: child })
    if (!fromChild.ok) throw new Error(fromChild.error.message)
    const childNodes = fromChild.result!.nodes as Array<Record<string, unknown>>
    expect(childNodes.map((node) => node.sessionId)).toContain(parent)
    expect(childNodes.find((node) => node.sessionId === child)).toMatchObject({ current: true })
    await h.client.send({ type: "session.merge", sessionId: fork })
    const merged = await h.client.send({ type: "session.tree", sessionId: fork })
    expect((merged.ok ? (merged.result!.nodes as Array<Record<string, unknown>>) : []).find((node) => node.sessionId === fork)).toMatchObject({ unmerged: 0 })
  })
})
