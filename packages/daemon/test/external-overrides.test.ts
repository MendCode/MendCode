import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import type { ItemId, ModelInfo, PermissionMode, SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { startDaemon } from "../src"
import { CLAUDE_MODELS } from "../src/claude-models"

/** The daemon with a recording engine standing in for Claude Code and ACP agents: per-turn selections and forks of external sessions, no process spawned. */
const NATIVE: ModelInfo[] = [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" }]
const ACP: ModelInfo = { id: "acp:fake", name: "fake · ACP", efforts: [] }

type Seen = { text: string; selection: TurnInput["selection"]; mode: PermissionMode; authority: string | undefined }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

async function boot() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-external-")))
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-external-proj-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => rmSync(project, { recursive: true, force: true }))
  mkdirSync(path.join(dir, "agents"))
  writeFileSync(path.join(dir, "agents", "review.md"), "---\ndescription: Reviews changes\nmode: primary\n---\nInspect the changes only.")
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
        async runTurn(turn) {
          seen.push({ text: turn.text, selection: turn.selection, mode: turn.permissionMode(), authority: turn.authority?.text })
          const itemId = turn.newItemId()
          turn.emit({ type: "item.started", itemId, kind: "agent_message" })
          turn.emit({ type: "item.completed", itemId, status: "ok", text: `answer to ${turn.authority?.text ?? turn.text}` })
          return { status: "ok" }
        },
        needsCompaction: () => false,
        compact: async () => ({ status: "ok" }),
      }
      return engine
    },
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "external-test" })
  await client.connect()
  cleanups.push(() => client.close())
  const open = async (model: string) => {
    const created = await client.send({ type: "session.create", directory: project, choice: { model } })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await client.subscribe(sessionId, 0)
    return sessionId
  }
  const say = async (sessionId: SessionId, text: string, selection?: TurnInput["selection"]) => {
    const before = store.turns.list(sessionId).filter((turn) => turn.status !== "running").length
    const ack = await client.send({ type: "user.submit", sessionId, text, attachments: [], ...(selection ? { selection } : {}) })
    if (ack.ok) await until(() => store.turns.list(sessionId).filter((turn) => turn.status !== "running").length > before)
    return ack
  }
  return { client, seen, open, say, project, store: () => store }
}

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("a Claude Code session takes a per-turn model, variant and agent; the saved selection does not change", async () => {
  const h = await boot()
  const session = await h.open("claude-opus")
  const ack = await h.say(session, "check it", { model: { model: "claude-sonnet", variant: "low" }, agent: "review" })
  expect(ack).toMatchObject({ ok: true })
  expect(h.seen[0]!.selection).toEqual({ model: { model: "claude-sonnet", effort: "low" }, agent: "review" })
  expect(h.seen[0]!.text).toBe('[Instructions of agent "review" for this message]\nInspect the changes only.\n[End of agent instructions]\n\ncheck it')
  expect(h.seen[0]!.authority).toBe("check it")
  expect(h.store().sessionModel(session)).toEqual({ model: "claude-opus" })
  expect(h.store().sessionAgent(session)).toBeUndefined()
  await h.say(session, "plain")
  expect(h.seen[1]).toMatchObject({ text: "plain", selection: undefined })
})

test("a command with an agent and model runs on a Claude session as a per-turn selection; a subtask command is refused there", async () => {
  const h = await boot()
  writeFileSync(path.join(h.project, "mendcode.json"), JSON.stringify({ command: { audit: { template: "Audit $ARGUMENTS", agent: "review", model: "claude-sonnet" }, nested: { template: "x", subtask: true } } }))
  await h.client.send({ type: "tools.trust", directory: h.project, trusted: true })
  const session = await h.open("claude-opus")
  expect(await h.client.executeCommand({ sessionId: session, name: "audit", args: "the diff" })).toMatchObject({ ok: true })
  await until(() => h.seen.length === 1)
  expect(h.seen[0]!.selection).toMatchObject({ model: { model: "claude-sonnet" }, agent: "review" })
  expect(h.seen[0]!.text).toContain("Audit the diff")
  expect(await h.client.executeCommand({ sessionId: session, name: "nested", args: "" })).toMatchObject({ ok: false })
  expect(h.seen).toHaveLength(1)
})

