import { afterEach, expect, test } from "bun:test"
import type { QueueId, Settings } from "@mendcode/protocol"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush } from "./helpers"

type Mode = NonNullable<Settings["queue"]>["mode"]
const cleanups: Array<() => void> = []
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose() })

type Waiting = NonNullable<Parameters<typeof createSessionActor>[0]["waitingNotice"]>
function setup(options: { mode?: Mode; canSteer?: boolean; waitingNotice?: Waiting } = {}) {
  const h = createHarness()
  const manual = createManualEngine({})
  const sessionId = h.ids("session"), clientId = h.ids("client")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, queueMode: () => options.mode, ...(options.canSteer === undefined ? {} : { canSteer: () => options.canSteer! }), ...(options.waitingNotice ? { waitingNotice: options.waitingNotice } : {}), cancelGraceMs: 100 })
  cleanups.push(() => h.root.dispose())
  const command = (value: Record<string, unknown>) => actor.handle({ id: h.ids("command"), clientId, sessionId, ...value } as Parameters<typeof actor.handle>[0])
  const submit = (text: string, extra: Record<string, unknown> = {}) => command({ type: "user.submit", text, attachments: [], ...extra })
  const queued = (result: Awaited<ReturnType<typeof submit>>) => { if (!result.ok) throw new Error(result.message); return result.result?.queueId as QueueId }
  return { h, manual, actor, command, submit, queued }
}

test("a steered message joins the running turn after the next tool result, ahead of earlier queued messages, under any policy", async () => {
  const s = setup()
  await s.submit("first")
  const input = s.manual.last().input
  await s.submit("plain")
  const steered = await s.submit("steer me", { delivery: "steer" })
  expect(steered).toMatchObject({ ok: true, result: { steered: true, delivery: "steer" } })
  expect(await input.takeQueued?.()).toMatchObject({ text: "steer me" })
  // The policy is after-response: the plain message still waits for the response.
  expect(await input.takeQueued?.()).toBeUndefined()
  expect(s.manual.turns).toHaveLength(1)
  s.manual.last().finish()
  await flush()
  expect(s.manual.last().input.text).toBe("plain")
  expect(s.h.events.filter((e) => e.type === "turn.started")).toHaveLength(2)
})

test("steer needs a running turn the engine can inject into; otherwise it queues and never interrupts", async () => {
  const s = setup({ canSteer: false, mode: "immediate" })
  await s.submit("first")
  const input = s.manual.last().input
  const answer = await s.submit("later", { delivery: "steer" })
  expect(answer).toMatchObject({ ok: true, result: { steered: false, delivery: "queue" } })
  expect(input.signal.aborted).toBe(false)
  expect(await input.takeQueued?.()).toBeUndefined()
  s.manual.last().finish()
  await flush()
  expect(s.manual.last().input.text).toBe("later")
})

test("steer with nothing running just sends", async () => {
  const s = setup()
  expect(await s.submit("hello", { delivery: "steer" })).toMatchObject({ ok: true, result: { steered: false } })
  expect(s.manual.last().input.text).toBe("hello")
})

test("delivery queue waits for the response even when the policy injects or interrupts; restart interrupts", async () => {
  const s = setup({ mode: "after-tools" })
  await s.submit("first")
  const input = s.manual.last().input
  await s.submit("waits", { delivery: "queue" })
  expect(await input.takeQueued?.()).toBeUndefined()
  expect(s.actor.snapshot().queue).toHaveLength(1)
  const interrupting = setup({ mode: "immediate" })
  await interrupting.submit("first")
  const running = interrupting.manual.last()
  await interrupting.submit("calm", { delivery: "queue" })
  expect(running.input.signal.aborted).toBe(false)
  const restart = await interrupting.submit("now", { delivery: "restart" })
  expect(restart).toMatchObject({ ok: true, result: { delivery: "restart" } })
  expect(running.input.signal.aborted).toBe(true)
  interrupting.h.clock.advance(100)
  await flush()
  expect(interrupting.manual.last().input.text).toBe("now")
})

