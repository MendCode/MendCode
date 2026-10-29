import { describe, expect, test } from "bun:test"
import type { ForegroundState, SessionEvent } from "@mendcode/protocol"
import { createSessionActor } from "../src/session-actor"
import { createHarness, createManualEngine, flush, turnIds, types } from "./helpers"

function setup(options: { ignoreAbort?: boolean; cancelGraceMs?: number } = {}) {
  const h = createHarness()
  const manual = createManualEngine(options)
  const sessionId = h.ids("session")
  const clientId = h.ids("client")
  const states: ForegroundState[] = []
  const actor = createSessionActor({
    sessionId,
    clock: h.clock,
    scope: h.root.child("session"),
    engine: manual.engine,
    sink: h.sink,
    ids: h.ids,
    cancelGraceMs: options.cancelGraceMs ?? 1_000,
    onForeground: (state) => states.push(state),
  })
  const submit = (text: string) =>
    actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text, attachments: [] })
  return { h, manual, actor, sessionId, clientId, states, submit }
}

function assertContiguous(events: SessionEvent[]) {
  events.forEach((event, index) => expect(event.seq).toBe(index + 1))
}

describe("SessionActor", () => {
  test("a submitted message starts a turn, streams items and returns to idle", async () => {
    const { h, manual, actor, submit } = setup()
    await submit("hola")
    await flush()
    const turn = manual.last()
    const itemId = turn.input.newItemId()
    turn.input.emit({ type: "item.started", itemId, kind: "agent_message" })
    turn.input.emit({ type: "item.delta", itemId, text: "ok" })
    turn.input.emit({ type: "item.completed", itemId, status: "ok", text: "ok" })
    turn.finish()
    await flush()
    expect(types(h.events)).toEqual([
      "queue.added",
      "queue.changed",
      "queue.changed",
      "turn.started",
      "item.started",
      "item.completed",
      "foreground.state",
      "item.started",
      "item.delta",
      "item.completed",
      "turn.completed",
      "foreground.state",
    ])
    expect(actor.snapshot().foreground).toBe("idle")
    assertContiguous(h.events)
  })

  test("the live turn may switch the permission mode (approved plan); a finished turn's late request is ignored", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    await actor.handle({ id: h.ids("command"), clientId, type: "session.permission.set", sessionId, mode: "plan" })
    await submit("plan it")
    await flush()
    const turn = manual.last()
    expect(turn.input.permissionMode()).toBe("plan")
    turn.input.setPermissionMode("ask")
    await flush()
    expect(actor.snapshot().permissionMode).toBe("ask")
    expect(h.events.filter((e) => e.type === "session.permission").at(-1)).toMatchObject({ mode: "ask" })
    turn.finish()
    await flush()
    turn.input.setPermissionMode("full")
    await flush()
    expect(actor.snapshot().permissionMode).toBe("ask")
  })

  test("R7 a caller-chosen message id survives the queue, and compaction options reach the engine", async () => {
    const { h, manual, actor, sessionId, clientId } = setup()
    const messageId = h.ids("item")
    await actor.handle({ id: h.ids("command"), clientId, type: "user.submit", sessionId, text: "first", attachments: [], messageId })
    await flush()
    expect(h.events.find((e) => e.type === "queue.added")).toMatchObject({ messageId })
    expect(h.events.find((e) => e.type === "item.started" && e.kind === "user_message")).toMatchObject({ itemId: messageId })
    manual.last().finish()
    await flush()
    await actor.handle({ id: h.ids("command"), clientId, type: "session.compact", sessionId, instructions: "keep the API names", model: { model: "echo2" } })
    expect(h.events.filter((e) => e.type === "queue.added").at(-1)).toMatchObject({ compact: true, instructions: "keep the API names", selection: { model: { model: "echo2" } } })
    await flush()
    expect(manual.last().phase).toBe("compaction")
    expect(manual.last().input).toMatchObject({ instructions: "keep the API names", selection: { model: { model: "echo2" } } })
    manual.last().finish()
    await flush()
  })

  test("/compact queues behind the running turn and then runs only the compaction phase, without a user message", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    await submit("work")
    await flush()
    const reply = await actor.handle({ id: h.ids("command"), clientId, type: "session.compact", sessionId })
    expect(reply.ok).toBe(true)
    expect(h.events.filter((e) => e.type === "queue.added").at(-1)).toMatchObject({ compact: true, text: "" })
    manual.last().finish()
    await flush()
    const compaction = manual.last()
    expect(compaction.phase).toBe("compaction")
    expect(actor.snapshot().foreground).toBe("compacting")
    compaction.finish()
    await flush()
    const lastTurn = h.events.filter((e) => e.type === "turn.started").at(-1)!
    const itemsOfLastTurn = h.events.filter((e) => e.type === "item.started" && "turnId" in e && e.turnId === (lastTurn as { turnId: string }).turnId)
    expect(itemsOfLastTurn).toHaveLength(0)
    expect(h.events.at(-2)).toMatchObject({ type: "turn.completed" })
    expect(actor.snapshot().foreground).toBe("idle")
  })

  test("a message sent during generation queues and starts exactly when the turn ends (I1, I2)", async () => {
    const { h, manual, actor, submit } = setup()
    await submit("uno")
    await submit("dos")
    await flush()
    expect(actor.snapshot().queue.length).toBe(1)
    expect(manual.turns.length).toBe(1)
    manual.last().finish()
    await flush()
    expect(manual.turns.length).toBe(2)
    expect(manual.last().input.text).toBe("dos")
    expect(turnIds(h.events).length).toBe(2)
    const started = h.events.filter((e) => e.type === "turn.started").length
    const ended = h.events.filter((e) => e.type === "turn.completed").length
    expect(started - ended).toBe(1)
  })

  test("compaction runs inside the turn and the queue advances only after it (FC-08, I5)", async () => {
    const { h, manual, actor, submit } = setup()
    await submit("uno")
    await submit("dos")
    await flush()
    manual.requestCompaction()
    manual.last().finish()
    await flush()
    expect(actor.snapshot().foreground).toBe("compacting")
    expect(manual.last().phase).toBe("compaction")
    expect(actor.snapshot().queue.length).toBe(1)
    manual.last().finish()
    await flush()
    expect(manual.last().input.text).toBe("dos")
    const userMessages = h.events.filter((e) => e.type === "item.completed" && e.text === "dos")
    expect(userMessages.length).toBe(1)
  })

  test("cancel with a stale or foreign turn id is rejected and changes nothing (FC-09, FC-10)", async () => {
    const { h, actor, sessionId, clientId, submit } = setup()
    await submit("uno")
    await flush()
    const before = h.events.length
    const result = await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId: h.ids("turn") })
    expect(result).toMatchObject({ ok: false, code: "target_mismatch" })
    expect(h.events.length).toBe(before)
    expect(actor.snapshot().foreground).toBe("generating")
  })

  test("user cancel stops the turn and holds the queue until the user acts (stop-and-hold, FC-14)", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    await submit("uno")
    await submit("dos")
    await flush()
    const turnId = actor.snapshot().turnId!
    expect(await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId })).toEqual({ ok: true })
    await flush()
    expect(h.events.some((e) => e.type === "turn.cancelled" && e.by === "user")).toBe(true)
    expect(actor.snapshot().foreground).toBe("queued")
    expect(manual.turns.length).toBe(1)
    await submit("tres")
    await flush()
    // The held message and the new one start together, in order.
    expect(manual.last().input.text).toBe("dos\n\ntres")
  })

  test("a completed item keeps bounded tool input, attachments and render spec on the way to the event log", async () => {
    const { h, manual, submit } = setup()
    await submit("uno")
    await flush()
    const turn = manual.last()
    const itemId = turn.input.newItemId()
    const attachments = [{ sha256: "a".repeat(64), bytes: 3, mime: "image/png" }]
    turn.input.emit({ type: "item.started", itemId, kind: "tool_call" })
    turn.input.emit({ type: "item.completed", itemId, status: "ok", text: "x", toolInput: "x".repeat(4001), attachments, render: { type: "badge", text: "ok" }, meta: { exitCode: 0, note: "y".repeat(300), bad: Number.NaN } })
    await flush()
    const completed = h.events.find((e) => e.type === "item.completed" && e.itemId === itemId)
    expect(completed).toMatchObject({ toolInput: "x".repeat(4000), attachments, render: { type: "badge", text: "ok" }, meta: { exitCode: 0, note: "y".repeat(200) } })
    // Non-finite numbers never reach the log (JSON would turn them into null).
    expect(completed?.type === "item.completed" && completed.meta).not.toHaveProperty("bad")
  })

  test("an engine retry is logged as turn.retrying with the time of the next attempt; the turn stays live", async () => {
    const { h, manual, submit } = setup()
    await submit("uno")
    await flush()
    const turn = manual.last()
    turn.input.emit({ type: "retrying", attempt: 2, delayMs: 4_000, message: "429 rate limited" })
    await flush()
    const retrying = h.events.find((e) => e.type === "turn.retrying")
    expect(retrying).toMatchObject({ attempt: 2, nextAt: h.clock.now() + 4_000, message: "429 rate limited" })
    expect(h.events.some((e) => e.type === "turn.completed" || e.type === "turn.failed")).toBe(false)
  })

  test("network retries carry when the outage began until output flows again", async () => {
    const { h, manual, submit } = setup()
    await submit("uno")
    await flush()
    const turn = manual.last()
    const began = h.clock.now()
    turn.input.emit({ type: "retrying", attempt: 1, delayMs: 500, message: "ECONNRESET", offline: true })
    await flush()
    h.clock.advance(30_000)
    turn.input.emit({ type: "retrying", attempt: 2, delayMs: 1_000, message: "ECONNRESET", offline: true })
    await flush()
    const offline = h.events.filter((e) => e.type === "turn.retrying")
    expect(offline.map((e) => e.type === "turn.retrying" && e.offlineSince)).toEqual([began, began])
    turn.input.emit({ type: "retrying", attempt: 3, delayMs: 2_000, message: "503" })
    turn.input.emit({ type: "item.started", itemId: h.ids("item"), kind: "agent_message" })
    await flush()
    h.clock.advance(1_000)
    turn.input.emit({ type: "retrying", attempt: 1, delayMs: 500, message: "ECONNRESET", offline: true })
    await flush()
    const later = h.events.filter((e) => e.type === "turn.retrying").slice(2)
    expect(later[0]).not.toHaveProperty("offlineSince")
    expect(later[1]).toMatchObject({ offlineSince: began + 31_000 })
  })

  test("a !command queues in order, runs through runShell as a shell turn, and a message behind it waits", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    const shell = await actor.handle({ id: h.ids("command"), clientId, type: "user.shell", sessionId, command: "git status" })
    expect(shell.ok).toBe(true)
    await submit("explain it")
    await flush()
    expect(manual.last()).toMatchObject({ phase: "shell", input: { text: "git status" } })
    expect(h.events.find((e) => e.type === "queue.added" && e.text === "git status")).toMatchObject({ shell: true })
    expect(h.events.find((e) => e.type === "item.started" && e.kind === "user_message")).toMatchObject({ meta: { shell: true } })
    expect(manual.turns).toHaveLength(1)
    manual.last().finish()
    await flush()
    expect(manual.last()).toMatchObject({ phase: "turn", input: { text: "explain it" } })
  })

  test("a !!command carries local through the queue event, the user message and the engine input; a plain !command does not", async () => {
    const { h, manual, actor, sessionId, clientId } = setup()
    expect((await actor.handle({ id: h.ids("command"), clientId, type: "user.shell", sessionId, command: "cat notes.txt", local: true })).ok).toBe(true)
    await flush()
    expect(h.events.find((e) => e.type === "queue.added" && e.text === "cat notes.txt")).toMatchObject({ shell: true, local: true })
    expect(h.events.find((e) => e.type === "item.started" && e.kind === "user_message")).toMatchObject({ meta: { shell: true, local: true } })
    expect(manual.last()).toMatchObject({ phase: "shell", input: { text: "cat notes.txt", localShell: true } })
    manual.last().finish()
    await flush()
    await actor.handle({ id: h.ids("command"), clientId, type: "user.shell", sessionId, command: "ls" })
    await flush()
    expect(h.events.find((e) => e.type === "queue.added" && e.text === "ls")).not.toHaveProperty("local")
    expect(manual.last().input).not.toHaveProperty("localShell")
  })

  test("an engine without shell mode rejects !commands and queues nothing", async () => {
    const { h, manual, actor, sessionId, clientId } = setup()
    delete manual.engine.runShell
    const reply = await actor.handle({ id: h.ids("command"), clientId, type: "user.shell", sessionId, command: "ls" })
    expect(reply).toMatchObject({ ok: false, code: "invalid_command" })
    expect(h.events.some((e) => e.type === "queue.added")).toBe(false)
  })

  test("a notice wakes an idle session as a turn marked as a notice, not a user message", async () => {
    const { h, manual, actor } = setup()
    const queueId = await actor.notify("[background task bg_1 exited 0]")
    await flush()
    expect(queueId).toBeDefined()
    expect(manual.last().input.text).toBe("[background task bg_1 exited 0]")
    expect(h.events.find((e) => e.type === "queue.added")).toMatchObject({ notice: true })
    expect(h.events.find((e) => e.type === "item.started" && e.kind === "user_message")).toMatchObject({ meta: { notice: true } })
  })

  test("a notice waits behind a running turn, then runs", async () => {
    const { manual, actor, submit } = setup()
    await submit("uno")
    await flush()
    await actor.notify("[background task bg_1 exited 0]")
    await flush()
    expect(manual.turns.length).toBe(1)
    manual.last().finish()
    await flush()
    expect(manual.last().input.text).toBe("[background task bg_1 exited 0]")
  })

  test("an idle-only child notice atomically refuses a busy or cancelled mailbox and retains its supplied id", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    const queueId = h.ids("queue")
    await submit("working")
    await flush()
    expect(await actor.notify("child finished", queueId, true)).toBeUndefined()
    await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId: actor.snapshot().turnId! })
    await flush()
    expect(await actor.notify("child finished", queueId, true)).toBeUndefined()
    expect(actor.snapshot().queue).toEqual([])
    await submit("resume")
    await flush()
    manual.last().finish()
    await flush()
    expect(await actor.notify("child finished", queueId, true)).toBe(queueId)
    await flush()
    expect(h.events.filter((event) => event.type === "queue.added" && event.notice)).toMatchObject([{ queueId }])
  })

  test("a notice arriving after a user cancel never resumes the session on its own (FC-13)", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    await submit("uno")
    await flush()
    await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId: actor.snapshot().turnId! })
    await flush()
    await actor.notify("[background task bg_1 exited 0]", undefined, false, undefined, true)
    await flush()
    expect(manual.turns.length).toBe(1)
    expect(actor.snapshot()).toMatchObject({ foreground: "queued", held: true })
    await actor.notify("[background task bg_2 exited 1]", undefined, false, undefined, true)
    await flush()
    expect(manual.turns.length).toBe(1)
    // The user's next message takes the waiting notices with it: one turn, not one per notice and then the message.
    await submit("dos")
    await flush()
    expect(manual.turns.length).toBe(2)
    const input = manual.last().input
    expect(input.text).toContain("[background task bg_1 exited 0]")
    expect(input.text).toContain("[background task bg_2 exited 1]")
    expect(input.text.endsWith("[the user's message]\ndos")).toBe(true)
    // What the user wrote is what the transcript shows and what carries authority; a notice's text is neither.
    expect(input.authority).toMatchObject({ text: "dos" })
    expect(input.authority?.synthetic).toBeUndefined()
    const shown = h.events.filter((e) => e.type === "item.completed" && "text" in e && e.text === "dos")
    expect(shown).toHaveLength(1)
    expect(actor.snapshot().queue).toEqual([])
  })

  test("a notice someone waits on (a peer's message) keeps its own turn after a cancel: it never rides", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    await submit("uno")
    await flush()
    await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId: actor.snapshot().turnId! })
    await flush()
    await actor.notify("[message from another session]")
    await submit("dos")
    await flush()
    expect(manual.last().input.text).toBe("[message from another session]")
  })

  test("Send now needs a single command: the active turn stops and the promoted message runs next (FC-03)", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup()
    await submit("uno")
    await submit("dos")
    const third = await submit("tres")
    await flush()
    const queueId = (third as { ok: true; result: { queueId: never } }).result.queueId
    await actor.handle({ id: h.ids("command"), clientId, type: "queue.promote", sessionId, queueId })
    await flush()
    expect(h.events.some((e) => e.type === "turn.cancelled" && e.by === "promotion")).toBe(true)
    expect(manual.last().input.text).toBe("tres")
    expect(actor.snapshot().queue.length).toBe(1)
  })

  test("an engine that ignores abort is force-finished after the grace period (I6)", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup({ ignoreAbort: true, cancelGraceMs: 1_000 })
    await submit("uno")
    await flush()
    await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId: actor.snapshot().turnId! })
    await flush()
    // The user sees the turn end at once; the actor still holds it until the engine stops or the grace runs out.
    expect(actor.snapshot().foreground).toBe("idle")
    expect(h.events.filter((e) => e.type === "turn.cancelled").length).toBe(1)
    expect(actor.snapshot()).toMatchObject({ stopping: true, turnId: expect.any(String) })
    await submit("dos")
    await flush()
    expect(manual.turns).toHaveLength(1)
    expect(actor.snapshot().foreground).toBe("queued")
    h.clock.advance(1_000)
    await flush()
    expect(actor.snapshot().stopping).toBe(false)
    expect(manual.turns).toHaveLength(2)
    manual.turns[0]!.finish()
    await flush()
    expect(h.events.filter((e) => e.type === "turn.cancelled").length).toBe(1)
  })

  test("late engine events after cancel are dropped and open items close as cancelled (FC-16)", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup({ ignoreAbort: true })
    await submit("uno")
    await flush()
    const turn = manual.last()
    const tool = turn.input.newItemId()
    turn.input.emit({ type: "item.started", itemId: tool, kind: "tool_call", meta: { tool: "bash" } })
    await flush()
    expect(actor.snapshot().foreground).toBe("tool")
    await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId: actor.snapshot().turnId! })
    turn.input.emit({ type: "item.delta", itemId: tool, text: "late output" })
    turn.finish()
    await flush()
    expect(h.events.some((e) => e.type === "item.delta" && e.text === "late output")).toBe(false)
    expect(h.events.some((e) => e.type === "item.completed" && e.itemId === tool && e.status === "cancelled")).toBe(true)
  })

  test("a tool approval carries its card's item, the tool and the permission to the event log", async () => {
    const { h, manual, submit } = setup()
    await submit("uno")
    await flush()
    const itemId = manual.last().input.newItemId()
    void manual.last().input.ask({ kind: "approval", title: "Run command", detail: "ls", itemId, tool: "shell", permission: "execute" })
    await flush()
    expect(h.events.find((e) => e.type === "server.request")).toMatchObject({ itemId, tool: "shell", permission: "execute" })
  })

  test("a question's options and multi-select flag reach the event log; multi without options is dropped", async () => {
    const { h, manual, submit } = setup()
    await submit("uno")
    await flush()
    void manual.last().input.ask({ kind: "question", title: "Which?", detail: "", options: [{ label: "A", description: "first" }, { label: "B" }], multiple: true })
    void manual.last().input.ask({ kind: "question", title: "Name?", detail: "", multiple: true })
    await flush()
    const [withOptions, free] = h.events.filter((e) => e.type === "server.request")
    expect(withOptions).toMatchObject({ options: [{ label: "A", description: "first" }, { label: "B" }], multiple: true })
    expect(free).not.toHaveProperty("multiple")
    expect(free).not.toHaveProperty("options")
  })

  test("the first approval answer wins; a second client gets request_already_resolved (FC-12)", async () => {
    const { h, manual, actor, sessionId, submit } = setup()
    await submit("uno")
    await flush()
    const answer = manual.last().input.ask({ kind: "approval", title: "bash rm", detail: "rm -rf build" })
    await flush()
    expect(actor.snapshot().foreground).toBe("waiting_approval")
    const request = h.events.find((e) => e.type === "server.request")
    if (request?.type !== "server.request") throw new Error("missing request")
    const decision = { kind: "approve" as const, scope: "once" as const }
    const first = await actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "request.resolve", sessionId, requestId: request.requestId, decision })
    const second = await actor.handle({ id: h.ids("command"), clientId: h.ids("client"), type: "request.resolve", sessionId, requestId: request.requestId, decision })
    expect(first).toEqual({ ok: true })
    expect(second).toMatchObject({ ok: false, code: "request_already_resolved" })
    expect(await answer).toEqual(decision)
    expect(actor.snapshot().foreground).toBe("generating")
  })

  test("a transport interruption is reported as interrupted, never as a user cancel (FC-15)", async () => {
    const { h, actor, submit } = setup()
    await submit("uno")
    await submit("dos")
    await flush()
    await actor.interrupt("transport")
    await flush()
    expect(h.events.some((e) => e.type === "turn.interrupted" && e.reason === "transport")).toBe(true)
    expect(h.events.some((e) => e.type === "turn.cancelled")).toBe(false)
    expect(actor.snapshot().foreground).toBe("queued")
  })

  test("an engine failure ends the turn and the next queued message still runs", async () => {
    const { h, manual, submit } = setup()
    await submit("uno")
    await submit("dos")
    await flush()
    manual.last().finish({ status: "error", code: "provider_500", message: "boom" })
    await flush()
    expect(h.events.some((e) => e.type === "turn.failed")).toBe(true)
    expect(manual.last().input.text).toBe("dos")
  })

  test("turn resources are released when the turn ends (P10, I11)", async () => {
    const { h, manual, actor, sessionId, clientId, submit } = setup({ ignoreAbort: true })
    const baseline = h.registry.snapshot()
    await submit("uno")
    await flush()
    await actor.handle({ id: h.ids("command"), clientId, type: "turn.cancel", sessionId, turnId: actor.snapshot().turnId! })
    await flush()
    expect(h.registry.counters.timers).toBe(1)
    manual.last().finish()
    await flush()
    expect(h.registry.snapshot()).toEqual(baseline)
    expect(h.clock.pendingTimers()).toBe(0)
  })
})
