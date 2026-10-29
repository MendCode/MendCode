import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import type { GlobalEvent, SessionEvent, SessionId, Settings } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import type { QuestionPrompt, ToolContext } from "@mendcode/tools"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"
import { startDaemon } from "../src/daemon"
import { createSettingsTool, SETTINGS_APPLY, SETTINGS_KEEP, SETTINGS_PROPOSAL, SETTINGS_PROPOSAL_LOCAL } from "../src/settings-tool"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function scratchDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-settings-tool-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function storeTool() {
  const store = openStore({ dir: scratchDir() })
  const writes: Array<Record<string, unknown>> = []
  const tool = createSettingsTool({ settings: () => store.settings.get(), check: (patch) => store.settings.check(patch), write: async (patch) => (writes.push(patch), store.settings.set(patch)) })
  return { store, tool, writes }
}
type Answer = Awaited<ReturnType<NonNullable<ToolContext["ask"]>>>
function context(answer?: Answer) {
  const asked: QuestionPrompt[] = []
  const ctx: ToolContext = { cwd: "/work", signal: new AbortController().signal, ...(answer ? { ask: async (question: QuestionPrompt) => (asked.push(question), answer) } : {}) }
  return { ctx, asked }
}
const propose = (patch: Record<string, unknown>) => ({ action: "propose" as const, patch, reason: "the user asked for it" })

describe("mendcode_settings propose", () => {
  test("an invalid patch is refused without asking and nothing is written", async () => {
    const { store, tool, writes } = storeTool()
    for (const patch of [{ outputStyle: 42 }, { notASetting: true }, { budgets: { mode: "api-usage", warnUsd: 5, stopUsd: 1 } }]) {
      const { ctx, asked } = context({ answered: true, text: SETTINGS_APPLY })
      const result = await tool.execute(propose(patch), ctx)
      expect(result.isError).toBe(true)
      expect(result.output).toContain("invalid settings")
      expect(asked).toEqual([])
    }
    expect(writes).toEqual([])
    expect(store.settings.get()).toEqual({})
  })

  test("Don't apply, a typed reply or a dismissed card leaves the settings as they were", async () => {
    const { store, tool, writes } = storeTool()
    store.settings.set({ outputStyle: "explanatory" })
    for (const answer of [{ answered: true, text: SETTINGS_KEEP }, { answered: true, text: "maybe later" }, { answered: false, reason: "the user declined to answer" }] as Answer[]) {
      const { ctx, asked } = context(answer)
      const result = await tool.execute(propose({ outputStyle: "terse" }), ctx)
      expect(asked).toHaveLength(1)
      expect(asked[0]!.detail).toContain('outputStyle: "explanatory" → "terse"')
      expect(asked[0]!.detail).toContain("Why: the user asked for it")
      expect(asked[0]!.options?.map((option) => option.label)).toEqual([SETTINGS_APPLY, SETTINGS_KEEP])
      expect(result.output).toStartWith("Not applied")
    }
    expect(writes).toEqual([])
    expect(store.settings.get().outputStyle).toBe("explanatory")
  })

  test("with no one to ask it refuses and writes nothing", async () => {
    const { store, tool, writes } = storeTool()
    const result = await tool.execute(propose({ tier: "full" }), context().ctx)
    expect(result.isError).toBe(true)
    expect(result.output).toContain("no one here can approve")
    expect(result.output).toContain('tier: unset → "full"')
    expect(writes).toEqual([])
    expect(store.settings.get().tier).toBeUndefined()
  })

  test("Apply writes exactly the patch; a key only a local terminal sets gets the local title", async () => {
    const { store, tool, writes } = storeTool()
    const { ctx, asked } = context({ answered: true, text: SETTINGS_APPLY })
    const result = await tool.execute(propose({ tier: "balanced", outputStyle: "terse" }), ctx)
    expect(result.isError).toBe(false)
    expect(asked[0]!.title).toBe(SETTINGS_PROPOSAL_LOCAL)
    expect(writes).toEqual([{ tier: "balanced", outputStyle: "terse" }])
    expect(store.settings.get()).toMatchObject({ tier: "balanced", outputStyle: "terse" })
    const plain = context({ answered: true, text: SETTINGS_APPLY })
    await tool.execute(propose({ outputStyle: null }), plain.ctx)
    expect(plain.asked[0]!.title).toBe(SETTINGS_PROPOSAL)
    expect(store.settings.get().outputStyle).toBeUndefined()
  })

  test("a patch that changes nothing asks nothing", async () => {
    const { store, tool, writes } = storeTool()
    store.settings.set({ outputStyle: "terse" })
    const { ctx, asked } = context({ answered: true, text: SETTINGS_APPLY })
    expect((await tool.execute(propose({ outputStyle: "terse" }), ctx)).output).toContain("nothing would change")
    expect(asked).toEqual([])
    expect(writes).toEqual([])
  })

  test("the real engine asks in full access too: the permission mode never answers for the user", async () => {
    const { store, tool, writes } = storeTool()
    const { provider } = scriptedProvider([callTool("mendcode_settings", propose({ outputStyle: "terse" })), stop("done")])
    const engine = createNativeEngine({ provider, tools: [tool], history: memoryHistory(), cwdFor: () => "/work", system: () => "test", compactionPrompt: "test" })
    const run = turn({ text: "make answers terse", mode: () => "full", answers: [{ kind: "answer", text: SETTINGS_KEEP }] })
    await engine.runTurn(run.input)
    expect(run.asked).toHaveLength(1)
    expect(run.asked[0]).toMatchObject({ kind: "question", title: SETTINGS_PROPOSAL })
    expect(writes).toEqual([])
    expect(store.settings.get().outputStyle).toBeUndefined()
  })
})

