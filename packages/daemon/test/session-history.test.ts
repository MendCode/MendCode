import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { createClient } from "@mendcode/client"
import { createNativeEngine, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import { ChangesReport, createIdFactory, READ_ONLY_COMMANDS, RewindReport, SessionExportResult, TimelineEntry, visibleEvents, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "@mendcode/store"
import { applyPatch, defineTool, edit, read, shell, write } from "@mendcode/tools"
import { startDaemon } from "../src"
import { createSessionHistory } from "../src/session-history"
import { createTurnSnapshots } from "../src/turn-snapshots"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
const callTool = (name: string, args: unknown, callId = `call-${name}-${Math.random().toString(36).slice(2, 8)}`): ModelEvent[] => [{ type: "tool_call", call: { callId, name, args } }, { type: "finish", reason: "tool_calls" }]

type Step = ModelEvent[] | (() => Promise<ModelEvent[]>)

/** A provider that plays the script in order; a step may be a function the test holds open (a turn that is still running). */
function scripted(steps: Step[]) {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted: the model must not be called here")
      yield* typeof step === "function" ? await step() : step
    },
  }
  return { provider, requests, steps }
}

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A deterministic read-only tool, so golden transcripts do not depend on a real command's output. */
const probe = defineTool({
  name: "probe",
  description: "test tool",
  permission: "read",
  args: z.object({ lines: z.number().int().optional() }),
  async execute({ lines }) {
    const output = lines ? Array.from({ length: lines }, (_, i) => `row ${i + 1}`).join("\n") : "line1\nline2"
    return { output, truncated: false, title: "probe", isError: false }
  },
})

async function boot(options: { steps?: Step[]; cancelGraceMs?: number; rewind?: (input: { sessionId: SessionId; turnId: string }) => Promise<boolean> } = {}) {
  const dir = tempDir("mendd-hist-")
  const project = tempDir("mendd-hist-proj-")
  const script = scripted(options.steps ?? [])
  let store!: Store
  const tools = [shell, write, edit, applyPatch, read, probe]
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
    engine: ({ store: s, secrets, background, extensions }) => {
      store = s
      extensions.setBuiltinTools(tools)
      const native = createNativeEngine({
        provider: script.provider,
        tools,
        secrets,
        background,
        hooks: extensions.hooks,
        history: {
          load: async (sessionId) => {
            const messages = s.engineMessages.load(sessionId, "native") as ModelMessage[]
            return messages.length ? messages : undefined
          },
          save: async (sessionId, messages) => s.engineMessages.save(sessionId, "native", messages),
          replace: async (sessionId, messages) => s.engineMessages.replace(sessionId, "native", messages),
        },
        cwdFor: (sessionId) => s.sessionDirectory(sessionId) || project,
        system: () => "BASE",
        compactionPrompt: "SUMMARIZE",
      })
      return options.rewind ? { ...native, rewind: options.rewind } : native
    },
  })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "history", onEvent: (event) => void events.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  return { dir, project, client, events, store, requests: script.requests, steps: script.steps }
}
type Harness = Awaited<ReturnType<typeof boot>>

async function open(h: Harness) {
  const created = await h.client.send({ type: "session.create", directory: h.project })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await h.client.subscribe(sessionId, 0)
  await h.client.send({ type: "session.permission.set", sessionId, mode: "full" })
  return sessionId
}

const finished = (h: Harness, sessionId: SessionId) => h.store.turns.list(sessionId).filter((turn) => turn.status !== "running").length
async function say(h: Harness, sessionId: SessionId, text: string, attachments: Array<{ sha256: string; bytes: number; mime: string; name?: string }> = []) {
  const before = finished(h, sessionId)
  const ack = await h.client.send({ type: "user.submit", sessionId, text, attachments })
  if (!ack.ok) throw new Error(`submit refused: ${JSON.stringify(ack)}`)
  await until(() => finished(h, sessionId) > before)
}

const result = <T>(ack: { ok: boolean; result?: unknown }, schema: z.ZodType<T>) => schema.parse((ack as { ok: true; result: unknown }).result)
const errorOf = (ack: { ok: boolean }) => (ack as { ok: false; error: { code: string; message: string } }).error

async function timeline(h: Harness, sessionId: SessionId) {
  const ack = await h.client.send({ type: "session.timeline", sessionId })
  return result(ack, z.object({ entries: z.array(TimelineEntry) })).entries
}

const history = (h: Harness, sessionId: SessionId) => h.store.engineMessages.load(sessionId, "native") as ModelMessage[]
const userTexts = (events: SessionEvent[]) => {
  const kinds = new Map<string, string>()
  const texts: string[] = []
  for (const event of events) {
    if (event.type === "item.started") kinds.set(event.itemId, event.kind)
    if (event.type === "item.completed" && kinds.get(event.itemId) === "user_message") texts.push(event.text ?? "")
  }
  return texts
}

const fake = (label: string, length: number) => new Bun.CryptoHasher("sha256").update(`fake:${label}`).digest("hex").repeat(Math.ceil(length / 64)).slice(0, length)
const OPENAI_KEY = "s" + "k-" + fake("history-openai", 48)

