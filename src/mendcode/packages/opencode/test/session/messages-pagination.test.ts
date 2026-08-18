import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Log from "@mendcode/core/util/log"

const root = path.join(__dirname, "../..")
void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(SessionNs.defaultLayer)))
}

const svc = {
  ...SessionNs,
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((svc) => svc.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((svc) => svc.remove(id)))
  },
  updateMessage<T extends MessageV2.Info>(msg: T) {
    return run(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
  },
  updatePart<T extends MessageV2.Part>(part: T) {
    return run(SessionNs.Service.use((svc) => svc.updatePart(part)))
  },
  messages(input: { sessionID: SessionID; limit?: number; view?: MessageV2.PageView }) {
    return run(SessionNs.Service.use((svc) => svc.messages(input)))
  },
  fork(input: { sessionID: SessionID; messageID?: MessageID }) {
    return run(SessionNs.Service.use((svc) => svc.fork(input)))
  },
}

async function fill(sessionID: SessionID, count: number, time = (i: number) => Date.now() + i) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    await svc.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
}

async function addUser(sessionID: SessionID, text?: string) {
  const id = MessageID.ascending()
  await svc.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  if (text) {
    await svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
  }
  return id
}

async function addAssistant(
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { summary?: boolean; finish?: string; completed?: boolean; error?: MessageV2.Assistant["error"] },
) {
  const id = MessageID.ascending()
  const created = Date.now()
  await svc.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created, completed: opts?.completed ? created : undefined },
    parentID,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
    error: opts?.error,
  } as unknown as MessageV2.Info)
  return id
}

async function addText(sessionID: SessionID, messageID: MessageID, text: string, opts?: { synthetic?: boolean }) {
  await svc.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic: opts?.synthetic,
  })
}

async function addCompactionPart(sessionID: SessionID, messageID: MessageID, tailStartID?: MessageID) {
  await svc.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    tail_start_id: tailStartID,
  } as any)
}

async function addLargeToolPart(sessionID: SessionID, messageID: MessageID, text: string, includeContent = false) {
  await svc.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    callID: "call_large",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "large-output", ...(includeContent ? { content: text } : {}) },
      output: text,
      title: "large output",
      metadata: {
        output: text,
        diff: text,
        outputPath: "/tmp/full-output",
      },
      time: { start: Date.now(), end: Date.now() },
    },
  } as any)
}