test("queue.reorder moves one place, to the ends or to a position, and reports the final one", async () => {
  const s = setup()
  await s.submit("first")
  const a = s.queued(await s.submit("a")), b = s.queued(await s.submit("b")), c = s.queued(await s.submit("c"))
  expect(await s.command({ type: "queue.reorder", queueId: c, to: "up" })).toMatchObject({ ok: true, result: { position: 1 } })
  expect(s.actor.snapshot().queue).toEqual([a, c, b])
  await s.command({ type: "queue.reorder", queueId: a, to: "bottom" })
  expect(s.actor.snapshot().queue).toEqual([c, b, a])
  await s.command({ type: "queue.reorder", queueId: a, to: "top" })
  await s.command({ type: "queue.reorder", queueId: a, to: "down" })
  expect(s.actor.snapshot().queue).toEqual([c, a, b])
  expect(await s.command({ type: "queue.reorder", queueId: b, to: 99 })).toMatchObject({ ok: true, result: { position: 2 } })
  expect(await s.command({ type: "queue.reorder", queueId: b, to: 0 })).toMatchObject({ ok: true, result: { position: 0 } })
  expect(s.actor.snapshot().queue).toEqual([b, c, a])
  const last = [...s.h.events].reverse().find((e) => e.type === "queue.changed")
  expect(last?.type === "queue.changed" ? last.queue.map((entry) => entry.queueId) : []).toEqual([b, c, a])
  expect(await s.command({ type: "queue.reorder", queueId: "queue_missing" as QueueId, to: "up" })).toMatchObject({ ok: false, code: "target_mismatch" })
  s.manual.last().finish()
  await flush()
  // The reordered messages start together, in their new order.
  expect(s.manual.last().input.text).toBe("b\n\nc\n\na")
})

test("queue.edit replaces the text in place and the next turn runs the edit", async () => {
  const s = setup()
  await s.submit("first")
  const id = s.queued(await s.submit("typo"))
  const other = s.queued(await s.submit("other"))
  expect(await s.command({ type: "queue.edit", queueId: id, text: "fixed" })).toEqual({ ok: true })
  expect(s.actor.snapshot().queue).toEqual([id, other])
  expect(s.h.events.find((e) => e.type === "queue.edited")).toMatchObject({ queueId: id, text: "fixed" })
  expect(await s.command({ type: "queue.list" })).toMatchObject({ ok: true, result: { entries: [{ queueId: id, text: "fixed", kind: "message", editable: true }, { queueId: other, text: "other" }] } })
  s.manual.last().finish()
  await flush()
  expect(s.manual.last().input.text).toBe("fixed\n\nother")
})

test("queue.edit refuses entries it cannot edit safely and unknown ids", async () => {
  const s = setup()
  await s.submit("first")
  const expanded = s.queued(await s.command({ type: "user.submit", text: "with file contents", attachments: [], displayText: "@file" }))
  const compact = s.queued(await s.command({ type: "session.compact" }))
  expect(await s.command({ type: "queue.edit", queueId: expanded, text: "x" })).toMatchObject({ ok: false, code: "invalid_command" })
  expect(await s.command({ type: "queue.edit", queueId: compact, text: "x" })).toMatchObject({ ok: false, code: "invalid_command" })
  expect(await s.command({ type: "queue.edit", queueId: "queue_missing" as QueueId, text: "x" })).toMatchObject({ ok: false, code: "target_mismatch" })
  expect(await s.command({ type: "queue.list" })).toMatchObject({ result: { entries: [{ editable: false }, { kind: "compact", editable: false }] } })
})