test("local panel savings query validates the session and returns persisted data without an engine call", async () => {
  const h = await boot()
  const sessionId = await open(h)
  const turnId = createIdFactory()("turn"), itemId = createIdFactory()("item")
  h.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: createIdFactory()("queue") })
  h.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "tool_call", meta: { tool: "graph_map" } })
  h.store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", meta: { savedTokens: 1500, filter: "graft" } })
  h.store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
  expect(await h.client.send({ type: "session.savings", sessionId })).toMatchObject({ ok: true, result: { savings: [{ source: "graft", calls: 1, tokens: 1500 }] } })
  expect(await h.client.send({ type: "session.savings", sessionId: createIdFactory()("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  expect(READ_ONLY_COMMANDS).not.toContain("session.savings")
  expect(READ_ONLY_COMMANDS).not.toContain("session.changes")
  expect(h.requests).toHaveLength(0)
})

describe("session.fork at a message", () => {
  test("the new session holds the transcript and model history up to that message, secrets and blobs come along, the model continues from there", async () => {
    const h = await boot({ steps: [stop("answer one"), stop("answer two"), stop("answer three"), stop("after fork")] })
    const source = await open(h)
    await say(h, source, "first question")
    await say(h, source, `second question with ${OPENAI_KEY}`)
    await say(h, source, "third question")
    const blob = h.store.putBlob(new TextEncoder().encode("attached"), "text/plain")
    h.store.refBlob(blob, source)
    const entries = await timeline(h, source)
    expect(entries.map((entry) => entry.preview)).toEqual(["first question", "second question with ‹secret:1›", "third question"])

    const fork = await h.client.send({ type: "session.fork", sessionId: source, atItemId: entries[1]!.itemId })
    const forked = result(fork, z.object({ sessionId: z.string(), copied: z.number(), events: z.number() }))
    const forkId = forked.sessionId as SessionId
    expect(forked.copied).toBe(4)
    expect(history(h, forkId)).toEqual(history(h, source).slice(0, 4))
    expect(history(h, source)).toHaveLength(6)

    const events = h.store.readAfter(forkId, 0, 10_000)
    expect(events[0]).toMatchObject({ type: "session.created", seq: 1 })
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1))
    expect(events.every((event) => event.sessionId === forkId)).toBe(true)
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(2)
    // Everything but the session's own creation and its permission mode came from the source.
    expect(forked.events).toBe(events.length - 2)
    expect(events.at(-1)).toMatchObject({ type: "session.permission", mode: "full" })
    expect(userTexts(events)).toEqual(["first question", "second question with ‹secret:1›"])
    expect(JSON.stringify(events)).not.toContain("third")
    expect(JSON.stringify(events)).not.toContain(OPENAI_KEY)
    expect((await timeline(h, forkId)).map((entry) => entry.preview)).toEqual(["first question", "second question with ‹secret:1›"])

    // The secret marker still resolves in the fork, and the blob outlives the source session.
    expect(h.store.secrets.list(forkId)).toHaveLength(1)
    h.store.deleteSession(source)
    h.store.collectBlobs()
    expect(existsSync(h.store.blobPath(blob.sha256))).toBe(true)

    // The model continues from that point: it never sees the third turn.
    await h.client.subscribe(forkId, events.length)
    await say(h, forkId, "continue")
    const seen = JSON.stringify(h.requests.at(-1)!.messages)
    expect(seen).toContain("second question")
    expect(seen).toContain("answer two")
    expect(seen).not.toContain("third question")
    expect(seen).not.toContain("answer three")
    expect(h.requests.at(-1)!.messages.filter((message) => message.role === "user")).toHaveLength(3)
  })

  test("an undo in a Claude Code session also cuts Claude Code's conversation before the undone message, and says the model forgot it", async () => {
    const rewinds: Array<{ sessionId: SessionId; turnId: string }> = []
    const h = await boot({ steps: [stop("one"), stop("two")], rewind: async (input) => (rewinds.push(input), true) })
    const source = await open(h)
    await say(h, source, "keep")
    await say(h, source, "su dale")
    h.store.engineBindings.set(source, "claude", "cc-1")
    const [, typo] = await timeline(h, source)
    const undone = await h.client.send({ type: "session.undo", sessionId: source, atItemId: typo!.itemId })
    expect(undone).toMatchObject({ ok: true, result: { history: { tracked: true }, prompt: { text: "su dale" } } })
    expect(JSON.stringify(undone)).not.toContain("still remembers")
    expect(rewinds).toEqual([{ sessionId: source, turnId: h.store.turns.byItem(source, typo!.itemId)!.turnId }])
  })

  test("a fork of an undone or unknown message, or of something that is not a user message, is refused and creates nothing", async () => {
    const h = await boot({ steps: [stop("one"), stop("two")] })
    const source = await open(h)
    await say(h, source, "keep")
    await say(h, source, "drop")
    const [, dropped] = await timeline(h, source)
    await h.client.send({ type: "session.undo", sessionId: source })
    const agentItem = h.events.find((event): event is Extract<SessionEvent, { type: "item.started" }> => event.type === "item.started" && event.kind === "agent_message")!
    const before = h.store.listSessions({}).length
    const undone = await h.client.send({ type: "session.fork", sessionId: source, atItemId: dropped!.itemId })
    expect(undone).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    const notUser = await h.client.send({ type: "session.fork", sessionId: source, atItemId: agentItem.itemId })
    expect(notUser).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    const unknown = await h.client.send({ type: "session.fork", sessionId: source, atItemId: createIdFactory()("item") })
    expect(unknown).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(h.store.listSessions({})).toHaveLength(before)
  })

  test("a fork at the last message keeps the whole history, skips undone turns, and can itself be undone", async () => {
    const h = await boot({ steps: [stop("one"), stop("two"), stop("three")] })
    const source = await open(h)
    await say(h, source, "first")
    await say(h, source, "second")
    await h.client.send({ type: "session.undo", sessionId: source })
    await say(h, source, "third")
    const entries = await timeline(h, source)
    expect(entries.map((entry) => [entry.preview, entry.reverted])).toEqual([["first", false], ["second", true], ["third", false]])
    const fork = result(await h.client.send({ type: "session.fork", sessionId: source, atItemId: entries[2]!.itemId }), z.object({ sessionId: z.string(), copied: z.number() }))
    const forkId = fork.sessionId as SessionId
    expect(fork.copied).toBe(4)
    expect(userTexts(h.store.readAfter(forkId, 0, 10_000))).toEqual(["first", "third"])
    // The copied turns carry their history marks: the fork's last message can be undone like in the source.
    const undone = await h.client.send({ type: "session.undo", sessionId: forkId })
    expect(result(undone, RewindReport).history.messages).toBe(2)
    expect(history(h, forkId)).toHaveLength(2)
  })

  test("a plain fork still copies only the history and starts an empty transcript", async () => {
    const h = await boot({ steps: [stop("one")] })
    const source = await open(h)
    await say(h, source, "hello")
    const fork = result(await h.client.send({ type: "session.fork", sessionId: source }), z.object({ sessionId: z.string(), copied: z.number() }))
    expect(fork.copied).toBe(2)
    expect(h.store.readAfter(fork.sessionId as SessionId, 0, 100).map((event) => event.type)).toEqual(["session.created", "session.permission"])
  })
})

test("B56 client exports native tool input and targeted undo traverses the daemon protocol", async () => {
  const h = await boot({ steps: [callTool("probe", { lines: 2 }), stop("First answer"), stop("Second answer")] })
  const sessionId = await open(h)
  await say(h, sessionId, "First prompt")
  await say(h, sessionId, "Second prompt")
  const exported = await h.client.exportSession(sessionId, { format: "json", toolDetails: true, timestamps: true })
  if (!exported.ok) throw new Error(exported.error.message)
  const turns = JSON.parse(exported.export.text).turns
  const tool = turns[0].items.find((item: { kind: string }) => item.kind === "tool_call")
  expect(JSON.parse(tool.input)).toEqual({ lines: 2 })
  expect(tool.text).toContain("row 1")
  expect(tool.at).toBeNumber()
  const entries = await timeline(h, sessionId)
  const undone = result(await h.client.send({ type: "session.undo", sessionId, atItemId: entries[0]!.itemId }), RewindReport)
  expect(undone.turnIds).toHaveLength(2)
  expect(undone.itemId).toBe(entries[0]!.itemId)
  const empty = await h.client.exportSession(sessionId)
  if (!empty.ok) throw new Error(empty.error.message)
  expect(empty.export.text).not.toContain("First answer")
})

