import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createIdFactory, type AsideThread, type SessionEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { asideTranscript } from "../src/aside"
import { ASIDE_BRIEF } from "../src/aside-session"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type EngineDeps = Parameters<Parameters<typeof startDaemon>[0]["engine"]>[0]

/**
 * The faux engine, where a side session's turn runs the side question itself (`/tool 20`, `/ask`, `/fail`, `/hang`), so the
 * side chat is exercised with real turns; `/retry` first reports a provider retry. Every turn's full text is recorded.
 */
function sideEngine(prompts: string[]) {
  return ({ clock }: EngineDeps) => {
    const faux = createFauxEngine({ clock, deltaMs: 1 })
    return {
      ...faux,
      async runTurn(input: Parameters<typeof faux.runTurn>[0]) {
        prompts.push(input.text)
        const question = input.text.includes("Side question: ") ? input.text.split("Side question: ").pop()! : input.text
        if (question === "/retry") input.emit({ type: "retrying", attempt: 1, delayMs: 10, message: "stream stalled" })
        return faux.runTurn({ ...input, text: question === "/retry" ? "/say recovered" : question })
      },
    }
  }
}

async function boot(options: { complete?: boolean; prompts?: string[] } = {}) {
  const prompts = options.prompts ?? []
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-aside-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: sideEngine(prompts), ...(options.complete === false ? {} : { complete: async () => "" }) })
  const events: SessionEvent[] = []
  const globals: Array<{ type: string; thread?: AsideThread }> = []
  const client = createClient({ socketPath: daemon.socketPath, name: "aside", onEvent: (event) => void events.push(event), onGlobal: (event) => void globals.push(event as never) })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const created = await client.send({ type: "session.create", directory: dir, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await client.subscribe(sessionId, 0)
  return { client, sessionId, events, globals, prompts, dir }
}

async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const thread = async (client: Awaited<ReturnType<typeof boot>>["client"], sessionId: SessionId) => {
  const reply = await client.send({ type: "session.aside.get", sessionId })
  return (reply.ok ? reply.result?.thread : undefined) as AsideThread
}

describe("session.aside (/btw)", () => {
  test("answers in a hidden side session that sees the transcript; the main session gets no event and no list shows it", async () => {
    const { client, sessionId, events, prompts, dir } = await boot()
    await client.send({ type: "user.submit", sessionId, text: "the dev server runs on 3000", attachments: [] })
    await until(() => events.some((event) => event.type === "turn.completed"))
    const before = events.length
    expect(await client.send({ type: "session.aside", sessionId, text: "which port?" })).toMatchObject({ ok: true, result: { text: "echo: which port?" } })
    const side = prompts.at(-1)!
    expect(side).toStartWith(ASIDE_BRIEF)
    expect(side).toContain("User: the dev server runs on 3000")
    expect(side).toContain("Assistant: echo: the dev server runs on 3000")
    expect(side).toEndWith("Side question: which port?")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events.length).toBe(before)
    const listed = await client.send({ type: "session.list", directory: dir })
    expect((listed.ok ? listed.result?.sessions as Array<{ sessionId: string }> : []).map((entry) => entry.sessionId)).toEqual([sessionId])
  })

  test("works while a turn runs, without interrupting it", async () => {
    const { client, sessionId, events } = await boot()
    await client.send({ type: "user.submit", sessionId, text: "/hang", attachments: [] })
    await until(() => events.some((event) => event.type === "turn.started"))
    expect(await client.send({ type: "session.aside", sessionId, text: "what is it doing?" })).toMatchObject({ ok: true, result: { text: "echo: what is it doing?" } })
    expect(events.some((event) => event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.interrupted")).toBe(false)
  })

  test("refused for an unknown session and without the native engine; a failed turn is an error in the panel", async () => {
    const plain = await boot({ complete: false })
    expect(await plain.client.send({ type: "session.aside", sessionId: plain.sessionId, text: "hi" })).toMatchObject({ ok: false, error: { message: "[DAEMON]: side questions need the native engine" } })
    const { client, sessionId } = await boot()
    expect(await client.send({ type: "session.aside", sessionId, text: "/fail" })).toMatchObject({ ok: false, error: { message: "[DAEMON]: requested failure" } })
    expect(await thread(client, sessionId)).toMatchObject({ busy: false, error: "requested failure" })
    expect(await client.send({ type: "session.aside", sessionId: createIdFactory()("session"), text: "hi" })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
  })
})

describe("side chat tools, retries and approvals", () => {
  test("the tools an answer ran are lines of the thread, before the answer", async () => {
    const { client, sessionId } = await boot()
    await client.send({ type: "session.aside", sessionId, text: "/tool 20" })
    expect((await thread(client, sessionId)).messages).toEqual([{ role: "user", text: "/tool 20" }, { role: "tool", text: "faux" }, { role: "assistant", text: "echo: /tool 20" }])
  })

  test("a provider retry shows as the thread's status while it waits, and the answer clears it", async () => {
    const { client, sessionId, globals } = await boot()
    await client.send({ type: "session.aside", sessionId, text: "/retry" })
    expect(globals.some((event) => event.type === "aside.changed" && event.thread?.status === "Retrying (attempt 1): stream stalled")).toBe(true)
    const done = await thread(client, sessionId)
    expect(done.status).toBeUndefined()
    expect(done.messages.at(-1)).toEqual({ role: "assistant", text: "recovered" })
  })

  test("an approval is refused in the side chat instead of waiting for an answer nobody can give", async () => {
    const { client, sessionId } = await boot()
    await client.send({ type: "session.aside", sessionId, text: "/ask" })
    const done = await thread(client, sessionId)
    expect(done.busy).toBe(false)
    expect(done.messages).toContainEqual({ role: "tool", text: "needed approval: refused in the side chat" })
  })
})

describe("aside transcript", () => {
  const at = 1
  const base = { sessionId: "s" as SessionId, at }
  test("messages, tool titles with the start of their output, a turn still writing, and only the most recent part", () => {
    const events = [
      { ...base, seq: 1, type: "item.started", turnId: "t", itemId: "u", kind: "user_message" },
      { ...base, seq: 2, type: "item.completed", itemId: "u", status: "ok", text: "run the tests" },
      { ...base, seq: 3, type: "item.started", turnId: "t", itemId: "r", kind: "reasoning" },
      { ...base, seq: 4, type: "item.delta", itemId: "r", text: "hidden thoughts" },
      { ...base, seq: 5, type: "item.started", turnId: "t", itemId: "k", kind: "tool_call", meta: { tool: "bun test" } },
      { ...base, seq: 6, type: "item.delta", itemId: "k", text: `${"x".repeat(700)}` },
      { ...base, seq: 7, type: "item.started", turnId: "t", itemId: "a", kind: "agent_message" },
      { ...base, seq: 8, type: "item.delta", itemId: "a", text: "12 pass" },
    ] as unknown as SessionEvent[]
    const text = asideTranscript(events)
    expect(text).toStartWith("User: run the tests\n\nTool: bun test\n")
    expect(text).toContain("\n…\n\nAssistant (still writing): 12 pass")
    expect(text).not.toContain("hidden thoughts")
    expect(asideTranscript(events, 20)).toBe("…\nll writing): 12 pass")
  })
})

describe("secret redaction in the session log", () => {
  test("a secret in a message is stored and sent as a marker (docs/secrets.md)", async () => {
    const { client, sessionId, events } = await boot()
    const token = "gh" + "p_" + "a1B2c3D4".repeat(5).slice(0, 36)
    await client.send({ type: "user.submit", sessionId, text: `my token is ${token}`, attachments: [] })
    await until(() => events.some((event) => event.type === "turn.completed"))
    const texts = events.flatMap((event) => ("text" in event && typeof event.text === "string" ? [event.text] : []))
    expect(texts.some((text) => text.includes(token))).toBe(false)
    expect(texts.some((text) => text.includes("my token is ‹secret:1›"))).toBe(true)
  })
})

describe("persistent side chat", () => {
  test("a follow-up continues the side session with only what is new; clear deletes it and the next question starts over", async () => {
    const { client, sessionId, events, prompts, dir } = await boot()
    await client.send({ type: "user.submit", sessionId, text: "Main thread", attachments: [] })
    await until(() => events.some((event) => event.type === "turn.completed"))
    const before = await client.send({ type: "session.export", sessionId, format: "json" })
    const count = events.length
    await client.send({ type: "session.aside", sessionId, text: "First question" })
    await client.send({ type: "session.aside", sessionId, text: "Continue" })
    expect(prompts.at(-1)).toBe("(the session has nothing new)\n\nSide question: Continue")
    expect((await thread(client, sessionId)).messages).toEqual([{ role: "user", text: "First question" }, { role: "assistant", text: "echo: First question" }, { role: "user", text: "Continue" }, { role: "assistant", text: "echo: Continue" }])
    const after = await client.send({ type: "session.export", sessionId, format: "json" })
    const content = (reply: typeof before) => {
      const data = JSON.parse(String(reply.ok ? reply.result?.text : "{}"))
      delete data.exportedAt
      return data
    }
    expect(content(after)).toEqual(content(before))
    expect(events.length).toBe(count)
    await client.send({ type: "user.submit", sessionId, text: "Later work", attachments: [] })
    await until(() => events.filter((event) => event.type === "turn.completed").length === 2)
    await client.send({ type: "session.aside", sessionId, text: "And now?" })
    expect(prompts.at(-1)).toStartWith("<session_update>\nUser: Later work")
    const sessions = async () => { const reply = await client.send({ type: "session.list", directory: dir, roots: false }); return reply.ok ? (reply.result?.sessions as unknown[]).length : 0 }
    expect(await sessions()).toBe(2)
    await client.send({ type: "session.aside.clear", sessionId })
    expect((await thread(client, sessionId)).messages).toEqual([])
    await until(() => { void sessions().then((n) => { remaining = n }); return remaining === 1 })
    await client.send({ type: "session.aside", sessionId, text: "Fresh" })
    expect(prompts.at(-1)).toStartWith(ASIDE_BRIEF)
  })

  test("one answer at a time, and clear stops a running answer and wins over its end", async () => {
    const { client, sessionId, globals } = await boot()
    const asking = client.send({ type: "session.aside", sessionId, text: "/hang" })
    await until(() => globals.some((event) => event.type === "aside.changed" && event.thread?.status === "Running faux…"))
    expect(await client.send({ type: "session.aside", sessionId, text: "busy" })).toMatchObject({ ok: false, error: { code: "busy" } })
    await client.send({ type: "session.aside.clear", sessionId })
    await asking
    await client.send({ type: "session.aside", sessionId, text: "new" })
    expect((await thread(client, sessionId)).messages).toEqual([{ role: "user", text: "new" }, { role: "assistant", text: "echo: new" }])
  })
})

let remaining = -1

test("a real daemon restart restores side history while its main log stays unchanged", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendd-aside-restart-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const options = { dir, socketPath: path.join(dir, "sock"), engine: sideEngine([]), complete: async () => "" }
  let daemon = await startDaemon(options)
  let client = createClient({ socketPath: daemon.socketPath, name: "restart" })
  cleanups.push(() => daemon.stop(), () => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: dir, title: "Retained" })
  const sessionId = created.ok ? created.result!.sessionId as SessionId : createIdFactory()("session")
  const before = await client.send({ type: "session.events", sessionId })
  await client.send({ type: "session.aside", sessionId, text: "Keep this aside" })
  const side = await client.send({ type: "session.aside.get", sessionId })
  await client.close()
  await daemon.stop()
  daemon = await startDaemon(options)
  client = createClient({ socketPath: daemon.socketPath, name: "restart-again" })
  await client.connect()
  expect(await client.send({ type: "session.aside.get", sessionId })).toEqual(side)
  expect(await client.send({ type: "session.events", sessionId })).toEqual(before)
  await client.send({ type: "session.aside.clear", sessionId })
  await client.close()
  await daemon.stop()
  daemon = await startDaemon(options)
  client = createClient({ socketPath: daemon.socketPath, name: "cleared" })
  await client.connect()
  expect(await client.send({ type: "session.aside.get", sessionId })).toMatchObject({ ok: true, result: { thread: { messages: [], busy: false } } })
})