describe("mendcode_settings get", () => {
  test("secrets are never returned", async () => {
    const { store, tool } = storeTool()
    store.settings.set({ outputStyle: "terse", shellEnvironment: { set: { DEPLOY_HOST: "deploy.internal", API_TOKEN: "tok-3f9a8c7d6e5b4a3f2e1d" } }, proxy: { url: "http://alice:hunter2-very-secret@proxy.local:3128" } })
    const result = await tool.execute({ action: "get" }, context().ctx)
    expect(result.isError).toBe(false)
    expect(result.output).not.toContain("tok-3f9a8c7d6e5b4a3f2e1d")
    expect(result.output).not.toContain("deploy.internal")
    expect(result.output).not.toContain("hunter2-very-secret")
    const shown = JSON.parse(result.output) as Settings
    expect(shown.outputStyle).toBe("terse")
    expect(shown.shellEnvironment?.set).toEqual({ DEPLOY_HOST: "[hidden]", API_TOKEN: "[hidden]" })
    expect(JSON.parse((await tool.execute({ action: "get", keys: ["outputStyle", "missing"] }, context().ctx)).output)).toEqual({ outputStyle: "terse" })
  })

  test("a proposal card hides the secrets it replaces", async () => {
    const { store, tool } = storeTool()
    store.settings.set({ shellEnvironment: { set: { API_TOKEN: "tok-3f9a8c7d6e5b4a3f2e1d" } } })
    const { ctx, asked } = context({ answered: true, text: SETTINGS_KEEP })
    const result = await tool.execute(propose({ shellEnvironment: null }), ctx)
    expect(asked[0]!.detail).toContain('shellEnvironment.set.API_TOKEN: "[hidden]" → unset')
    expect(`${asked[0]!.detail}${result.output}`).not.toContain("tok-3f9a8c7d6e5b4a3f2e1d")
  })
})

test("Apply through a running daemon saves with settings.set's write and every client gets settings.changed", async () => {
  const dir = scratchDir()
  const { provider } = scriptedProvider([callTool("mendcode_settings", propose({ outputStyle: "terse" })), stop("done")])
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ store, settingsWrite }) => createNativeEngine({
    provider,
    tools: [createSettingsTool({ settings: () => store.settings.get(), check: (patch) => store.settings.check(patch), write: settingsWrite })],
    history: memoryHistory(), cwdFor: () => dir, system: () => "test", compactionPrompt: "test",
  }) })
  cleanups.push(() => daemon.stop())
  const globals: GlobalEvent[] = []
  const questions: Array<Extract<SessionEvent, { type: "server.request" }>> = []
  let finished = false
  const client = createClient({ socketPath: daemon.socketPath, name: "settings-tool", onGlobal: (event) => void globals.push(event), onEvent: (event) => {
    if (event.type === "server.request") {
      questions.push(event)
      void client.send({ type: "request.resolve", sessionId: event.sessionId, requestId: event.requestId, decision: { kind: "answer", text: SETTINGS_APPLY } })
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") finished = true
  } })
  cleanups.push(() => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: dir, title: "settings" })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result?.sessionId as SessionId
  await client.subscribe(sessionId, 0)
  expect((await client.send({ type: "session.permission.set", sessionId, mode: "full" })).ok).toBe(true)
  expect((await client.send({ type: "user.submit", sessionId, text: "make your answers terse from now on", attachments: [] })).ok).toBe(true)
  const end = Date.now() + 5000
  while (!finished && Date.now() < end) await Bun.sleep(5)
  expect(finished).toBe(true)
  expect(questions).toHaveLength(1)
  expect(questions[0]).toMatchObject({ kind: "question", title: SETTINGS_PROPOSAL })
  const read = await client.send({ type: "settings.get" })
  expect(read.ok && (read.result?.settings as Settings).outputStyle).toBe("terse")
  expect(globals.some((event) => event.type === "settings.changed" && event.settings.outputStyle === "terse")).toBe(true)
})