describe("session.undo and session.redo", () => {
  test("undo hides the last turn from the transcript and the model history, redo brings it back, a new turn ends redo", async () => {
    const h = await boot({ steps: [stop("answer one"), stop("answer two"), stop("answer three")] })
    const sessionId = await open(h)
    await say(h, sessionId, "first")
    await say(h, sessionId, "second")
    const undone = result(await h.client.send({ type: "session.undo", sessionId }), RewindReport)
    expect(undone).toMatchObject({ history: { messages: 2, tracked: true }, shellUntracked: false, files: { restored: [], removed: [], skipped: [] } })
    expect(undone.turnIds).toHaveLength(1)
    await until(() => h.events.some((event) => event.type === "turn.reverted"))
    expect(h.events.find((event) => event.type === "turn.reverted")).toMatchObject({ turnId: undone.turnIds[0] })
    // Append-only: the events are all still there, a reader hides them.
    expect(userTexts(h.store.readAfter(sessionId, 0, 10_000))).toEqual(["first", "second"])
    expect(userTexts(visibleEvents(h.store.readAfter(sessionId, 0, 10_000)))).toEqual(["first"])
    expect(history(h, sessionId).map((message) => message.role)).toEqual(["user", "assistant"])
    expect((await timeline(h, sessionId)).map((entry) => entry.reverted)).toEqual([false, true])

    const redone = result(await h.client.send({ type: "session.redo", sessionId }), RewindReport)
    expect(redone).toMatchObject({ turnIds: undone.turnIds, history: { messages: 2 } })
    expect(history(h, sessionId)).toHaveLength(4)
    expect(userTexts(visibleEvents(h.store.readAfter(sessionId, 0, 10_000)))).toEqual(["first", "second"])
    expect((await timeline(h, sessionId)).map((entry) => entry.reverted)).toEqual([false, false])

    // Undo, then something new happens: the model continues without the undone turn and redo is gone.
    await h.client.send({ type: "session.undo", sessionId })
    await say(h, sessionId, "third")
    const sent = h.requests.at(-1)!.messages.map((message) => (message.role === "user" ? message.content : message.role))
    expect(sent).toEqual(["first", "assistant", "third"])
    expect(await h.client.send({ type: "session.redo", sessionId })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(visibleEvents(h.store.readAfter(sessionId, 0, 10_000)).filter((event) => event.type === "turn.started")).toHaveLength(2)
  })

  test("repeated undo walks back one message at a time until nothing is left", async () => {
    const h = await boot({ steps: [stop("one"), stop("two")] })
    const sessionId = await open(h)
    await say(h, sessionId, "first")
    await say(h, sessionId, "second")
    expect(result(await h.client.send({ type: "session.undo", sessionId }), RewindReport).history.messages).toBe(2)
    expect(result(await h.client.send({ type: "session.undo", sessionId }), RewindReport).history.messages).toBe(2)
    expect(history(h, sessionId)).toHaveLength(0)
    expect(await h.client.send({ type: "session.undo", sessionId })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    // Redo re-applies them in the reverse order.
    expect(result(await h.client.send({ type: "session.redo", sessionId }), RewindReport).history.messages).toBe(2)
    expect(history(h, sessionId).map((message) => (message.role === "user" ? message.content : message.role))).toEqual(["first", "assistant"])
  })

  test("undo restores edited, created and deleted files; redo re-applies them", async () => {
    const h = await boot({
      steps: [
        callTool("write", { path: "a.txt", content: "two" }),
        callTool("write", { path: "sub/b.txt", content: "new" }),
        callTool("edit", { path: "a.txt", oldString: "two", newString: "three" }),
        callTool("apply_patch", { patch: "*** Begin Patch\n*** Delete File: c.txt\n*** Add File: d.txt\n+patched\n*** End Patch" }),
        stop("done"),
      ],
    })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "a.txt"), "one")
    writeFileSync(path.join(h.project, "c.txt"), "keep")
    await say(h, sessionId, "change things")
    const file = (name: string) => path.join(h.project, name)
    expect(readFileSync(file("a.txt"), "utf8")).toBe("three")
    expect(existsSync(file("c.txt"))).toBe(false)

    const undone = result(await h.client.send({ type: "session.undo", sessionId }), RewindReport)
    expect(readFileSync(file("a.txt"), "utf8")).toBe("one")
    expect(readFileSync(file("c.txt"), "utf8")).toBe("keep")
    expect(existsSync(file("sub/b.txt"))).toBe(false)
    expect(existsSync(file("d.txt"))).toBe(false)
    expect([...undone.files.restored].sort()).toEqual(["a.txt", "c.txt"])
    expect([...undone.files.removed].sort()).toEqual([path.join("sub", "b.txt"), "d.txt"].sort())
    expect(undone.shellUntracked).toBe(false)

    const redone = result(await h.client.send({ type: "session.redo", sessionId }), RewindReport)
    expect(readFileSync(file("a.txt"), "utf8")).toBe("three")
    expect(readFileSync(file("sub/b.txt"), "utf8")).toBe("new")
    expect(readFileSync(file("d.txt"), "utf8")).toBe("patched\n")
    expect(existsSync(file("c.txt"))).toBe(false)
    expect([...redone.files.restored].sort()).toEqual(["a.txt", path.join("sub", "b.txt"), "d.txt"].sort())
    expect(redone.files.removed).toEqual(["c.txt"])
  })

  test("undo of a turn keeps the state before its first change even when it wrote a file twice", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "x" }), callTool("write", { path: "a.txt", content: "y" }), stop("done")] })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "a.txt"), "original")
    await say(h, sessionId, "twice")
    await h.client.send({ type: "session.undo", sessionId })
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("original")
  })

  test("undo is refused while a turn runs, and works once it ends", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = await boot({ steps: [stop("one"), async () => (await gate, stop("two"))] })
    const sessionId = await open(h)
    await say(h, sessionId, "first")
    await h.client.send({ type: "user.submit", sessionId, text: "second", attachments: [] })
    await until(() => h.store.turns.list(sessionId).at(-1)?.status === "running" && h.requests.length === 2)
    expect(await h.client.send({ type: "session.undo", sessionId })).toMatchObject({ ok: false, error: { code: "busy" } })
    expect(await h.client.send({ type: "session.redo", sessionId })).toMatchObject({ ok: false, error: { code: "busy" } })
    expect(history(h, sessionId)).toHaveLength(3)
    release()
    await until(() => finished(h, sessionId) === 2)
    const undone = await h.client.send({ type: "session.undo", sessionId })
    expect(undone.ok).toBe(true)
    expect(history(h, sessionId)).toHaveLength(2)
  })

  test("changes a shell command made are reported as untracked and left alone", async () => {
    const h = await boot({ steps: [callTool("shell", { command: "printf data > shelled.txt" }), callTool("write", { path: "tracked.txt", content: "t" }), stop("done")] })
    const sessionId = await open(h)
    await say(h, sessionId, "run it")
    const undone = result(await h.client.send({ type: "session.undo", sessionId }), RewindReport)
    expect(undone.shellUntracked).toBe(true)
    expect(undone.notes.join(" ")).toContain("shell commands are not tracked")
    expect(undone.files.removed).toEqual(["tracked.txt"])
    expect(readFileSync(path.join(h.project, "shelled.txt"), "utf8")).toBe("data")
    expect(existsSync(path.join(h.project, "tracked.txt"))).toBe(false)
  })

  test("a file changed after the turn is not overwritten unless forced", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "from the agent" }), callTool("write", { path: "b.txt", content: "agent b" }), stop("done")] })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "a.txt"), "original")
    await say(h, sessionId, "go")
    writeFileSync(path.join(h.project, "a.txt"), "edited by hand afterwards")
    const refused = await h.client.send({ type: "session.undo", sessionId })
    expect(refused).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(errorOf(refused).message).toContain("a.txt")
    expect(errorOf(refused).message).not.toContain("b.txt")
    // Nothing moved: not the files, not the history, not the transcript.
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("edited by hand afterwards")
    expect(readFileSync(path.join(h.project, "b.txt"), "utf8")).toBe("agent b")
    expect(history(h, sessionId)).toHaveLength(6)
    expect(h.store.turns.list(sessionId).some((turn) => turn.reverted)).toBe(false)

    await h.client.send({ type: "session.undo", sessionId, force: true })
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("original")
    expect(existsSync(path.join(h.project, "b.txt"))).toBe(false)
  })

  test("binary and over-budget files are skipped, reported, and left as they are", async () => {
    const h = await boot({ steps: [callTool("write", { path: "image.bin", content: "text now" }), callTool("write", { path: "big.txt", content: "small now" }), callTool("write", { path: "ok.txt", content: "changed" }), stop("done")] })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    writeFileSync(path.join(h.project, "big.txt"), "x".repeat(3 * 1024 * 1024))
    writeFileSync(path.join(h.project, "ok.txt"), "before")
    await say(h, sessionId, "overwrite")
    const undone = result(await h.client.send({ type: "session.undo", sessionId }), RewindReport)
    expect(undone.files.skipped.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "big.txt", reason: "too_large" },
      { path: "image.bin", reason: "binary" },
    ])
    expect(undone.files.restored).toEqual(["ok.txt"])
    expect(readFileSync(path.join(h.project, "ok.txt"), "utf8")).toBe("before")
    expect(readFileSync(path.join(h.project, "big.txt"), "utf8")).toBe("small now")
    expect(readFileSync(path.join(h.project, "image.bin"), "utf8")).toBe("text now")
    expect(undone.notes.join(" ")).toContain("2 files could not be restored")
  })

  test("a compaction after a message makes it un-undoable, and later messages can be undone again", async () => {
    const h = await boot({ steps: [stop("one"), stop("two")] })
    const sessionId = await open(h)
    await say(h, sessionId, "before compaction")
    h.store.engineMessages.replace(sessionId, "native", [{ role: "user", content: "Summary of the conversation so far" }])
    expect(await h.client.send({ type: "session.undo", sessionId })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(history(h, sessionId)).toHaveLength(1)
    await say(h, sessionId, "after compaction")
    const undone = result(await h.client.send({ type: "session.undo", sessionId }), RewindReport)
    expect(undone.history.messages).toBe(2)
    expect(history(h, sessionId)).toEqual([{ role: "user", content: "Summary of the conversation so far" }])
  })

  test("unknown sessions are refused", async () => {
    const h = await boot()
    const ghost = "ses_01M3K99AR430RP1AGHZQN64R74" as SessionId
    for (const type of ["session.undo", "session.redo", "session.timeline"] as const) expect(await h.client.send({ type, sessionId: ghost })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
    expect(await h.client.send({ type: "session.export", sessionId: ghost, format: "json" })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })
})

describe("session.timeline", () => {
  test("lists the user messages with a 120 character preview, oldest first, and marks undone ones", async () => {
    const h = await boot({ steps: [stop("a"), stop("b")] })
    const sessionId = await open(h)
    const long = `${"word ".repeat(60)}end`
    await say(h, sessionId, "short\nmessage   with   spaces")
    await say(h, sessionId, long)
    await h.client.send({ type: "session.undo", sessionId })
    const entries = await timeline(h, sessionId)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ preview: "short message with spaces", reverted: false })
    expect(entries[1]!.preview).toHaveLength(120)
    expect(entries[1]).toMatchObject({ preview: long.replace(/\s+/g, " ").slice(0, 120), reverted: true })
    const started = h.events.filter((event) => event.type === "turn.started")
    expect(entries.map((entry) => entry.turnId)).toEqual(started.map((event) => (event as { turnId: string }).turnId as never))
    expect(entries[0]!.at).toBe(started[0]!.at)
  })
})