describe("MessageV2.page", () => {
  test("returns sync result", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 2)

        const result = MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(result).toBeDefined()
        expect(result.items).toBeArray()

        await svc.remove(session.id)
      },
    })
  })

  test("pages backward with opaque cursors", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 6)

        const a = MessageV2.page({ sessionID: session.id, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.items.every((item) => item.parts.length === 1)).toBe(true)
        expect(a.more).toBe(true)
        expect(a.cursor).toBeTruthy()

        const b = MessageV2.page({ sessionID: session.id, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
        expect(b.more).toBe(true)
        expect(b.cursor).toBeTruthy()

        const c = MessageV2.page({ sessionID: session.id, limit: 2, before: b.cursor! })
        expect(c.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(c.more).toBe(false)
        expect(c.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("pages complete conversation turns instead of raw assistant events", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const turns: Array<{ user: MessageID; assistants: MessageID[] }> = []
        for (let turn = 0; turn < 4; turn++) {
          const user = await addUser(session.id, `turn ${turn}`)
          const assistants: MessageID[] = []
          const assistantCount = turn === 3 ? 49 : 1
          for (let index = 0; index < assistantCount; index++) {
            const assistant = await addAssistant(session.id, user, { finish: "stop", completed: true })
            await addText(session.id, assistant, index === assistantCount - 1 ? `answer ${turn}` : "")
            assistants.push(assistant)
          }
          turns.push({ user, assistants })
        }

        const latest = MessageV2.page({ sessionID: session.id, limit: 2, view: "tui-all", unit: "turn" })
        expect(latest.items.filter((item) => item.info.role === "user").map((item) => item.info.id)).toEqual(
          turns.slice(2).map((turn) => turn.user),
        )
        expect(latest.items.filter((item) => item.info.role === "assistant")).toHaveLength(50)
        expect(latest.cursor).toBeTruthy()

        const older = MessageV2.page({
          sessionID: session.id,
          limit: 2,
          before: latest.cursor,
          view: "tui-all",
          unit: "turn",
        })
        expect(older.items.filter((item) => item.info.role === "user").map((item) => item.info.id)).toEqual(
          turns.slice(0, 2).map((turn) => turn.user),
        )
        expect(older.more).toBe(false)

        const navigation = MessageV2.pageNavigationCursors({ page: older, before: latest.cursor })
        const newer = MessageV2.page({
          sessionID: session.id,
          limit: 2,
          after: navigation.newer,
          view: "tui-all",
          unit: "turn",
        })
        expect(newer.items.filter((item) => item.info.role === "user").map((item) => item.info.id)).toEqual(
          turns.slice(2).map((turn) => turn.user),
        )

        await svc.remove(session.id)
      },
    })
  })

  test("history view keeps conversation text and compacts agent activity", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const user = await addUser(session.id, "complete user prompt")
        const assistant = await addAssistant(session.id, user, { finish: "stop", completed: true })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: assistant,
          type: "reasoning",
          text: "private reasoning".repeat(10_000),
          time: { start: Date.now(), end: Date.now() },
        })
        await addLargeToolPart(session.id, assistant, "large tool output".repeat(10_000), true)
        await addText(session.id, assistant, "complete assistant response")

        const page = MessageV2.page({ sessionID: session.id, limit: 1, view: "history", unit: "turn" })
        const text = page.items.flatMap((item) => item.parts).filter((part) => part.type === "text")
        const tool = page.items.flatMap((item) => item.parts).find((part) => part.type === "tool")

        expect(text.map((part) => part.text)).toEqual(["complete user prompt", "complete assistant response"])
        expect(page.items.flatMap((item) => item.parts).some((part) => part.type === "reasoning")).toBe(false)
        expect(tool?.type === "tool" && tool.state.status === "completed" && tool.state.output).toBe("")
        expect(tool?.type === "tool" && tool.state.status === "completed" && tool.state.input).toEqual({})
        expect(JSON.stringify(page.items).length).toBeLessThan(10_000)

        await svc.remove(session.id)
      },
    })
  })

  test("exposes bounded cursors for moving both directions between history pages", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 6)

        const latest = MessageV2.page({ sessionID: session.id, limit: 2 })
        const latestNavigation = MessageV2.pageNavigationCursors({ page: latest })
        expect(latestNavigation.older).toBe(latest.cursor)
        expect(latestNavigation.newer).toBeUndefined()

        const older = MessageV2.page({ sessionID: session.id, limit: 2, before: latestNavigation.older })
        const olderNavigation = MessageV2.pageNavigationCursors({ page: older, before: latestNavigation.older })
        expect(older.items.map((item) => item.info.id)).toEqual(ids.slice(2, 4))
        expect(olderNavigation.older).toBe(older.cursor)
        expect(olderNavigation.newer).toBeTruthy()

        const newer = MessageV2.page({ sessionID: session.id, limit: 2, after: olderNavigation.newer })
        expect(newer.items.map((item) => item.info.id)).toEqual(ids.slice(4, 6))

        await svc.remove(session.id)
      },
    })
  })

  test("pages forward with opaque cursors", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 6, (i) => i)
        const afterFirstPair = MessageV2.cursor.encode({ id: ids[1]!, time: 1 })

        const a = MessageV2.page({ sessionID: session.id, limit: 2, after: afterFirstPair })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(2, 4))
        expect(a.more).toBe(true)
        expect(a.cursor).toBeTruthy()

        const b = MessageV2.page({ sessionID: session.id, limit: 2, after: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(4, 6))
        expect(b.more).toBe(false)
        expect(b.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("returns items in chronological order within a page", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 4)

        const result = MessageV2.page({ sessionID: session.id, limit: 4 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)

        await svc.remove(session.id)
      },
    })
  })

  test("returns empty items for session with no messages", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const result = MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(result.items).toEqual([])
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("throws NotFoundError for non-existent session", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const fake = "non-existent-session" as SessionID
        expect(() => MessageV2.page({ sessionID: fake, limit: 10 })).toThrow("NotFoundError")
      },
    })
  })

  test("handles exact limit boundary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 3)

        const result = MessageV2.page({ sessionID: session.id, limit: 3 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("tui view bounds heavyweight user summary diffs without changing full pages", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const messageID = await addUser(session.id, "show history")
        const initial = MessageV2.page({ sessionID: session.id, limit: 1 }).items[0]?.info
        if (!initial || initial.role !== "user") throw new Error("user message missing")
        const diffs = Array.from({ length: 512 }, (_, index) => ({
          file: `file-${index}.txt`,
          patch: "x".repeat(16 * 1024),
          additions: 1,
          deletions: 1,
        }))
        await svc.updateMessage({
          ...initial,
          id: messageID,
          summary: { title: "summary", body: "body", diffs },
        })

        const full = MessageV2.page({ sessionID: session.id, limit: 1 })
        const tui = MessageV2.page({ sessionID: session.id, limit: 1, view: "tui" })
        expect(full.items[0]?.info.role === "user" && full.items[0].info.summary?.diffs).toHaveLength(512)
        expect(tui.items[0]?.info.role === "user" && tui.items[0].info.summary?.diffs.length).toBe(64)
        expect(Buffer.byteLength(JSON.stringify(tui))).toBeLessThan(2 * 1024 * 1024)

        await svc.remove(session.id)
      },
    })
  })

  test("tui view trims heavyweight part payloads without changing full pages", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const messageID = await addUser(session.id, "show history")
        const large = "x".repeat(600 * 1024)
        await addLargeToolPart(session.id, messageID, large, true)
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "file",
          mime: "image/png",
          filename: "large.png",
          url: `data:image/png;base64,${"a".repeat(64 * 1024)}`,
        } as any)
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "patch",
          hash: "large-patch",
          files: Array.from({ length: 4_444 }, (_, index) => `generated/file-${index}.ts`),
        } as any)
        const workflows = Array.from({ length: 32 }, (_, index) => ({
          id: index,
          state: { details: { payload: "x".repeat(4 * 1024) } },
        }))
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: "call_loop",
          tool: "loop",
          state: {
            status: "completed",
            input: { action: "show" },
            output: "loop output",
            title: "loop",
            metadata: { workflows },
            time: { start: Date.now(), end: Date.now() },
          },
        } as any)

        const full = MessageV2.page({ sessionID: session.id, limit: 1 })
        const tui = MessageV2.page({ sessionID: session.id, limit: 1, view: "tui" })
        const fullTool = full.items[0]?.parts.find((part) => part.type === "tool")
        const tuiTool = tui.items[0]?.parts.find((part) => part.type === "tool")
        const tuiFile = tui.items[0]?.parts.find((part) => part.type === "file")
        const fullPatch = full.items[0]?.parts.find((part) => part.type === "patch")
        const tuiPatch = tui.items[0]?.parts.find((part) => part.type === "patch")
        const fullLoop = full.items[0]?.parts.find((part) => part.type === "tool" && part.callID === "call_loop")
        const tuiLoop = tui.items[0]?.parts.find((part) => part.type === "tool" && part.callID === "call_loop")

        expect(fullTool?.type === "tool" && fullTool.state.status === "completed" && fullTool.state.output).toBe(large)
        expect(fullTool?.type === "tool" && fullTool.state.status === "completed" && fullTool.state.input.content).toBe(
          large,
        )
        expect(
          tuiTool?.type === "tool" && tuiTool.state.status === "completed" && tuiTool.state.output.length,
        ).toBeLessThan(large.length)
        expect(
          tuiTool?.type === "tool" && tuiTool.state.status === "completed" && String(tuiTool.state.input.content),
        ).toContain("tool input.content preview truncated")
        expect(
          tuiTool?.type === "tool" && tuiTool.state.status === "completed" && String(tuiTool.state.metadata.outputPath),
        ).toBe("/tmp/full-output")
        expect(
          tuiTool?.type === "tool" && tuiTool.state.status === "completed" && String(tuiTool.state.metadata.diff),
        ).toContain("Diff preview truncated: too large to render safely")
        expect(
          tuiTool?.type === "tool" && tuiTool.state.status === "completed" && String(tuiTool.state.metadata.diff),
        ).toContain("Show more")
        expect(
          tuiTool?.type === "tool" &&
            tuiTool.state.status === "completed" &&
            String(tuiTool.state.metadata.diff).length,
        ).toBeLessThanOrEqual(512 * 1024)
        expect(tuiFile?.type === "file" && tuiFile.url.length).toBeLessThan(16 * 1024)
        expect(fullPatch?.type === "patch" && fullPatch.files.length).toBe(4_444)
        expect(tuiPatch?.type === "patch" && tuiPatch.files.length).toBe(256)
        expect(
          fullLoop?.type === "tool" && fullLoop.state.status === "completed" && fullLoop.state.metadata.workflows,
        ).toHaveLength(32)
        expect(
          tuiLoop?.type === "tool" && tuiLoop.state.status === "completed" && tuiLoop.state.metadata.workflows,
        ).toHaveLength(2)
        expect(Buffer.byteLength(JSON.stringify(tui))).toBeLessThan(1.25 * 1024 * 1024)

        await svc.remove(session.id)
      },
    })
  })

  test("tui-all pages tool parts per message instead of hydrating an unbounded timeline", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const messageID = await addUser(session.id, "show every tool call")
        for (let index = 0; index < 130; index++) {
          await addLargeToolPart(session.id, messageID, `tool ${index}`)
        }

        const first = MessageV2.page({ sessionID: session.id, limit: 1, view: "tui-all", partsLimit: 32 })
        const firstItem = first.items[0]!
        expect(firstItem.parts).toHaveLength(32)
        expect(firstItem.partsMore).toBe(true)
        expect(firstItem.partsCursor).toBeTruthy()

        const normal = MessageV2.page({ sessionID: session.id, limit: 1, view: "tui" }).items[0]!
        expect(normal.parts).toHaveLength(96)
        expect(normal.partsMore).toBe(true)

        const next = MessageV2.get({
          sessionID: session.id,
          messageID,
          view: "tui-all",
          partsLimit: 32,
          partsAfter: firstItem.partsCursor,
        })
        expect(next.parts).toHaveLength(32)
        expect(next.parts[0]?.id).not.toBe(firstItem.parts.at(-1)?.id)
        expect(next.partsMore).toBe(true)
        expect(next.partsCursor).toBeTruthy()

        const full = MessageV2.get({ sessionID: session.id, messageID })
        expect(full.parts).toHaveLength(131)

        await svc.remove(session.id)
      },
    })
  })

  test("tui pages keep terminal assistant text visible after many tool parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const user = await addUser(session.id, "run the long tool sequence")
        const assistant = await addAssistant(session.id, user, { finish: "stop", completed: true })
        for (let index = 0; index < 130; index++) {
          await addLargeToolPart(session.id, assistant, `tool ${index}`)
        }
        await addText(session.id, assistant, "final assistant output")

        const first = MessageV2.page({ sessionID: session.id, limit: 1, view: "tui" }).items[0]!

        expect(first.parts).toHaveLength(96)
        expect(first.parts.some((part) => part.type === "text" && part.text === "final assistant output")).toBe(true)
        expect(first.partsMore).toBe(true)
        expect(first.partsCursor).toBeTruthy()

        const next = MessageV2.get({
          sessionID: session.id,
          messageID: assistant,
          view: "tui-all",
          partsLimit: 96,
          partsAfter: first.partsCursor,
        })
        expect(next.parts.some((part) => part.type === "tool")).toBe(true)
        expect(next.parts.some((part) => part.type === "text" && part.text === "final assistant output")).toBe(true)

        const tiny = MessageV2.get({ sessionID: session.id, messageID: assistant, view: "tui-all", partsLimit: 1 })
        const tinyNext = MessageV2.get({
          sessionID: session.id,
          messageID: assistant,
          view: "tui-all",
          partsLimit: 1,
          partsAfter: tiny.partsCursor,
        })
        expect(tiny.parts).toHaveLength(1)
        expect(tinyNext.parts).toHaveLength(1)
        expect(tinyNext.parts[0]?.id).not.toBe(tiny.parts[0]?.id)

        await svc.remove(session.id)
      },
    })
  })

  test("tui pagination skips tool-only messages and heavy parts before the latest completed compaction", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const oldUser = await addUser(session.id, "old request")
        const oldFinal = await addAssistant(session.id, oldUser, { finish: "stop", completed: true })
        await addText(session.id, oldFinal, "old final answer")
        await addLargeToolPart(session.id, oldFinal, "x".repeat(160 * 1024))
        const hiddenTools = [] as MessageID[]
        for (let index = 0; index < 120; index++) {
          const assistant = await addAssistant(session.id, oldUser, { finish: "tool-calls", completed: true })
          hiddenTools.push(assistant)
          await addLargeToolPart(session.id, assistant, `tool ${index}`)
        }
        const syntheticUser = await addUser(session.id)
        await addText(session.id, syntheticUser, "internal continuation", { synthetic: true })
        const compact = await addUser(session.id)
        await addCompactionPart(session.id, compact)
        const summary = await addAssistant(session.id, compact, { summary: true, finish: "stop", completed: true })
        await addText(session.id, summary, "summary")
        const latestUser = await addUser(session.id, "latest request")
        const latestAssistant = await addAssistant(session.id, latestUser, { finish: "stop", completed: true })
        await addText(session.id, latestAssistant, "latest answer")

        const latest = MessageV2.page({ sessionID: session.id, limit: 4, view: "tui" })
        expect(latest.items.map((item) => item.info.id)).toEqual([
          oldFinal,
          compact,
          summary,
          latestUser,
          latestAssistant,
        ])
        expect(latest.items.find((item) => item.info.id === oldFinal)?.parts).toHaveLength(1)
        expect(latest.items.find((item) => item.info.id === oldFinal)?.parts[0]?.type).toBe("text")
        expect(latest.cursor).toBeTruthy()
        expect(latest.sparse).toBe(true)

        const older = MessageV2.page({ sessionID: session.id, limit: 4, before: latest.cursor, view: "tui" })
        expect(older.items.map((item) => item.info.id)).toEqual([oldUser])
        expect(older.more).toBe(false)
        expect(older.items.some((item) => hiddenTools.includes(item.info.id))).toBe(false)

        const all = MessageV2.page({ sessionID: session.id, limit: 6, view: "tui-all" })
        expect(all.items.some((item) => hiddenTools.includes(item.info.id))).toBe(true)
        expect(all.sparse).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })

  test("latest tui page retains the active user across hundreds of assistant steps", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const compact = await addUser(session.id)
        await addCompactionPart(session.id, compact)
        const summary = await addAssistant(session.id, compact, { summary: true, finish: "stop", completed: true })
        await addText(session.id, summary, "summary")
        const activeUser = await addUser(session.id, "keep the active prompt visible")
        for (let index = 0; index < 30; index++) {
          const assistant = await addAssistant(session.id, activeUser, { finish: "tool-calls", completed: true })
          await addLargeToolPart(session.id, assistant, `tool ${index}`)
        }

        const latest = MessageV2.page({ sessionID: session.id, limit: 10, view: "tui" })

        expect(latest.items.some((item) => item.info.id === activeUser)).toBe(true)
        expect(
          latest.items
            .find((item) => item.info.id === activeUser)
            ?.parts.some((part) => part.type === "text" && part.text === "keep the active prompt visible"),
        ).toBe(true)

        await svc.remove(session.id)
      },
    })
  })

  test("session messages honors tui view for unpaginated reads", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const messageID = await addUser(session.id, "show history")
        const large = "x".repeat(64 * 1024)
        await addLargeToolPart(session.id, messageID, large)

        const full = await svc.messages({ sessionID: session.id })
        const tui = await svc.messages({ sessionID: session.id, view: "tui" })
        const fullTool = full[0]?.parts.find((part) => part.type === "tool")
        const tuiTool = tui[0]?.parts.find((part) => part.type === "tool")

        expect(fullTool?.type === "tool" && fullTool.state.status === "completed" && fullTool.state.output).toBe(large)
        expect(
          tuiTool?.type === "tool" && tuiTool.state.status === "completed" && tuiTool.state.output.length,
        ).toBeLessThan(large.length)

        await svc.remove(session.id)
      },
    })
  })

  test("limit of 1 returns single newest message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const result = MessageV2.page({ sessionID: session.id, limit: 1 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].info.id).toBe(ids[ids.length - 1])
        expect(result.more).toBe(true)

        await svc.remove(session.id)
      },
    })
  })

  test("hydrates multiple parts per message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = MessageV2.page({ sessionID: session.id, limit: 10 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].parts).toHaveLength(2)

        await svc.remove(session.id)
      },
    })
  })

  test("accepts cursors from fractional timestamps", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 4, (i) => 1000.5 + i)

        const a = MessageV2.page({ sessionID: session.id, limit: 2 })
        const b = MessageV2.page({ sessionID: session.id, limit: 2, before: a.cursor! })

        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))

        await svc.remove(session.id)
      },
    })
  })

  test("messages with same timestamp are ordered by id", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 4, () => 1000)

        const a = MessageV2.page({ sessionID: session.id, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.more).toBe(true)

        const b = MessageV2.page({ sessionID: session.id, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(b.more).toBe(false)

        await svc.remove(session.id)
      },
    })
  })

  test("does not return messages from other sessions", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const a = await svc.create({})
        const b = await svc.create({})
        await fill(a.id, 3)
        await fill(b.id, 2)

        const resultA = MessageV2.page({ sessionID: a.id, limit: 10 })
        const resultB = MessageV2.page({ sessionID: b.id, limit: 10 })
        expect(resultA.items).toHaveLength(3)
        expect(resultB.items).toHaveLength(2)
        expect(resultA.items.every((item) => item.info.sessionID === a.id)).toBe(true)
        expect(resultB.items.every((item) => item.info.sessionID === b.id)).toBe(true)

        await svc.remove(a.id)
        await svc.remove(b.id)
      },
    })
  })

  test("large limit returns all messages without cursor", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 10)

        const result = MessageV2.page({ sessionID: session.id, limit: 100 })
        expect(result.items).toHaveLength(10)
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.stream", () => {
  test("yields items newest first", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const items = Array.from(MessageV2.stream(session.id))
        expect(items.map((item) => item.info.id)).toEqual(ids.slice().reverse())

        await svc.remove(session.id)
      },
    })
  })

  test("yields nothing for empty session", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const items = Array.from(MessageV2.stream(session.id))
        expect(items).toHaveLength(0)

        await svc.remove(session.id)
      },
    })
  })

  test("yields single message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 1)

        const items = Array.from(MessageV2.stream(session.id))
        expect(items).toHaveLength(1)
        expect(items[0].info.id).toBe(ids[0])

        await svc.remove(session.id)
      },
    })
  })

  test("hydrates parts for each yielded message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 3)

        const items = Array.from(MessageV2.stream(session.id))
        for (const item of items) {
          expect(item.parts).toHaveLength(1)
          expect(item.parts[0].type).toBe("text")
        }

        await svc.remove(session.id)
      },
    })
  })

  test("handles sets exceeding internal page size", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 60)

        const items = Array.from(MessageV2.stream(session.id))
        expect(items).toHaveLength(60)
        expect(items[0].info.id).toBe(ids[ids.length - 1])
        expect(items[59].info.id).toBe(ids[0])

        await svc.remove(session.id)
      },
    })
  })

  test("is a sync generator", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 1)

        const gen = MessageV2.stream(session.id)
        const first = gen.next()
        // sync generator returns { value, done } directly, not a Promise
        expect(first).toHaveProperty("value")
        expect(first).toHaveProperty("done")
        expect(first.done).toBe(false)

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.parts", () => {
  test("returns parts for a message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const result = MessageV2.parts(id)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe("text")
        expect((result[0] as MessageV2.TextPart).text).toBe("m0")

        await svc.remove(session.id)
      },
    })
  })

  test("returns empty array for message with no parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const id = await addUser(session.id)

        const result = MessageV2.parts(id)
        expect(result).toEqual([])

        await svc.remove(session.id)
      },
    })
  })

  test("returns multiple parts in order", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "second",
        })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "third",
        })

        const result = MessageV2.parts(id)
        expect(result).toHaveLength(3)
        expect((result[0] as MessageV2.TextPart).text).toBe("m0")
        expect((result[1] as MessageV2.TextPart).text).toBe("second")
        expect((result[2] as MessageV2.TextPart).text).toBe("third")

        await svc.remove(session.id)
      },
    })
  })

  test("returns empty for non-existent message id", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        await svc.create({})
        const result = MessageV2.parts(MessageID.ascending())
        expect(result).toEqual([])
      },
    })
  })

  test("parts contain sessionID and messageID", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const result = MessageV2.parts(id)
        expect(result[0].sessionID).toBe(session.id)
        expect(result[0].messageID).toBe(id)

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.get", () => {
  test("returns message with hydrated parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const result = MessageV2.get({ sessionID: session.id, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.info.sessionID).toBe(session.id)
        expect(result.info.role).toBe("user")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as MessageV2.TextPart).text).toBe("m0")

        await svc.remove(session.id)
      },
    })
  })

  test("throws NotFoundError for non-existent message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        expect(() => MessageV2.get({ sessionID: session.id, messageID: MessageID.ascending() })).toThrow(
          "NotFoundError",
        )

        await svc.remove(session.id)
      },
    })
  })

  test("scopes by session id", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const a = await svc.create({})
        const b = await svc.create({})
        const [id] = await fill(a.id, 1)

        expect(() => MessageV2.get({ sessionID: b.id, messageID: id })).toThrow("NotFoundError")
        const result = MessageV2.get({ sessionID: a.id, messageID: id })
        expect(result.info.id).toBe(id)

        await svc.remove(a.id)
        await svc.remove(b.id)
      },
    })
  })

  test("returns message with multiple parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = MessageV2.get({ sessionID: session.id, messageID: id })
        expect(result.parts).toHaveLength(2)

        await svc.remove(session.id)
      },
    })
  })

  test("returns assistant message with correct role", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const uid = await addUser(session.id, "hello")
        const aid = await addAssistant(session.id, uid)

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: aid,
          type: "text",
          text: "response",
        })

        const result = MessageV2.get({ sessionID: session.id, messageID: aid })
        expect(result.info.role).toBe("assistant")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as MessageV2.TextPart).text).toBe("response")

        await svc.remove(session.id)
      },
    })
  })

  test("returns message with zero parts", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const id = await addUser(session.id)

        const result = MessageV2.get({ sessionID: session.id, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.parts).toEqual([])

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2.filterCompacted", () => {
  test("returns all messages when no compaction", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const ids = await fill(session.id, 5)

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(result).toHaveLength(5)
        // reversed from newest-first to chronological
        expect(result.map((item) => item.info.id)).toEqual(ids)

        await svc.remove(session.id)
      },
    })
  })

  test("stops at compaction boundary and returns chronological order", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        // Chronological: u1(+compaction part), a1(summary, parentID=u1), u2, a2
        // Stream (newest first): a2, u2, a1(adds u1 to completed), u1(in completed + compaction) -> break
        const u1 = await addUser(session.id, "first question")
        const a1 = await addAssistant(session.id, u1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "summary",
        })
        await addCompactionPart(session.id, u1)

        const u2 = await addUser(session.id, "new question")
        const a2 = await addAssistant(session.id, u2)
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "new response",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        // Includes compaction boundary: u1, a1, u2, a2
        expect(result[0].info.id).toBe(u1)
        expect(result.length).toBe(4)

        await svc.remove(session.id)
      },
    })
  })

  test("handles empty iterable", () => {
    const result = MessageV2.filterCompacted([])
    expect(result).toEqual([])
  })

  test("does not break on compaction part without matching summary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "hello")
        await addCompactionPart(session.id, u1)
        await addUser(session.id, "world")

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(result).toHaveLength(2)

        await svc.remove(session.id)
      },
    })
  })

  test("skips assistant with error even if marked as summary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "hello")
        await addCompactionPart(session.id, u1)

        const error = new MessageV2.APIError({
          message: "boom",
          isRetryable: true,
        }).toObject() as MessageV2.Assistant["error"]
        await addAssistant(session.id, u1, { summary: true, finish: "end_turn", error })
        await addUser(session.id, "retry")

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        // Error assistant doesn't add to completed, so compaction boundary never triggers
        expect(result).toHaveLength(3)

        await svc.remove(session.id)
      },
    })
  })

  test("skips assistant without finish even if marked as summary", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "hello")
        await addCompactionPart(session.id, u1)

        // summary=true but no finish
        await addAssistant(session.id, u1, { summary: true })
        await addUser(session.id, "next")

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(result).toHaveLength(3)

        await svc.remove(session.id)
      },
    })
  })

  test("retains original tail when compaction stores tail_start_id", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, u2)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = await addUser(session.id, "third")
        const a3 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])

        await svc.remove(session.id)
      },
    })
  })

  test("fork remaps compaction tail_start_id for filterCompacted", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, u2)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = await addUser(session.id, "third")
        const a3 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const parentFiltered = MessageV2.filterCompacted(MessageV2.stream(session.id))
        expect(parentFiltered.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])

        const forked = await svc.fork({ sessionID: session.id })
        const childFiltered = MessageV2.filterCompacted(MessageV2.stream(forked.id))
        expect(childFiltered).toHaveLength(parentFiltered.length)

        const tailPart = childFiltered.flatMap((m) => m.parts).find((p) => p.type === "compaction")
        expect(tailPart?.type).toBe("compaction")
        if (!tailPart || tailPart.type !== "compaction") throw new Error("Expected forked compaction part")
        expect(tailPart.tail_start_id).toBeDefined()
        expect(childFiltered.some((m) => m.info.id === tailPart.tail_start_id)).toBe(true)

        await svc.remove(forked.id)
        await svc.remove(session.id)
      },
    })
  })

  test("retains an assistant tail when compaction starts inside a turn", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })
        const a3 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "tail reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, a3)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = await addUser(session.id, "third")
        const a4 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a4,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, a3, u3, a4])

        await svc.remove(session.id)
      },
    })
  })

  test("prefers latest compaction boundary when repeated compactions exist", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})

        const u1 = await addUser(session.id, "first")
        const a1 = await addAssistant(session.id, u1, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = await addUser(session.id, "second")
        const a2 = await addAssistant(session.id, u2, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = await addUser(session.id)
        await addCompactionPart(session.id, c1, u2)
        const s1 = await addAssistant(session.id, c1, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s1,
          type: "text",
          text: "summary one",
        })

        const u3 = await addUser(session.id, "third")
        const a3 = await addAssistant(session.id, u3, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const c2 = await addUser(session.id)
        await addCompactionPart(session.id, c2, u3)
        const s2 = await addAssistant(session.id, c2, { summary: true, finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: s2,
          type: "text",
          text: "summary two",
        })

        const u4 = await addUser(session.id, "fourth")
        const a4 = await addAssistant(session.id, u4, { finish: "end_turn" })
        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: a4,
          type: "text",
          text: "fourth reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(session.id))

        expect(result.map((item) => item.info.id)).toEqual([c2, s2, u3, a3, u4, a4])

        await svc.remove(session.id)
      },
    })
  })

  test("effect history hydration matches the streamed compaction result", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const first = await addUser(session.id, "first")
        const firstAssistant = await addAssistant(session.id, first, { finish: "end_turn" })
        await addText(session.id, firstAssistant, "first reply")
        const retained = await addUser(session.id, "retained")
        const retainedAssistant = await addAssistant(session.id, retained, { finish: "end_turn" })
        await addText(session.id, retainedAssistant, "retained reply")
        const compaction = await addUser(session.id)
        await addCompactionPart(session.id, compaction, retained)
        const summary = await addAssistant(session.id, compaction, { summary: true, finish: "end_turn" })
        await addText(session.id, summary, "summary")
        const latest = await addUser(session.id, "latest")
        const latestAssistant = await addAssistant(session.id, latest, { finish: "end_turn" })
        await addText(session.id, latestAssistant, "latest reply")

        const expected = MessageV2.filterCompacted(MessageV2.stream(session.id))
        const actual = await Effect.runPromise(MessageV2.filterCompactedEffect(session.id))
        expect(actual).toEqual(expected)

        await svc.remove(session.id)
      },
    })
  })

  test("effect history throws for a missing session", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        await expect(
          Effect.runPromise(MessageV2.filterCompactedEffect("missing-session" as SessionID)),
        ).rejects.toThrow("NotFoundError")
      },
    })
  })

  test("works with array input", () => {
    // filterCompacted accepts any Iterable, not just generators
    const id = MessageID.ascending()
    const items: MessageV2.WithParts[] = [
      {
        info: {
          id,
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as unknown as MessageV2.Info,
        parts: [{ type: "text", text: "hello" }] as unknown as MessageV2.Part[],
      },
    ]
    const result = MessageV2.filterCompacted(items)
    expect(result).toHaveLength(1)
    expect(result[0].info.id).toBe(id)
  })
})