test("queue.steer promotes one queued message into the running turn; idle it sends; shell and compact refuse", async () => {
  const s = setup()
  await s.submit("first")
  const input = s.manual.last().input
  const a = s.queued(await s.submit("a"))
  const b = s.queued(await s.submit("b"))
  expect(await s.command({ type: "queue.steer", queueId: b })).toMatchObject({ ok: true, result: { steered: true } })
  expect(s.actor.snapshot().queue).toEqual([b, a])
  const changed = [...s.h.events].reverse().find((e) => e.type === "queue.changed")
  expect(changed?.type === "queue.changed" ? changed.queue[0] : undefined).toMatchObject({ queueId: b, delivery: "steer", kind: "message" })
  expect(await input.takeQueued?.()).toMatchObject({ text: "b" })
  expect(await input.takeQueued?.()).toBeUndefined()
  s.manual.last().finish()
  await flush()
  expect(s.manual.last().input.text).toBe("a")
  const compact = s.queued(await s.command({ type: "session.compact" }))
  expect(await s.command({ type: "queue.steer", queueId: compact })).toMatchObject({ ok: false, code: "invalid_command" })
})

test("queue.steer on a held queue with nothing running sends that message now", async () => {
  const h = createHarness()
  const manual = createManualEngine({})
  const sessionId = h.ids("session"), clientId = h.ids("client")
  const first = h.ids("queue"), second = h.ids("queue")
  const actor = createSessionActor({ sessionId, clock: h.clock, scope: h.root.child("session"), engine: manual.engine, sink: h.sink, ids: h.ids, restoredQueue: [{ queueId: first, text: "one", attachments: [] }, { queueId: second, text: "two", attachments: [] }] })
  cleanups.push(() => h.root.dispose())
  expect(actor.snapshot()).toMatchObject({ held: true })
  expect(await actor.handle({ type: "queue.steer", id: h.ids("command"), clientId, sessionId, queueId: second })).toMatchObject({ ok: true, result: { steered: false } })
  expect(manual.last().input.text).toBe("two")
})

test("a steered notice joins the running turn like a message", async () => {
  const s = setup()
  await s.submit("first")
  const input = s.manual.last().input
  await s.actor.notify("[message from another session]", undefined, false, "steer")
  expect(await input.takeQueued?.()).toMatchObject({ text: "[message from another session]", authority: { synthetic: true } })
})

/** What the daemon sends when a background task ends or a monitored line appears: join the running turn, nobody waits on a reply. */
const ends = (s: ReturnType<typeof setup>, text: string) => s.actor.notify(text, undefined, false, "steer", true)
const noticeItems = (s: ReturnType<typeof setup>) => s.h.events.filter((e) => e.type === "item.started" && e.kind === "user_message" && e.meta?.notice === true)
const lastQueue = (s: ReturnType<typeof setup>) => { const e = s.h.events.findLast((event) => event.type === "queue.changed"); return e?.type === "queue.changed" ? e.queue : [] }

test("a background notice joins the running turn at its next boundary, behind nothing, with no authority of its own", async () => {
  const s = setup()
  await s.submit("first")
  const input = s.manual.last().input
  const plain = s.queued(await s.submit("plain"))
  const notice = await ends(s, "[background task bg_1 exited 0]")
  // It keeps its place: the message the user queued earlier is still first if the turn ends before a boundary.
  expect(s.actor.snapshot().queue).toEqual([plain, notice!])
  expect(lastQueue(s)).toMatchObject([{ queueId: plain }, { queueId: notice, kind: "notice", delivery: "steer" }])
  const taken = await input.takeQueued?.()
  expect(taken).toEqual({ text: "[background task bg_1 exited 0]", attachments: [] })
  // Shown where it was delivered, inside the running turn, as a notice; gone from the queue; the user's message still waits.
  expect(noticeItems(s)).toMatchObject([{ turnId: s.actor.snapshot().turnId }])
  expect(s.actor.snapshot().queue).toEqual([plain])
  expect(lastQueue(s)).toMatchObject([{ queueId: plain }])
  expect(await input.takeQueued?.()).toBeUndefined()
  // Never twice: the turn ends and only the user's message gets a turn.
  s.manual.last().finish()
  await flush()
  expect(s.manual.turns).toHaveLength(2)
  expect(s.manual.last().input.text).toBe("plain")
  s.manual.last().finish()
  await flush()
  expect(s.manual.turns).toHaveLength(2)
  expect(noticeItems(s)).toHaveLength(1)
})