describe("session.export", () => {
  test("markdown: a bounded, readable transcript without undone turns, with attachments by name, tool output cut and secrets as markers", async () => {
    const h = await boot({ steps: [callTool("probe", {}), stop("Two lines came back."), callTool("probe", { lines: 400 }), stop("Long output."), stop("never shown")] })
    const sessionId = await open(h)
    await say(h, sessionId, "list things", [{ sha256: "a".repeat(64), bytes: 10, mime: "text/plain", name: "notes.txt" }, { sha256: "b".repeat(64), bytes: 20, mime: "image/png", name: "shot.png" }])
    await say(h, sessionId, `now the long one, key ${OPENAI_KEY}`)
    await say(h, sessionId, "this one is undone")
    await h.client.send({ type: "session.undo", sessionId })
    const exported = result(await h.client.send({ type: "session.export", sessionId, format: "markdown" }), SessionExportResult)
    expect(exported).toMatchObject({ format: "markdown", turns: 2, truncated: true })
    const rows = Array.from({ length: 120 }, (_, i) => `row ${i + 1}`).join("\n")
    expect(exported.text).toBe(
      [
        "# list things",
        `\`${h.project}\``,
        "## User\n\nlist things\n\nAttachments: notes.txt, shot.png",
        "**Tool:** `probe`\n\n```\nline1\nline2\n```",
        "## Assistant\n\nTwo lines came back.",
        "## User\n\nnow the long one, key ‹secret:1›",
        `**Tool:** \`probe\`\n\n\`\`\`\n${rows}\n… 280 more lines\n\`\`\``,
        "## Assistant\n\nLong output.",
        "> Export truncated: content exceeds transcript/frame limits.",
      ].join("\n\n") + "\n",
    )
    expect(exported.text).not.toContain(OPENAI_KEY)
    expect(exported.text).not.toContain("undone")
  })

  test("json: the session as data with the same bounds", async () => {
    const h = await boot({ steps: [callTool("shell", { command: "exit 3" }), stop("It failed.")] })
    const sessionId = await open(h)
    await say(h, sessionId, `use the key ${OPENAI_KEY}`, [{ sha256: "c".repeat(64), bytes: 5, mime: "text/plain", name: "a.txt" }])
    const exported = result(await h.client.send({ type: "session.export", sessionId, format: "json" }), SessionExportResult)
    expect(exported).toMatchObject({ format: "json", turns: 1, truncated: false })
    const data = JSON.parse(exported.text) as { format: string; sessionId: string; title: string; directory: string; exportedAt: number; truncated: boolean; turns: Array<{ turnId: string; at: number; outcome: string; items: Array<Record<string, unknown>> }> }
    expect(data).toMatchObject({ format: "mendcode-session@1", sessionId, directory: h.project, truncated: false })
    expect(typeof data.exportedAt).toBe("number")
    expect(data.turns).toHaveLength(1)
    const [turn] = data.turns
    expect(turn).toMatchObject({ outcome: "completed" })
    expect(turn!.items.map((item) => item.kind)).toEqual(["user_message", "tool_call", "agent_message"])
    expect(turn!.items[0]).toMatchObject({ text: "use the key ‹secret:1›", status: "ok", attachments: [{ name: "a.txt", mime: "text/plain", bytes: 5 }] })
    expect(turn!.items[1]).toMatchObject({ tool: "shell: exit 3", status: "error" })
    expect(turn!.items[2]).toMatchObject({ text: "It failed." })
    expect(exported.text).not.toContain(OPENAI_KEY)
  })

  test("an export larger than the ack frame drops the end of the session and says so", async () => {
    const huge = "word ".repeat(7_000)
    const h = await boot({ steps: Array.from({ length: 12 }, (_, i) => stop(`answer ${i}`)) })
    const sessionId = await open(h)
    for (let i = 0; i < 12; i++) await say(h, sessionId, `${i}: ${huge}`)
    for (const format of ["markdown", "json"] as const) {
      const exported = result(await h.client.send({ type: "session.export", sessionId, format }), SessionExportResult)
      expect(exported.truncated).toBe(true)
      expect(exported.turns).toBeGreaterThan(0)
      expect(exported.turns).toBeLessThan(12)
      if (format === "json") expect(JSON.parse(exported.text).truncated).toBe(true)
      else expect(exported.text).toContain("Export truncated")
    }
  })
})