describe("MessageV2.cursor", () => {
  test("encode/decode roundtrip", () => {
    const input = { id: MessageID.ascending(), time: 1234567890 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.id).toBe(input.id)
    expect(decoded.time).toBe(input.time)
  })

  test("encode/decode with fractional time", () => {
    const input = { id: MessageID.ascending(), time: 1234567890.5 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.time).toBe(1234567890.5)
  })

  test("encoded cursor is base64url", () => {
    const encoded = MessageV2.cursor.encode({ id: MessageID.ascending(), time: 0 })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("MessageV2 consistency", () => {
  test("page hydration matches get for each message", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 3)

        const paged = MessageV2.page({ sessionID: session.id, limit: 10 })
        for (const item of paged.items) {
          const got = MessageV2.get({ sessionID: session.id, messageID: item.info.id as MessageID })
          expect(got.info).toEqual(item.info)
          expect(got.parts).toEqual(item.parts)
        }

        await svc.remove(session.id)
      },
    })
  })

  test("parts from get match standalone parts call", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const [id] = await fill(session.id, 1)

        const got = MessageV2.get({ sessionID: session.id, messageID: id })
        const standalone = MessageV2.parts(id)
        expect(got.parts).toEqual(standalone)

        await svc.remove(session.id)
      },
    })
  })

  test("stream collects same messages as exhaustive page iteration", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 7)

        const streamed = Array.from(MessageV2.stream(session.id))

        const paged = [] as MessageV2.WithParts[]
        let cursor: string | undefined
        while (true) {
          const result = MessageV2.page({ sessionID: session.id, limit: 3, before: cursor })
          for (let i = result.items.length - 1; i >= 0; i--) {
            paged.push(result.items[i])
          }
          if (!result.more || !result.cursor) break
          cursor = result.cursor
        }

        expect(streamed.map((m) => m.info.id)).toEqual(paged.map((m) => m.info.id))

        await svc.remove(session.id)
      },
    })
  })

  test("filterCompacted of full stream returns same as Array.from when no compaction", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        await fill(session.id, 4)

        const filtered = MessageV2.filterCompacted(MessageV2.stream(session.id))
        const all = Array.from(MessageV2.stream(session.id)).reverse()

        expect(filtered.map((m) => m.info.id)).toEqual(all.map((m) => m.info.id))

        await svc.remove(session.id)
      },
    })
  })
})

describe("MessageV2 targeted session queries", () => {
  test("finds the latest user and compaction marker without hydrating the session", async () => {
    await WithInstance.provide({
      directory: root,
      fn: async () => {
        const session = await svc.create({})
        const first = await addUser(session.id, "first")
        await addAssistant(session.id, first)
        const latest = await addUser(session.id, "latest payload")

        await svc.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: latest,
          type: "text",
          text: "continue",
          metadata: {
            compaction_post_prompt: true,
            compaction_parent_id: first,
          },
        })

        expect(MessageV2.latestUserInfo(session.id)?.id).toBe(latest)
        expect(MessageV2.hasCompactionPostPrompt(session.id, first)).toBe(true)
        expect(MessageV2.hasCompactionPostPrompt(session.id, latest)).toBe(false)
        expect(MessageV2.sessionPayloadBytes(session.id)).toBeGreaterThan("latest payload".length)

        await svc.remove(session.id)
      },
    })
  })
})