test("background notices that wait together are one message in the order they arrived", async () => {
  const s = setup()
  await s.submit("first")
  const input = s.manual.last().input
  await ends(s, "[background task bg_1 exited 0]")
  await ends(s, "[monitor bg_2: bun dev]\nready")
  await ends(s, "[background task bg_3 exited 1]")
  expect(await input.takeQueued?.()).toEqual({ text: "[background task bg_1 exited 0]\n\n[monitor bg_2: bun dev]\nready\n\n[background task bg_3 exited 1]", attachments: [] })
  expect(noticeItems(s)).toHaveLength(1)
  expect(s.h.events.filter((e) => e.type === "item.completed" && e.text?.includes("bg_3"))).toHaveLength(1)
  expect(s.actor.snapshot().queue).toEqual([])
  expect(await input.takeQueued?.()).toBeUndefined()
})

test("a turn that ends before a boundary leaves the background notice queued: it gets its own turn, once, after what was queued before it", async () => {
  const s = setup()
  await s.submit("first")
  await s.submit("plain")
  await ends(s, "[background task bg_1 exited 0]")
  s.manual.last().finish()
  await flush()
  expect(s.manual.last().input.text).toBe("plain")
  s.manual.last().finish()
  await flush()
  expect(s.manual.turns).toHaveLength(3)
  expect(s.manual.last().input).toMatchObject({ text: "[background task bg_1 exited 0]", authority: { synthetic: true } })
  s.manual.last().finish()
  await flush()
  expect(s.manual.turns).toHaveLength(3)
  expect(s.actor.snapshot()).toMatchObject({ foreground: "idle", queue: [] })
})

test("an idle session starts a turn for a background notice", async () => {
  const s = setup()
  await ends(s, "[background task bg_1 exited 0]")
  await flush()
  expect(s.manual.turns).toHaveLength(1)
  expect(s.manual.last().input).toMatchObject({ text: "[background task bg_1 exited 0]", authority: { synthetic: true } })
  expect(lastQueue(s)).toEqual([])
})

test("an engine with no injection boundary keeps a background notice an ordinary queued notice", async () => {
  const s = setup({ canSteer: false })
  await s.submit("first")
  const input = s.manual.last().input
  const notice = await ends(s, "[background task bg_1 exited 0]")
  expect(lastQueue(s)).toEqual([{ queueId: notice!, preview: "[background task bg_1 exited 0]", attachments: 0, kind: "notice" }])
  expect(await input.takeQueued?.()).toBeUndefined()
  s.manual.last().finish()
  await flush()
  expect(s.manual.last().input.text).toBe("[background task bg_1 exited 0]")
})

test("an engine with no injection boundary still takes a background notice under the after-tools policy, as before", async () => {
  const s = setup({ canSteer: false, mode: "after-tools" })
  await s.submit("first")
  await ends(s, "[background task bg_1 exited 0]")
  expect(await s.manual.last().input.takeQueued?.()).toMatchObject({ text: "[background task bg_1 exited 0]" })
})

test("a background notice arriving during a compaction or a pause waits for its own turn", async () => {
  const s = setup()
  await s.submit("first")
  s.manual.requestCompaction()
  s.manual.last().finish()
  await flush()
  expect(s.actor.snapshot().phase).toBe("compaction")
  const notice = await ends(s, "[background task bg_1 exited 0]")
  expect(lastQueue(s)).toMatchObject([{ queueId: notice }])
  expect(lastQueue(s)[0]?.delivery).toBeUndefined()
  s.manual.last().finish()
  await flush()
  expect(s.manual.last().input.text).toBe("[background task bg_1 exited 0]")
  await s.actor.pause(true)
  const paused = await ends(s, "[background task bg_2 exited 0]")
  expect(lastQueue(s).find((entry) => entry.queueId === paused)?.delivery).toBeUndefined()
  expect(await s.manual.last().input.takeQueued?.()).toBeUndefined()
})