describe("sessions recorded before history marks existed", () => {
  test("marks are worked out from the stored history when the counts agree, so an old session can be forked at a message", async () => {
    const dir = tempDir("mendd-legacy-")
    const store = openStore({ dir })
    const ids = createIdFactory()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "old" })
    const turns = ["first", "second", "third"].map((text) => ({ turnId: ids("turn"), itemId: ids("item"), text }))
    for (const turn of turns) {
      store.sessionSink.append({ type: "turn.started", sessionId, turnId: turn.turnId, queueId: ids("queue") })
      store.sessionSink.append({ type: "item.started", sessionId, turnId: turn.turnId, itemId: turn.itemId, kind: "user_message" })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId: turn.itemId, status: "ok", text: turn.text })
      store.engineMessages.save(sessionId, "native", [
        ...store.engineMessages.load(sessionId, "native"),
        { role: "user", content: turn.text },
        { role: "assistant", content: `re: ${turn.text}`, toolCalls: [] },
        // A tool's image note is a user message that starts no turn.
        ...(turn.text === "second" ? [{ role: "user", content: "[image from screenshot call]" }] : []),
      ])
      store.sessionSink.append({ type: "turn.completed", sessionId, turnId: turn.turnId })
    }
    store.close()
    // Drop what a build without marks never wrote: the marks themselves.
    const { Database } = await import("bun:sqlite")
    const raw = new Database(path.join(dir, "mendd.db"))
    raw.run("UPDATE turns SET history = NULL")
    raw.close()

    const reopened = openStore({ dir })
    cleanups.push(() => reopened.close())
    const history = createSessionHistory({ store: reopened, snapshots: createTurnSnapshots({ store: reopened }), publish: () => {}, isBusy: () => false, now: Date.now })
    const point = history.forkPoint({ sessionId, itemId: turns[1]!.itemId })
    expect(point).toEqual({ ok: true, result: { turnId: turns[1]!.turnId, cuts: { native: 5 } } })
    const undone = history.undo({ sessionId })
    expect(undone).toMatchObject({ ok: true, result: { history: { messages: 2 } } })
  })

  test("an assistant message without a recorded boundary is cut at its own model message when the turn's answers pair up one to one", async () => {
    const dir = tempDir("mendd-legacy-")
    const store = openStore({ dir })
    const ids = createIdFactory()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "old" })
    const turnId = ids("turn")
    const user = ids("item")
    const answers = [ids("item"), ids("item")]
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId: user, kind: "user_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId: user, status: "ok", text: "go" })
    for (const [index, itemId] of answers.entries()) {
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "agent_message" })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: `step ${index}` })
    }
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    const history = [
      { role: "user", content: "go" },
      { role: "assistant", content: "step 0", toolCalls: [{ callId: "c", name: "read", args: {} }] },
      { role: "tool", callId: "c", name: "read", output: "x", isError: false },
      { role: "assistant", content: "step 1", toolCalls: [] },
    ]
    store.engineMessages.save(sessionId, "native", history)
    const jumbled = ids("session")
    store.createSession({ id: jumbled, directory: "/repo", title: "odd" })
    const oddTurn = ids("turn")
    const oddItem = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId: jumbled, turnId: oddTurn, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId: jumbled, turnId: oddTurn, itemId: ids("item"), kind: "user_message" })
    store.sessionSink.append({ type: "item.started", sessionId: jumbled, turnId: oddTurn, itemId: oddItem, kind: "agent_message" })
    store.sessionSink.append({ type: "turn.completed", sessionId: jumbled, turnId: oddTurn })
    // One answer item but no assistant text in the history: nothing to pair.
    store.engineMessages.save(jumbled, "native", [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [] }])
    const sink = createSessionHistory({ store, snapshots: createTurnSnapshots({ store }), publish: () => {}, isBusy: () => false, now: Date.now })
    cleanups.push(() => store.close())
    expect(sink.forkBefore({ sessionId, itemId: answers[1]! })).toMatchObject({ ok: true, result: { cuts: { native: 3 } } })
    expect(sink.forkBefore({ sessionId, itemId: answers[0]! })).toMatchObject({ ok: true, result: { cuts: { native: 1 } } })
    expect(sink.forkBefore({ sessionId: jumbled, itemId: oddItem })).toMatchObject({ ok: false, code: "target_mismatch" })
  })

  test("when the history cannot be matched to the turns nothing is guessed", async () => {
    const dir = tempDir("mendd-legacy-")
    const store = openStore({ dir })
    const ids = createIdFactory()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "odd" })
    const turnId = ids("turn")
    const itemId = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
    store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
    // Two prompts in the history for one turn.
    store.engineMessages.save(sessionId, "native", [{ role: "user", content: "a" }, { role: "user", content: "b" }])
    store.close()
    const { Database } = await import("bun:sqlite")
    const raw = new Database(path.join(dir, "mendd.db"))
    raw.run("UPDATE turns SET history = NULL")
    raw.close()
    const reopened = openStore({ dir })
    cleanups.push(() => reopened.close())
    const history = createSessionHistory({ store: reopened, snapshots: createTurnSnapshots({ store: reopened }), publish: () => {}, isBusy: () => false, now: Date.now })
    expect(history.undo({ sessionId })).toMatchObject({ ok: false, code: "target_mismatch" })
    expect(history.forkPoint({ sessionId, itemId })).toMatchObject({ ok: true })
    expect(reopened.engineMessages.load(sessionId, "native")).toHaveLength(2)
  })
})

