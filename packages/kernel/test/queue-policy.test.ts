import { afterEach, expect, test } from "bun:test"
import type { QueueId, Settings } from "@mendcode/protocol"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush } from "./helpers"

type Mode = NonNullable<Settings["queue"]>["mode"]
const cleanups: Array<() => void> = []
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose() })

function setup(initial?: Mode, ignoreAbort = false) {
  const h = createHarness()
  const manual = createManualEngine({ ignoreAbort })
  const sessionId = h.ids("session"), clientId = h.ids("client")
  let mode = initial
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, queueMode: () => mode, cancelGraceMs: 100 })
  cleanups.push(() => h.root.dispose())
  const submit = (text: string) => actor.handle({ type: "user.submit", id: h.ids("command"), clientId, sessionId, text, attachments: [] })
  const command = (value: Record<string, unknown>) => actor.handle({ id: h.ids("command"), clientId, sessionId, ...value } as Parameters<typeof actor.handle>[0])
  const queued = (result: Awaited<ReturnType<typeof submit>>) => { if (!result.ok) throw new Error(result.message); return result.result?.queueId as QueueId }
  return { h, manual, actor, submit, command, queued, setMode: (next: Mode) => { mode = next } }
}

for (const mode of [undefined, "after-response"] as const) test(`queue ${mode ?? "unset"} waits for the complete response`, async () => {
  const h = setup(mode)
  await h.submit("first")
  await h.submit("next")
  expect(await h.manual.last().input.takeQueued?.()).toBeUndefined()
  expect(h.manual.turns).toHaveLength(1)
  h.manual.last().finish()
  await flush()
  expect(h.manual.last().input.text).toBe("next")
})

test("messages queued behind a running turn start one next turn together, each kept as its own user message", async () => {
  const h = setup()
  await h.submit("first")
  const ref = { sha256: "b".repeat(64), bytes: 3, mime: "image/png" }
  const second = h.queued(await h.actor.handle({ type: "user.submit", id: h.h.ids("command"), clientId: h.h.ids("client"), sessionId: h.actor.sessionId, text: "expanded second", attachments: [ref] }, "second @file"))
  const third = h.queued(await h.submit("third"))
  h.manual.last().finish()
  await flush()
  expect(h.manual.turns).toHaveLength(2)
  const input = h.manual.last().input
  expect(input.text).toBe("expanded second\n\nthird")
  expect(input.attachments).toEqual([ref])
  expect(input.authority?.text).toBe("second @file\n\nthird")
  expect(h.actor.snapshot().queue).toHaveLength(0)
  expect(h.h.events.filter((e) => e.type === "turn.started").at(-1)).toMatchObject({ queueId: second, joinedQueueIds: [third] })
  expect(h.h.events.filter((e) => e.type === "item.started" && e.kind === "user_message" && e.turnId === input.turnId)).toHaveLength(2)
  expect(h.h.events.filter((e) => e.type === "item.completed").map((e) => e.text)).toEqual(["first", "expanded second", "third"])
})

test("only plain messages with the same selection join; shells, notices, compactions and other selections keep their boundary", async () => {
  const h = setup()
  await h.submit("first")
  await h.submit("a")
  await h.submit("b")
  await h.command({ type: "user.shell", command: "git status" })
  await h.submit("c")
  await h.command({ type: "user.submit", text: "d", attachments: [], selection: { agent: "build" } })
  await h.actor.notify("[notice]")
  await h.command({ type: "session.compact" })
  const texts: string[] = []
  for (let i = 0; i < 6; i++) {
    h.manual.last().finish()
    await flush()
    texts.push(h.manual.last().input.text)
  }
  expect(texts).toEqual(["a\n\nb", "git status", "c", "d", "[notice]", ""])
})

test("send now and restart start that one message alone; the rest of the queue joins the turn after it", async () => {
  const h = setup()
  await h.submit("first")
  await h.submit("a")
  const b = h.queued(await h.submit("b"))
  await h.submit("c")
  await h.command({ type: "queue.promote", queueId: b })
  await flush()
  expect(h.manual.last().input.text).toBe("b")
  await h.command({ type: "user.submit", text: "now", attachments: [], delivery: "restart" })
  await flush()
  expect(h.manual.last().input.text).toBe("now")
  h.manual.last().finish()
  await flush()
  expect(h.manual.last().input.text).toBe("a\n\nc")
})