test("the plan agent makes an external turn read-only, and a native session can borrow a Claude model for one turn", async () => {
  const h = await boot()
  const session = await h.open("gpt-6-luna")
  await h.client.send({ type: "session.permission.set", sessionId: session, mode: "full" })
  await h.say(session, "borrow", { model: { model: "claude-haiku" }, agent: "plan" })
  expect(h.seen[0]).toMatchObject({ mode: "plan", selection: { model: { model: "claude-haiku" }, agent: "plan" } })
  await h.say(session, "again", { model: { model: "claude-opus" }, agent: "build" })
  expect(h.seen[1]!.mode).toBe("full")
})

test("an ACP model is selectable per turn but has no variants; unknown variants and agents are refused", async () => {
  const h = await boot()
  const session = await h.open("gpt-6-luna")
  expect(await h.say(session, "acp", { model: { model: "acp:fake" } })).toMatchObject({ ok: true })
  expect(h.seen[0]!.selection).toEqual({ model: { model: "acp:fake" } })
  expect(await h.say(session, "x", { model: { model: "acp:fake", variant: "high" } })).toMatchObject({ ok: false })
  expect(await h.say(session, "x", { model: { model: "claude-opus", variant: "turbo" } })).toMatchObject({ ok: false })
  expect(await h.say(session, "x", { model: { model: "claude-haiku", variant: "high" } })).toMatchObject({ ok: false })
  expect(await h.say(session, "x", { agent: "missing" })).toMatchObject({ ok: false })
  expect(h.seen).toHaveLength(1)
})

test("a fork of a Claude Code session hands its copied transcript to the first external turn only, within the history limit", async () => {
  const h = await boot()
  const session = await h.open("claude-opus")
  h.store().engineBindings.set(session, "claude", "cc-1")
  await h.say(session, "first question")
  await h.say(session, "second question")
  const turns = h.store().turns.list(session)
  const fork = await h.client.send({ type: "session.fork", sessionId: session, beforeItemId: turns[1]!.itemId as ItemId })
  if (!fork.ok) throw new Error(fork.error.message)
  const forked = fork.result!.sessionId as SessionId
  await h.client.subscribe(forked, 0)
  await h.say(forked, "branch question")
  const seeded = h.seen.at(-1)!.text
  expect(seeded).toContain("User: first question")
  expect(seeded).toContain("Assistant: answer to first question")
  expect(seeded).not.toContain("second question")
  expect(seeded.endsWith("branch question")).toBe(true)
  expect(h.seen.at(-1)!.authority).toBe("branch question")
  await h.say(forked, "next")
  expect(h.seen.at(-1)!.text).toBe("next")
  // A fork whose parent had no Claude binding still starts a new Claude conversation: it gets the copied turns too, once.
  const native = await h.open("claude-opus")
  await h.say(native, "one")
  const plain = await h.client.send({ type: "session.fork", sessionId: native, transcript: true })
  if (!plain.ok) throw new Error(plain.error.message)
  const plainId = plain.result!.sessionId as SessionId
  await h.client.subscribe(plainId, 0)
  await h.say(plainId, "fresh")
  expect(h.seen.at(-1)!.text).toContain("User: one")
  expect(h.seen.at(-1)!.text.endsWith("fresh")).toBe(true)
  await h.say(plainId, "again")
  expect(h.seen.at(-1)!.text).toBe("again")
})

test("the fork seed keeps the newest messages when the history exceeds the limit", async () => {
  const h = await boot()
  const session = await h.open("claude-opus")
  h.store().engineBindings.set(session, "claude", "cc-2")
  const filler = "x".repeat(7_000)
  for (let i = 0; i < 12; i++) await h.say(session, `question ${i} ${filler}`)
  const fork = await h.client.send({ type: "session.fork", sessionId: session, transcript: true })
  if (!fork.ok) throw new Error(fork.error.message)
  const forked = fork.result!.sessionId as SessionId
  await h.client.subscribe(forked, 0)
  await h.say(forked, "continue")
  const text = h.seen.at(-1)!.text
  expect(text).toContain("question 11 ")
  // The original request stays as its own block; the turns after it that do not fit are counted and left out.
  expect(text).toContain("Original request:\nquestion 0 ")
  expect(text).not.toContain("User: question 1 ")
  expect(text).toMatch(/\d+ earlier turns are not included/)
  expect(text.length).toBeLessThan(16_000 * 4 + 1_000)
})
