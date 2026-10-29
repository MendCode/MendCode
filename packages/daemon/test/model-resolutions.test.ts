import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { ModelInfo, ModelsReport, SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src/daemon"
import { createModelResolutions } from "../src/model-resolutions"
import type { ModelCatalog } from "../src/models"

const MODELS: ModelInfo[] = [
  { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: ["low", "high"], engine: "claude" },
  { id: "claude-sonnet", name: "Claude Sonnet · Claude Code", efforts: ["low", "high"], engine: "claude" },
]
const catalog: ModelCatalog = { selectable: true, list: () => MODELS, defaults: { model: "gpt-6-luna", effort: "low" } }

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

/** A daemon whose engine answers every turn like Claude Code: the usage of the answer names what `reported` resolved the alias to. */
async function boot(dir: string, reported: { model: string; contextWindow?: number }) {
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "d.sock"), extensionsEnabled: false, log() {}, models: catalog, info: { engine: "native" },
    engine: () => ({
      needsCompaction: () => false,
      async compact() { return { status: "ok" } },
      async runShell() { return { status: "ok" } },
      async runTurn(input) {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "agent_message" })
        input.emit({ type: "item.completed", itemId, status: "ok", text: "fake answer" })
        input.emit({ type: "usage", provider: "claude", model: reported.model, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...(reported.contextWindow ? { context: 2, contextWindow: reported.contextWindow } : {}) })
        return { status: "ok" }
      },
    }),
  })
  const client = createClient({ name: "resolutions", socketPath: daemon.socketPath })
  await client.connect()
  cleanup.push(() => daemon.stop(), () => client.close())
  const created = await client.send({ type: "session.create", directory: dir })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  return { client, sessionId, stop: async () => { await client.close(); await daemon.stop() } }
}

const listed = async (h: Awaited<ReturnType<typeof boot>>) => {
  const reply = await h.client.send({ type: "models.list", sessionId: h.sessionId })
  if (!reply.ok) throw new Error(reply.error.message)
  return (reply.result as ModelsReport).models
}
const resolvedOf = (models: ModelInfo[], id: string) => models.find((model) => model.id === id)?.resolved

async function turn(h: Awaited<ReturnType<typeof boot>>) {
  await h.client.send({ type: "session.model.set", sessionId: h.sessionId, choice: { model: "claude-opus" } })
  await h.client.send({ type: "user.submit", sessionId: h.sessionId, text: "hello", attachments: [] })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const usage = await h.client.send({ type: "models.list", sessionId: h.sessionId })
    if (usage.ok && resolvedOf((usage.result as ModelsReport).models, "claude-opus")) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("the id an engine alias resolved to is remembered", () => {
  test("first run has none; a turn records it; a new daemon on the same data dir serves it at once; a changed resolution replaces it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-resolved-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const reported = { model: "claude-opus-5-5" }
    const first = await boot(dir, reported)
    expect(resolvedOf(await listed(first), "claude-opus")).toBeUndefined()
    await turn(first)
    const models = await listed(first)
    expect(resolvedOf(models, "claude-opus")).toBe("claude-opus-5-5")
    expect(resolvedOf(models, "claude-sonnet")).toBeUndefined()
    expect(resolvedOf(models, "gpt-6-luna")).toBeUndefined()
    await first.stop()
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(JSON.parse(readFileSync(path.join(dir, "model-resolutions.json"), "utf8"))).toEqual({ "claude:claude-opus": "claude-opus-5-5" })

    const second = await boot(dir, reported)
    expect(resolvedOf(await listed(second), "claude-opus")).toBe("claude-opus-5-5")
    expect(resolvedOf(await listed(second), "claude-sonnet")).toBeUndefined()

    reported.model = "claude-opus-5-6"
    await second.client.send({ type: "user.submit", sessionId: second.sessionId, text: "again", attachments: [] })
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && resolvedOf(await listed(second), "claude-opus") !== "claude-opus-5-6") await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resolvedOf(await listed(second), "claude-opus")).toBe("claude-opus-5-6")
    expect(JSON.parse(readFileSync(path.join(dir, "model-resolutions.json"), "utf8"))).toEqual({ "claude:claude-opus": "claude-opus-5-6" })
  })
})