test("a held queue still waits: a user cancel never lets the joined messages start on their own", async () => {
  const h = setup()
  await h.submit("first")
  await h.submit("a")
  await h.submit("b")
  await h.command({ type: "turn.cancel", turnId: h.manual.last().input.turnId })
  await flush()
  expect(h.manual.turns).toHaveLength(1)
  expect(h.actor.snapshot()).toMatchObject({ held: true })
  await h.submit("c")
  await flush()
  expect(h.manual.last().input.text).toBe("a\n\nb\n\nc")
})

test("after-tools joins in FIFO order within the same turn with original authority and attachments", async () => {
  const h = setup("after-tools")
  await h.submit("first")
  const input = h.manual.last().input
  const ref = { sha256: "a".repeat(64), bytes: 3, mime: "image/png" }
  await h.actor.handle({ type: "user.submit", id: h.h.ids("command"), clientId: h.h.ids("client"), sessionId: h.actor.sessionId, text: "expanded", attachments: [ref] }, "original @file")
  await h.submit("third")
  expect(await input.takeQueued?.()).toMatchObject({ text: "expanded", attachments: [ref], authority: { text: "original @file" } })
  expect(await input.takeQueued?.()).toMatchObject({ text: "third" })
  expect(await input.takeQueued?.()).toBeUndefined()
  expect(h.actor.snapshot().queue).toHaveLength(0)
  expect(h.manual.turns).toHaveLength(1)
  expect(h.h.events.filter((e) => e.type === "item.completed").map((e) => e.text)).toEqual(["first", "expanded", "third"])
  expect(h.h.events.filter((e) => e.type === "turn.started")).toHaveLength(1)
})

test("a submitted message id names the user message, in its own turn and when it joins the running turn", async () => {
  const h = setup("after-tools")
  const own = h.h.ids("item"), joined = h.h.ids("item")
  await h.command({ type: "user.submit", text: "first", attachments: [], messageId: own })
  const input = h.manual.last().input
  await h.command({ type: "user.submit", text: "joins", attachments: [], messageId: joined })
  expect(h.h.events.find((e) => e.type === "queue.added" && e.text === "joins")).toMatchObject({ messageId: joined })
  expect(await input.takeQueued?.()).toMatchObject({ text: "joins", authority: { sourceId: joined } })
  expect(h.h.events.flatMap((e) => e.type === "item.started" && e.kind === "user_message" ? [e.itemId] : [])).toEqual([own, joined])
})

test("after-tools never consumes while a tool is open, a request is pending, or the turn was cancelled", async () => {
  const h = setup("after-tools", true)
  await h.submit("first")
  const input = h.manual.last().input
  await h.submit("next")
  const itemId = input.newItemId()
  input.emit({ type: "item.started", itemId, kind: "tool_call" })
  expect(await input.takeQueued?.()).toBeUndefined()
  input.emit({ type: "item.completed", itemId, status: "ok" })
  const request = input.ask({ kind: "approval", title: "Write", detail: "write file" })
  expect(await input.takeQueued?.()).toBeUndefined()
  await h.command({ type: "turn.cancel", turnId: input.turnId })
  expect(await request).toEqual({ kind: "abandoned" })
  expect(await input.takeQueued?.()).toBeUndefined()
  h.manual.last().finish()
  await flush()
  expect(h.actor.snapshot()).toMatchObject({ held: true, foreground: "queued" })
})

for (const kind of ["shell", "compact", "selection"] as const) test(`after-tools preserves the ${kind} turn boundary`, async () => {
  const h = setup("after-tools")
  await h.submit("first")
  await h.command(kind === "shell" ? { type: "user.shell", command: "git status" } : kind === "compact" ? { type: "session.compact" } : { type: "user.submit", text: "new agent", attachments: [], selection: { agent: "build" } })
  await h.submit("behind")
  expect(await h.manual.last().input.takeQueued?.()).toBeUndefined()
  expect(h.actor.snapshot().queue).toHaveLength(2)
  h.manual.last().finish()
  await flush()
  expect(h.manual.turns).toHaveLength(2)
})