test("a user cancel keeps a background notice that had not joined yet: it goes with the user's next message (FC-13)", async () => {
  const s = setup()
  await s.submit("first")
  const input = s.manual.last().input
  await ends(s, "[background task bg_1 exited 0]")
  await s.command({ type: "turn.cancel", turnId: s.actor.snapshot().turnId })
  await flush()
  await ends(s, "[background task bg_2 exited 1]")
  await flush()
  expect(await input.takeQueued?.()).toBeUndefined()
  expect(s.manual.turns).toHaveLength(1)
  expect(s.actor.snapshot()).toMatchObject({ foreground: "queued", held: true })
  expect(s.actor.snapshot().queue).toHaveLength(2)
  await s.submit("and now")
  await flush()
  expect(s.manual.turns).toHaveLength(2)
  const next = s.manual.last().input
  expect(next.text).toBe("[while the session was stopped, this happened]\n[background task bg_1 exited 0]\n\n[background task bg_2 exited 1]\n\n[the user's message]\nand now")
  expect(next.authority).toMatchObject({ text: "and now" })
  expect(next.authority?.synthetic).toBeUndefined()
  expect(s.actor.snapshot().queue).toEqual([])
  expect(noticeItems(s)).toHaveLength(0)
})

/** A notice another part keeps outside the queue (a finished sub-agent), as the daemon's outbox hands it over. */
function outbox(s: () => ReturnType<typeof setup>) {
  const pending: Array<{ text: string; at: number }> = []
  const log = { asked: 0, taken: [] as string[] }
  const waitingNotice: Waiting = () => {
    log.asked++
    const next = pending[0]
    if (!next) return undefined
    return { queueId: s().h.ids("queue"), text: next.text, at: next.at, taken: () => { pending.shift(); log.taken.push(next.text) } }
  }
  return { waitingNotice, log, add: (text: string) => pending.push({ text, at: s().h.clock.now() }) }
}

test("a notice kept outside the queue joins the running turn at its next boundary, logged under its queue id, once", async () => {
  const box = outbox(() => s)
  const s = setup({ waitingNotice: box.waitingNotice })
  await s.submit("first")
  const input = s.manual.last().input
  expect(await input.takeQueued?.()).toBeUndefined()
  box.add("[child one ended]")
  expect(s.actor.snapshot().queue).toEqual([])
  expect(await input.takeQueued?.()).toEqual({ text: "[child one ended]", attachments: [] })
  expect(box.log.taken).toEqual(["[child one ended]"])
  // In the log as a queued notice and as a notice item of this turn; nothing stays queued for after the turn.
  const added = s.h.events.filter((e) => e.type === "queue.added")
  expect(added.at(-1)).toMatchObject({ text: "[child one ended]", notice: true })
  expect(noticeItems(s)).toMatchObject([{ turnId: s.actor.snapshot().turnId }])
  expect(lastQueue(s)).toEqual([])
  expect(await input.takeQueued?.()).toBeUndefined()
  s.manual.last().finish()
  await flush()
  expect(s.manual.turns).toHaveLength(1)
  expect(s.actor.snapshot()).toMatchObject({ foreground: "idle", queue: [] })
})