describe("system notices", () => {
  test("a notice the agent answered after a message is undone and redone with it, and is not a message to jump to", () => {
    const store = openStore({ dir: tempDir("mendd-notice-") })
    cleanups.push(() => store.close())
    const ids = createIdFactory()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const turn = (text: string, meta?: Record<string, boolean>) => {
      const turnId = ids("turn")
      const itemId = ids("item")
      store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message", ...(meta ? { meta } : {}) })
      store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text })
      store.engineMessages.save(sessionId, "native", [...store.engineMessages.load(sessionId, "native"), { role: "user", content: text }, { role: "assistant", content: "ok", toolCalls: [] }])
      store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
      return turnId
    }
    turn("earlier")
    const message = turn("do the work")
    const notice = turn("background task finished", { notice: true })
    const published: SessionEvent[] = []
    const history = createSessionHistory({ store, snapshots: createTurnSnapshots({ store }), publish: (event) => void published.push(event), isBusy: () => false, now: Date.now })
    expect(history.timeline(sessionId)).toMatchObject({ ok: true, result: { entries: [{ preview: "earlier" }, { preview: "do the work" }] } })

    const undone = history.undo({ sessionId })
    expect(undone).toMatchObject({ ok: true, result: { turnIds: [message, notice], history: { messages: 4 } } })
    expect(published.map((event) => event.type)).toEqual(["turn.reverted", "turn.reverted"])
    expect(store.engineMessages.load(sessionId, "native")).toHaveLength(2)

    const redone = history.redo({ sessionId })
    expect(redone).toMatchObject({ ok: true, result: { turnIds: [message, notice], history: { messages: 4 } } })
    expect(published.map((event) => event.type)).toEqual(["turn.reverted", "turn.reverted", "turn.restored", "turn.restored"])
    expect(store.engineMessages.load(sessionId, "native")).toHaveLength(6)
  })

  test("nothing is undone while the session has a turn that has not ended", () => {
    const store = openStore({ dir: tempDir("mendd-running-") })
    cleanups.push(() => store.close())
    const ids = createIdFactory()
    const sessionId = ids("session")
    store.createSession({ id: sessionId, directory: "/repo", title: "t" })
    const turnId = ids("turn")
    const itemId = ids("item")
    store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
    store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
    store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: "still going" })
    const history = createSessionHistory({ store, snapshots: createTurnSnapshots({ store }), publish: () => {}, isBusy: () => false, now: Date.now })
    expect(history.undo({ sessionId })).toMatchObject({ ok: false, code: "busy" })
    expect(history.forkPoint({ sessionId, itemId })).toMatchObject({ ok: false, code: "busy" })
  })
})

describe("protocol", () => {
  test("the new commands and events are part of the wire schemas", async () => {
    const { Command, SessionEvent } = await import("@mendcode/protocol")
    const ids = createIdFactory()
    const base = { id: ids("command"), clientId: ids("client") }
    const sessionId = ids("session")
    for (const body of [
      { type: "session.undo", sessionId },
      { type: "session.undo", sessionId, force: true },
      { type: "session.redo", sessionId },
      { type: "session.timeline", sessionId },
      { type: "session.export", sessionId, format: "markdown" },
      { type: "session.fork", sessionId, atItemId: ids("item") },
      { type: "session.changes", sessionId, atItemId: ids("item") },
    ])
      expect(Command.safeParse({ ...base, ...body }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "session.export", sessionId, format: "pdf" }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "session.fork", sessionId, atItemId: "nope" }).success).toBe(false)
    expect(SessionEvent.safeParse({ type: "turn.reverted", sessionId, seq: 3, at: 1, turnId: ids("turn") }).success).toBe(true)
    expect(SessionEvent.safeParse({ type: "turn.restored", sessionId, seq: 4, at: 1, turnId: ids("turn") }).success).toBe(true)
  })
})