test("immediate aborts before starting the next prompt and ignores stale output after grace", async () => {
  const h = setup("immediate", true)
  await h.submit("first")
  const previous = h.manual.last()
  await h.submit("next")
  expect(previous.input.signal.aborted).toBe(true)
  expect(h.manual.turns).toHaveLength(1)
  // The cancelled turn ends at once; the next prompt waits as queued until the engine has stopped.
  expect(h.h.events.filter((e) => e.type === "turn.cancelled")).toHaveLength(1)
  expect(h.actor.snapshot().foreground).toBe("queued")
  h.h.clock.advance(100)
  await flush()
  expect(h.manual.last().input.text).toBe("next")
  previous.input.emit({ type: "item.started", itemId: h.h.ids("item"), kind: "agent_message" })
  previous.finish()
  await flush()
  expect(h.h.events.filter((e) => e.type === "turn.cancelled")).toHaveLength(1)
  expect(h.manual.turns).toHaveLength(2)
})

test("live mode changes, drop and send preserve user stop-and-hold", async () => {
  const h = setup()
  await h.submit("first")
  const next = h.queued(await h.submit("next"))
  const last = h.queued(await h.submit("drop me"))
  h.setMode("after-tools")
  await h.command({ type: "queue.remove", queueId: last })
  await h.command({ type: "turn.cancel", turnId: h.manual.last().input.turnId })
  await flush()
  expect(h.actor.snapshot()).toMatchObject({ held: true, queue: [next] })
  await h.command({ type: "queue.promote", queueId: next })
  await flush()
  expect(h.manual.last().input.text).toBe("next")
  expect(await h.command({ type: "queue.remove", queueId: last })).toMatchObject({ ok: false, code: "target_mismatch" })
  h.setMode("immediate")
  await h.submit("now")
  await flush()
  expect(h.manual.last().input.text).toBe("now")
})

test("send now hands the message to an engine that takes it mid-turn: nothing is cancelled and the message's turn follows this one", async () => {
  const h = setup()
  await h.submit("first")
  const handed: string[] = []
  h.manual.last().input.onSendNow?.((message) => { handed.push(message.text); return true })
  const next = h.queued(await h.submit("next"))
  await h.command({ type: "queue.promote", queueId: next })
  await flush()
  expect(handed).toEqual(["next"])
  expect(h.manual.last().input.signal.aborted).toBe(false)
  expect(h.h.events.filter((e) => e.type === "turn.cancelled")).toHaveLength(0)
  expect(h.actor.snapshot().queue).toEqual([next])
  h.manual.last().finish()
  await flush()
  expect(h.manual.turns).toHaveLength(2)
  expect(h.manual.last().input.text).toBe("next")
})

test("send now still cancels when the engine does not take the message", async () => {
  const h = setup()
  await h.submit("first")
  h.manual.last().input.onSendNow?.(() => false)
  const next = h.queued(await h.submit("next"))
  await h.command({ type: "queue.promote", queueId: next })
  await flush()
  expect(h.h.events.filter((e) => e.type === "turn.cancelled")).toHaveLength(1)
  expect(h.manual.last().input.text).toBe("next")
})

test("a full queue refuses one more message before anything is stored; the store refusing a message changes nothing", async () => {
  const h = setup()
  await h.submit("running")
  for (let i = 0; i < 256; i++) { h.h.clock.advance(1); h.queued(await h.submit(`m${i}`)) }
  const added = h.h.events.filter((event) => event.type === "queue.added").length
  expect(await h.submit("one more")).toMatchObject({ ok: false, code: "busy" })
  expect(await h.command({ type: "user.shell", command: "ls" })).toMatchObject({ ok: false, code: "busy" })
  expect(h.h.events.filter((event) => event.type === "queue.added")).toHaveLength(added)
  expect(h.actor.snapshot().queue).toHaveLength(256)

  const small = setup()
  await small.submit("running")
  const append = small.h.sink.append
  small.h.sink.append = (draft) => { if (draft.type === "queue.added") throw new RangeError("[STORE]: event queue.added is 90000 bytes; use the blob store"); return append(draft) }
  expect(await small.submit('"'.repeat(50_000))).toMatchObject({ ok: false, code: "invalid_command", message: expect.stringContaining("could not be stored") })
  expect(small.actor.snapshot().queue).toHaveLength(0)
  small.h.sink.append = append
  expect(await small.submit("after")).toMatchObject({ ok: true })
})