test("an outside notice and background notices that wait together are one message, in the order they happened", async () => {
  const box = outbox(() => s)
  const s = setup({ waitingNotice: box.waitingNotice })
  await s.submit("first")
  const input = s.manual.last().input
  await ends(s, "[background task bg_1 exited 0]")
  s.h.clock.advance(10)
  box.add("[child one ended]")
  s.h.clock.advance(10)
  await ends(s, "[background task bg_2 exited 1]")
  expect(await input.takeQueued?.()).toEqual({ text: "[background task bg_1 exited 0]\n\n[child one ended]\n\n[background task bg_2 exited 1]", attachments: [] })
  expect(noticeItems(s)).toHaveLength(1)
  expect(box.log.taken).toHaveLength(1)
  expect(s.actor.snapshot().queue).toEqual([])
  expect(await input.takeQueued?.()).toBeUndefined()
})

test("a steered message of the user goes alone and first; the outside notice follows as its own message, with no authority", async () => {
  const box = outbox(() => s)
  const s = setup({ waitingNotice: box.waitingNotice })
  await s.submit("first")
  const input = s.manual.last().input
  box.add("[child one ended]")
  await s.submit("steer me", { delivery: "steer" })
  expect(await input.takeQueued?.()).toMatchObject({ text: "steer me", authority: { text: "steer me" } })
  expect(box.log.taken).toEqual([])
  const next = await input.takeQueued?.()
  expect(next).toEqual({ text: "[child one ended]", attachments: [] })
})

test("an outside notice is not asked for when the turn cannot take it: no injection boundary, a hold, a pause, a compaction", async () => {
  const fixed = outbox(() => plain)
  const plain = setup({ canSteer: false, waitingNotice: fixed.waitingNotice })
  await plain.submit("first")
  fixed.add("[child one ended]")
  expect(await plain.manual.last().input.takeQueued?.()).toBeUndefined()
  expect(fixed.log.asked).toBe(0)

  const box = outbox(() => s)
  const s = setup({ waitingNotice: box.waitingNotice })
  await s.submit("first")
  const input = s.manual.last().input
  box.add("[child one ended]")
  await s.actor.pause(true)
  expect(await input.takeQueued?.()).toBeUndefined()
  await s.actor.pause(false)
  await s.command({ type: "turn.cancel", turnId: s.actor.snapshot().turnId })
  expect(await input.takeQueued?.()).toBeUndefined()
  expect(box.log).toEqual({ asked: 0, taken: [] })
  // Left with its owner: a turn that ends without reading it changes nothing for it.
  expect(s.h.events.filter((e) => e.type === "queue.added")).toHaveLength(1)
})

test("a notice whose news the model already read is dropped unread: at the boundary, before a turn of its own, and with the user's next message", async () => {
  const s = setup()
  const shown = new Set<string>()
  const exit = (id: string) => s.actor.notify(`[background task ${id} exited 0]`, undefined, false, "steer", true, () => shown.has(id))
  await s.submit("first")
  const input = s.manual.last().input
  await exit("bg_1")
  await exit("bg_2")
  shown.add("bg_1")
  expect(await input.takeQueued?.()).toEqual({ text: "[background task bg_2 exited 0]", attachments: [] })
  expect(s.actor.snapshot().queue).toEqual([])
  // The turn ends before a boundary: the notice would get a turn of its own, but the model has read that exit meanwhile.
  await exit("bg_3")
  shown.add("bg_3")
  s.manual.last().finish()
  await flush()
  expect(s.manual.turns).toHaveLength(1)
  expect(s.actor.snapshot()).toMatchObject({ foreground: "idle", queue: [] })
  expect(lastQueue(s)).toEqual([])
  // Held after a cancel: only the exit the model has not read goes with the user's next message.
  await s.submit("second")
  await exit("bg_4")
  await exit("bg_5")
  await s.command({ type: "turn.cancel", turnId: s.actor.snapshot().turnId })
  s.manual.last().finish()
  await flush()
  shown.add("bg_4")
  await s.submit("and now")
  await flush()
  expect(s.manual.last().input.text).toBe("[while the session was stopped, this happened]\n[background task bg_5 exited 0]\n\n[the user's message]\nand now")
  expect(noticeItems(s)).toHaveLength(1)
})