describe("B55 worktree snapshots", () => {
  const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  async function worktree(steps: Step[]) {
    const h = await boot({ steps })
    git(h.project, ["init", "-q"])
    writeFileSync(path.join(h.project, ".gitignore"), "ignored.txt\n")
    writeFileSync(path.join(h.project, "tracked.txt"), "original\n")
    git(h.project, ["add", "."])
    git(h.project, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"])
    await h.client.send({ type: "settings.set", patch: { snapshotScope: "worktree" } })
    return h
  }

  test("v1 terminal undo cancels its active turn and waits before rewinding; plain protocol undo remains busy", async () => {
    let release!: (events: ModelEvent[]) => void
    const h = await boot({ steps: [() => new Promise((resolve) => { release = resolve })], cancelGraceMs: 50 })
    const sessionId = await open(h)
    await h.client.send({ type: "user.submit", sessionId, text: "active prompt", attachments: [] })
    await until(() => h.requests.length === 1)
    expect(await h.client.send({ type: "session.undo", sessionId })).toMatchObject({ ok: false, error: { code: "busy" } })
    const undone = result(await h.client.send({ type: "session.undo", sessionId, cancelRunning: true }), RewindReport)
    expect(undone.prompt?.text).toBe("active prompt")
    expect(h.store.turns.list(sessionId).at(-1)).toMatchObject({ status: "cancelled", reverted: true })
    expect(h.events.some((event) => event.type === "turn.cancelled")).toBe(true)
    release(stop("late answer"))
  })

  test("captures dirty, added/deleted, binary and shell-made files without changing Git state; conflicts refuse atomically", async () => {
    const h = await worktree([callTool("shell", { command: "printf changed > tracked.txt; printf new > new.txt; rm deleted.txt; printf ignored > ignored.txt; printf '\\000new' > binary.bin" }), callTool("write", { path: "ignored.txt", content: "ignored tool" }), stop("done")])
    const sessionId = await open(h)
    const file = (name: string) => path.join(h.project, name)
    writeFileSync(file("tracked.txt"), "dirty before turn\n")
    writeFileSync(file("deleted.txt"), "deleted original\n")
    writeFileSync(file("binary.bin"), Buffer.from([0, 1, 2]))
    const index = readFileSync(file(".git/index"))
    const head = git(h.project, ["rev-parse", "HEAD"])
    const attachment = { ...h.store.putBlob(new Uint8Array([1, 2, 3]), "image/png"), name: "shot.png" }
    h.store.refBlob(attachment, sessionId)
    await say(h, sessionId, "run shell", [attachment])
    writeFileSync(file("tracked.txt"), "later hand edit\n")
    expect(await h.client.send({ type: "session.undo", sessionId })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(existsSync(file("new.txt"))).toBe(true)
    expect(existsSync(file("deleted.txt"))).toBe(false)
    const undone = result(await h.client.send({ type: "session.undo", sessionId, force: true }), RewindReport)
    expect(undone.worktreeTracked).toBe(true)
    expect(undone.shellUntracked).toBe(true)
    expect(undone.notes.join(" ")).toContain("external services are not rewound")
    expect(undone.prompt?.text).toBe("run shell")
    expect(undone.prompt?.attachments).toEqual([attachment])
    expect(undone.changes?.find((file) => file.path === "tracked.txt")).toMatchObject({ additions: 1, deletions: 1 })
    expect(readFileSync(file("tracked.txt"), "utf8")).toBe("dirty before turn\n")
    expect(readFileSync(file("deleted.txt"), "utf8")).toBe("deleted original\n")
    expect(readFileSync(file("binary.bin"))).toEqual(Buffer.from([0, 1, 2]))
    expect(existsSync(file("new.txt"))).toBe(false)
    expect(readFileSync(file("ignored.txt"), "utf8")).toBe("ignored tool")
    const redo = result(await h.client.send({ type: "session.redo", sessionId }), RewindReport)
    expect(redo.files.restored).toContain("new.txt")
    expect(readFileSync(file("tracked.txt"), "utf8")).toBe("changed")
    expect(existsSync(file("deleted.txt"))).toBe(false)
    expect(readFileSync(file("binary.bin"))).toEqual(Buffer.from([0, 110, 101, 119]))
    expect(readFileSync(file(".git/index"))).toEqual(index)
    expect(git(h.project, ["rev-parse", "HEAD"])).toBe(head)
  })

  test("snapshot false prevents capture and restoration, including existing snapshots, while conversation still rewinds", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "changed" }), stop("done"), callTool("write", { path: "b.txt", content: "new" }), stop("done")] })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "a.txt"), "original")
    await say(h, sessionId, "first")
    expect((await h.client.send({ type: "settings.set", patch: { snapshot: false } })).ok).toBe(true)
    const undone = result(await h.client.send({ type: "session.undo", sessionId }), RewindReport)
    expect(undone.files).toEqual({ restored: [], removed: [], skipped: [] })
    expect(undone.notes.join(" ")).toContain("snapshots are disabled")
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("changed")
    await say(h, sessionId, "second")
    const last = h.store.turns.list(sessionId).at(-1)!
    expect(h.store.turns.files.list(sessionId, last.turnId)).toEqual([])
    expect(result(await h.client.send({ type: "session.undo", sessionId }), RewindReport).history.messages).toBeGreaterThan(0)
    expect(existsSync(path.join(h.project, "b.txt"))).toBe(true)
  })

  test("message diffs persist independently of live Git changes and session diffs combine repeated edits, undo and redo", async () => {
    const h = await worktree([callTool("shell", { command: "printf 'second\\n' > tracked.txt" }), stop("one"), callTool("shell", { command: "printf 'third\\n' > tracked.txt" }), stop("two")])
    const sessionId = await open(h)
    await say(h, sessionId, "first")
    await say(h, sessionId, "second")
    const entries = await timeline(h, sessionId)
    const first = await h.client.sessionChanges(sessionId, entries[0]!.itemId)
    expect(first).toMatchObject({ ok: true, report: { scope: "message", complete: true, files: [{ path: "tracked.txt", additions: 1, deletions: 1 }] } })
    if (first.ok) expect(first.report.files[0]?.diff).toContain("+second")
    const total = await h.client.sessionChanges(sessionId)
    if (!total.ok) throw new Error("missing session summary")
    expect(ChangesReport.parse(total.report).complete).toBe(true)
    expect(total.report.files[0]).toMatchObject({ additions: 1, deletions: 1 })
    expect(total.report.files[0]?.diff).toContain("-original")
    expect(total.report.files[0]?.diff).toContain("+third")
    await h.client.send({ type: "session.undo", sessionId })
    const afterUndo = await h.client.sessionChanges(sessionId)
    if (afterUndo.ok) expect(afterUndo.report.files[0]?.diff).toContain("+second")
    await h.client.send({ type: "session.redo", sessionId })
    writeFileSync(path.join(h.project, "tracked.txt"), "unrelated current edit\n")
    const saved = await h.client.sessionChanges(sessionId, entries[0]!.itemId)
    expect(saved).toEqual(first)
    const reopened = new Database(path.join(h.dir, "mendd.db"), { readonly: true })
    try {
      const row = reopened.query<{ payload: string }, [string, string]>("SELECT payload FROM turn_snapshots WHERE session_id = ? AND turn_id = ?").get(sessionId, entries[0]!.turnId)!
      expect(JSON.parse(row.payload).summary.files[0].diff).toContain("+second")
    } finally { reopened.close() }
    expect(await h.client.sessionChanges(sessionId, createIdFactory()("item"))).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  })

  test("file modes are preserved; a replacement symlink is never followed even with force", async () => {
    const h = await worktree([callTool("shell", { command: "chmod 755 tracked.txt; printf new > tracked.txt" }), stop("done")])
    const sessionId = await open(h)
    chmodSync(path.join(h.project, "tracked.txt"), 0o644)
    await say(h, sessionId, "make executable")
    await h.client.send({ type: "session.undo", sessionId })
    expect(statSync(path.join(h.project, "tracked.txt")).mode & 0o777).toBe(0o644)
    await h.client.send({ type: "session.redo", sessionId })
    expect(statSync(path.join(h.project, "tracked.txt")).mode & 0o777).toBe(0o755)
    const outside = path.join(tempDir("mend-b55-outside-"), "outside.txt")
    writeFileSync(outside, "untouched")
    rmSync(path.join(h.project, "tracked.txt"))
    symlinkSync(outside, path.join(h.project, "tracked.txt"))
    const report = result(await h.client.send({ type: "session.undo", sessionId, force: true }), RewindReport)
    expect(report.files.skipped).toContainEqual({ path: "tracked.txt", reason: "unreadable" })
    expect(readFileSync(outside, "utf8")).toBe("untouched")
  })
})