describe("a session pinned to a full Claude Code id, and the window the engine states", () => {
  const WINDOWED: ModelInfo[] = MODELS.map((model) => (model.engine ? { ...model, contextWindow: 200_000 } : model))
  const windowOf = (models: ModelInfo[], id: string) => models.find((model) => model.id === id)?.contextWindow
  const settled = async (h: Awaited<ReturnType<typeof boot>>, done: (models: ModelInfo[]) => boolean) => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !done(await listed(h))) await new Promise((resolve) => setTimeout(resolve, 20))
    return listed(h)
  }

  test("the pinned id is accepted, listed beside its alias while in use, and teaches the alias nothing; garbage is refused", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-pinned-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const h = await boot(dir, { model: "claude-opus-4-8", contextWindow: 1_000_000 })
    expect(await h.client.send({ type: "session.model.set", sessionId: h.sessionId, choice: { model: "claude-nonsense" } })).toMatchObject({ ok: false, error: { message: "[DAEMON]: unknown model claude-nonsense" } })
    const set = await h.client.send({ type: "session.model.set", sessionId: h.sessionId, choice: { model: "claude-opus-4-8" } })
    expect(set).toMatchObject({ ok: true, result: { session: { model: "claude-opus-4-8" }, effective: { model: "claude-opus-4-8" } } })
    expect((await listed(h)).find((model) => model.id === "claude-opus-4-8")).toEqual({ id: "claude-opus-4-8", name: "Claude Opus 4.8 · Claude Code", efforts: ["low", "high"], engine: "claude" })
    await h.client.send({ type: "user.submit", sessionId: h.sessionId, text: "hello", attachments: [] })
    const models = await settled(h, (now) => windowOf(now, "claude-opus-4-8") === 1_000_000)
    // The engine stated the pinned model's window; the alias did not run, so it keeps no resolution and no window.
    expect(windowOf(models, "claude-opus-4-8")).toBe(1_000_000)
    expect(resolvedOf(models, "claude-opus")).toBeUndefined()
    expect(windowOf(models, "claude-opus")).toBeUndefined()
    expect(JSON.parse(readFileSync(path.join(dir, "model-resolutions.json"), "utf8"))).toEqual({ "claude:claude-opus-4-8#window": "1000000" })
  })

  test("the catalog's window of an alias is replaced by the one the engine stated for the model it resolved to, across restarts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-window-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = createModelResolutions(dir)
    expect(windowOf(store.apply(WINDOWED), "claude-opus")).toBe(200_000)
    expect(store.note("claude", "claude-opus", "claude-opus-5-5")).toBe(true)
    expect(windowOf(store.apply(WINDOWED), "claude-opus")).toBe(200_000)
    expect(store.noteWindow("claude", "claude-opus-5-5", 1_000_000)).toBe(true)
    expect(store.noteWindow("claude", "claude-opus-5-5", 1_000_000)).toBe(false)
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(store.noteWindow("claude", "claude-opus-5-5", bad)).toBe(false)
    const reread = createModelResolutions(dir).apply(WINDOWED)
    expect(reread.find((model) => model.id === "claude-opus")).toMatchObject({ resolved: "claude-opus-5-5", contextWindow: 1_000_000 })
    expect(windowOf(reread, "claude-sonnet")).toBe(200_000)
    expect(windowOf(reread, "gpt-6-luna")).toBeUndefined()
    // The alias moved on to a model whose window nobody stated yet: the catalog's figure is back.
    expect(store.note("claude", "claude-opus", "claude-opus-5-6")).toBe(true)
    expect(windowOf(store.apply(WINDOWED), "claude-opus")).toBe(200_000)
  })
})

describe("model resolutions file", () => {
  test("only an id of the alias's own family is kept; a damaged or oversized file reads as empty", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mendd-resolved-file-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = createModelResolutions(dir)
    expect(store.note("claude", "claude-opus", "claude-sonnet-4-5")).toBe(false)
    expect(store.note("claude", "claude-opus", "claude-opus")).toBe(false)
    expect(store.note("claude", "claude-opus", "claude-opus-5-5\nrm")).toBe(false)
    expect(store.get("claude", "claude-opus")).toBeUndefined()
    expect(store.note("claude", "claude-opus", "claude-opus-5-5[1m]")).toBe(true)
    expect(store.note("claude", "claude-opus", "claude-opus-5-5[1m]")).toBe(false)
    expect(store.aliasOf("claude", "claude-opus-5-5", MODELS)).toBe("claude-opus")
    expect(store.aliasOf("native", "claude-opus-5-5", MODELS)).toBeUndefined()
    writeFileSync(path.join(dir, "model-resolutions.json"), "{ not json")
    expect(createModelResolutions(dir).get("claude", "claude-opus")).toBeUndefined()
    writeFileSync(path.join(dir, "model-resolutions.json"), JSON.stringify({ "claude:claude-opus": { nested: true }, "claude:claude-haiku": "claude-haiku-4-5" }))
    const reread = createModelResolutions(dir)
    expect(reread.get("claude", "claude-opus")).toBeUndefined()
    expect(reread.get("claude", "claude-haiku")).toBe("claude-haiku-4-5")
  })
})