describe("R8 part-level revert and redo of every group", () => {
  const toolItems = (h: Harness) => h.events.filter((event): event is Extract<SessionEvent, { type: "item.started" }> => event.type === "item.started" && event.kind === "tool_call").map((event) => event.itemId)
  const liveTurns = (h: Harness, sessionId: SessionId) => h.store.turns.list(sessionId).filter((turn) => !turn.reverted).length

  test("a part after earlier work reverts only its edits and the later ones; the transcript stays and redo re-applies them", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "x" }), callTool("write", { path: "b.txt", content: "y" }), callTool("write", { path: "a.txt", content: "z" }), stop("done")] })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "a.txt"), "original")
    await say(h, sessionId, "three writes")
    const [, second] = toolItems(h)
    const file = (name: string) => path.join(h.project, name)

    const undone = result(await h.client.send({ type: "session.undo", sessionId, atPartId: second as never }), RewindReport)
    expect(undone).toMatchObject({ partial: true, partId: second, canRedo: true, history: { messages: 0 } })
    expect(readFileSync(file("a.txt"), "utf8")).toBe("x")
    expect(existsSync(file("b.txt"))).toBe(false)
    expect(liveTurns(h, sessionId)).toBe(1)
    expect(history(h, sessionId).length).toBeGreaterThan(0)
    expect(h.store.turns.undoTop(sessionId)?.partial).toMatchObject({ itemId: second })

    const redone = result(await h.client.send({ type: "session.redo", sessionId }), RewindReport)
    expect(redone).toMatchObject({ partial: true, canRedo: false })
    expect(readFileSync(file("a.txt"), "utf8")).toBe("z")
    expect(readFileSync(file("b.txt"), "utf8")).toBe("y")
    expect(h.store.turns.undoTop(sessionId)).toBeUndefined()
  })

  test("the first work of a turn means the whole message; a part-level revert refuses edits made since and honours force", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "x" }), callTool("write", { path: "a.txt", content: "y" }), stop("done")] })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "a.txt"), "original")
    await say(h, sessionId, "two writes")
    const [first, second] = toolItems(h)
    writeFileSync(path.join(h.project, "a.txt"), "edited by hand")
    const refused = await h.client.send({ type: "session.undo", sessionId, atPartId: second as never })
    expect(refused).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("edited by hand")
    expect(h.store.turns.undoTop(sessionId)).toBeUndefined()
    result(await h.client.send({ type: "session.undo", sessionId, atPartId: second as never, force: true }), RewindReport)
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("x")
    // The first call has no earlier text or tool call: the whole message goes, and the pending part-level revert is redone first.
    const whole = result(await h.client.send({ type: "session.undo", sessionId, atPartId: first as never, force: true }), RewindReport)
    expect(whole.partial).toBeUndefined()
    expect(liveTurns(h, sessionId)).toBe(0)
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("original")
  })

  test("a part of an older message also undoes the messages after it, and redo { all } restores everything newest undo first", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "x" }), callTool("write", { path: "b.txt", content: "y" }), stop("one"), callTool("write", { path: "c.txt", content: "later" }), stop("two")] })
    const sessionId = await open(h)
    await say(h, sessionId, "first")
    await say(h, sessionId, "second")
    const second = toolItems(h)[1]
    const file = (name: string) => path.join(h.project, name)
    result(await h.client.send({ type: "session.undo", sessionId, atPartId: second as never }), RewindReport)
    expect(existsSync(file("a.txt"))).toBe(true)
    expect(existsSync(file("b.txt"))).toBe(false)
    expect(existsSync(file("c.txt"))).toBe(false)
    expect(liveTurns(h, sessionId)).toBe(1)
    expect(h.store.turns.undoDepth(sessionId)).toBe(2)

    const restored = result(await h.client.send({ type: "session.redo", sessionId, all: true }), RewindReport)
    expect(restored.canRedo).toBe(false)
    expect(restored.turnIds).toHaveLength(2)
    expect(readFileSync(file("b.txt"), "utf8")).toBe("y")
    expect(readFileSync(file("c.txt"), "utf8")).toBe("later")
    expect(liveTurns(h, sessionId)).toBe(2)
    expect(h.store.turns.undoDepth(sessionId)).toBe(0)
    expect(await h.client.send({ type: "session.redo", sessionId, all: true })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  })

  test("redo { all } undoes repeated message undos in one call", async () => {
    const h = await boot({ steps: [stop("one"), stop("two"), stop("three")] })
    const sessionId = await open(h)
    await say(h, sessionId, "a")
    await say(h, sessionId, "b")
    await say(h, sessionId, "c")
    await h.client.send({ type: "session.undo", sessionId })
    await h.client.send({ type: "session.undo", sessionId })
    expect(liveTurns(h, sessionId)).toBe(1)
    const restored = result(await h.client.send({ type: "session.redo", sessionId, all: true }), RewindReport)
    expect(restored.turnIds).toHaveLength(2)
    expect(liveTurns(h, sessionId)).toBe(3)
    expect(history(h, sessionId)).toHaveLength(6)
  })

  test("a part that is not in a live message of the session is refused and changes nothing", async () => {
    const h = await boot({ steps: [stop("one")] })
    const sessionId = await open(h)
    await say(h, sessionId, "a")
    expect(await h.client.send({ type: "session.undo", sessionId, atPartId: createIdFactory()("item") })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
    expect(liveTurns(h, sessionId)).toBe(1)
  })

  test("a new turn ends the part-level redo and keeps the files as reverted", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "x" }), callTool("write", { path: "a.txt", content: "y" }), stop("done"), stop("next")] })
    const sessionId = await open(h)
    await say(h, sessionId, "writes")
    result(await h.client.send({ type: "session.undo", sessionId, atPartId: toolItems(h)[1] as never }), RewindReport)
    await say(h, sessionId, "go on")
    expect(h.store.turns.undoTop(sessionId)).toBeUndefined()
    expect(readFileSync(path.join(h.project, "a.txt"), "utf8")).toBe("x")
    expect(await h.client.send({ type: "session.redo", sessionId })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  })

  test("a session diff folds a path changed by a turn whose bytes were pruned and by a retained one", async () => {
    const h = await boot()
    const sessionId = await open(h)
    const ids = createIdFactory()
    const bytes = (text: string) => new TextEncoder().encode(text)
    const file = path.join(h.project, "p.txt")
    const turn = () => {
      const turnId = ids("turn"), itemId = ids("item")
      h.store.sessionSink.append({ type: "turn.started", sessionId, turnId, queueId: ids("queue") })
      h.store.sessionSink.append({ type: "item.started", sessionId, turnId, itemId, kind: "user_message" })
      h.store.sessionSink.append({ type: "item.completed", sessionId, itemId, status: "ok", text: "t" })
      h.store.sessionSink.append({ type: "turn.completed", sessionId, turnId })
      return turnId
    }
    const pruned = turn()
    h.store.turns.snapshots.put(sessionId, pruned, { root: h.project, scope: "tools", complete: true, sealed: true, summary: { root: h.project, omittedFiles: 0, complete: true, files: [{ path: "p.txt", status: "added", additions: 2, deletions: 0, binary: false, diff: "@@ -0,0 +1,2 @@\n+a\n+b\n", truncated: false }] } })
    const retained = turn()
    h.store.turns.files.captureBefore(sessionId, retained, file, { state: "content", content: bytes("a\nb\n") })
    h.store.turns.files.seal(sessionId, retained, file, { state: "content", content: bytes("a\nb\nc\n") })
    h.store.turns.snapshots.put(sessionId, retained, { root: h.project, scope: "tools", complete: true, sealed: true })
    const report = await h.client.sessionChanges(sessionId)
    if (!report.ok) throw new Error("missing session changes")
    expect(report.report.files).toHaveLength(1)
    expect(report.report.files[0]).toMatchObject({ path: "p.txt", status: "added", additions: 3, deletions: 0, truncated: true, touchedAt: h.store.turns.get(sessionId, retained)!.at })
    expect(report.report.files[0]?.diff).toContain("+a")
    expect(report.report.files[0]?.diff).toContain("+c")
    expect(report.report.complete).toBe(false)
  })

  test("the state before each edit call is kept per call", async () => {
    const h = await boot({ steps: [callTool("write", { path: "a.txt", content: "x" }), callTool("write", { path: "a.txt", content: "y" }), stop("done")] })
    const sessionId = await open(h)
    writeFileSync(path.join(h.project, "a.txt"), "original")
    await say(h, sessionId, "writes")
    const calls = h.store.turns.calls.list(sessionId, h.store.turns.list(sessionId)[0]!.turnId)
    expect(calls.map((call) => call.before.state === "content" ? new TextDecoder().decode(call.before.content) : call.before.state)).toEqual(["original", "x"])
    expect(new Set(calls.map((call) => call.itemId)).size).toBe(2)
  })
})
