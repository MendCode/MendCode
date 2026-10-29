import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, createMemoryGraphTool, createMemoryTool, createRememberTool, type ModelEvent, type ModelMessage, type ModelProvider, type ModelRequest } from "@mendcode/engine-native"
import type { Clock } from "@mendcode/kernel"
import { findModel, modelContextOf, type GlobalEvent, type ModelInfo, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { defineTool, read, write, shell, taskStatus, type Tool } from "@mendcode/tools"
import { z } from "zod"
import { startDaemon } from "../src"
import { filteredCatalog, resolveModel, usableEffort } from "../src/models"
import { rolesFor } from "../src/profiles"
import { windowOverride } from "../src/session-context-window"

/** The daemon with the native engine on a scripted provider (no network, temp directories only), for tests of daemon features that shape model calls. */
export const stop = (text: string): ModelEvent[] => [{ type: "text", delta: text }, { type: "finish", reason: "stop" }]
export const callTool = (name: string, args: unknown, callId = `call-${name}-${Math.random().toString(36).slice(2, 8)}`): ModelEvent[] => [{ type: "tool_call", call: { callId, name, args } }, { type: "finish", reason: "tool_calls" }]

export const probe = defineTool({
  name: "probe",
  description: "test tool",
  permission: "read",
  args: z.object({}),
  execute: async () => ({ output: "probed", truncated: false, title: "probe", isError: false }),
})

export async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function put(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** One scripted model call: its events, or a function that makes them (and may wait, or throw to fail the call). */
export type Step = ModelEvent[] | ((request: ModelRequest) => ModelEvent[] | Promise<ModelEvent[]>)

/** A model call that never answers until the turn is cancelled (the engine treats an error after an abort as a quiet stop). */
export const hang: Step = (request) => new Promise<ModelEvent[]>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))

/** A call that reports token usage, then answers with `text` (or calls a tool when `call` is given). */
export const answer = (text: string, tokens: { input: number; output: number }): ModelEvent[] => [{ type: "text", delta: text }, { type: "usage", usage: { input: tokens.input, output: tokens.output, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }, { type: "finish", reason: "stop" }]

/**
 * The machine's clock with a way to move it ahead: `jump(ms)` adds to `now` and brings every pending timer that much closer. A wait of
 * the daemon that is seconds or hours long (a usage reset and its grace) is over at once, and everything else keeps real time.
 */
export function jumpClock(): Clock & { jump(ms: number): void } {
  let ahead = 0
  let nextId = 1
  const pending = new Map<number, { at: number; callback: () => void; handle: ReturnType<typeof setTimeout> }>()
  const now = () => Date.now() + ahead
  const arm = (id: number, at: number, callback: () => void) => {
    const handle = setTimeout(() => { pending.delete(id); callback() }, Math.max(0, at - now()))
    pending.set(id, { at, callback, handle })
  }
  return {
    now,
    setTimer(ms, callback) {
      const id = nextId++
      arm(id, now() + Math.max(0, ms), callback)
      return { cancel: () => { clearTimeout(pending.get(id)?.handle); pending.delete(id) } }
    },
    jump(ms) {
      ahead += ms
      for (const [id, timer] of [...pending]) { clearTimeout(timer.handle); arm(id, timer.at, timer.callback) }
    },
  }
}

export async function boot(options: { memoryTools?: boolean; shell?: boolean; extraTools?: Tool[]; sandbox?: import("@mendcode/tools").SandboxPolicy; steps?: Step[]; dir?: string; project?: string; cancelGraceMs?: number; clock?: Clock;complete?: import("../src/daemon").DaemonOptions["complete"]; extractMemory?: import("../src/daemon").DaemonOptions["extractMemory"]; mcp?: import("../src/daemon").McpControl; provider?: Partial<ModelProvider>; http?: boolean; extraModels?: ModelInfo[] } = {}) {
  const cleanups: Array<() => Promise<void> | void> = []
  const temp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }
  const dir = options.dir ?? temp("mendd-native-")
  const project = options.project ?? temp("mendd-native-proj-")
  const steps = options.steps ?? []
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    id: "scripted",
    model: "script-1",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) })
      const step = steps.shift()
      if (!step) throw new Error("script exhausted: the model must not be called here")
      yield* typeof step === "function" ? await step(request) : step
    },
    ...options.provider,
  }
  let store!: Store
  const tools = [read, write, probe, taskStatus, ...(options.shell ? [shell] : []), ...(options.extraTools ?? [])]
  const daemon = await startDaemon({
    dir,
    socketPath: path.join(dir, "mendd.sock"),
    log: () => {},
    info: { engine: "native", model: "script-1" },
    ...(options.http ? { http: { enabled: true }, httpListen: false, defaultDirectory: project } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.extractMemory ? { extractMemory: options.extractMemory } : {}),
    ...(options.complete ? { complete: options.complete } : {}),
    models: { selectable: true, defaults: { model: "script-1" }, list: () => [...["script-1", "gpt-6-luna", "gpt-6-sol"].map((id): ModelInfo => ({ id, name: id, efforts: ["low", "medium", "high"], variants: { high: { effort: "high" } } })), ...(options.extraModels ?? [])] },
    ...(options.cancelGraceMs ? { cancelGraceMs: options.cancelGraceMs } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    engine: ({ trace, store: s, secrets, background, tasks, agents, plans, extensions, goals, memory, emitGlobal, inlineShell }) => {
      store = s
      if (options.memoryTools) tools.push(createMemoryGraphTool(memory), createMemoryTool(memory), createRememberTool(memory.propose, memory))
      const catalog = filteredCatalog({ selectable: true, defaults: { model: "script-1" }, list: () => [...["script-1", "gpt-6-luna", "gpt-6-sol"].map((id): ModelInfo => ({ id, name: id, efforts: ["low", "medium", "high"], variants: { high: { effort: "high", parameters: { temperature: 0.8 } } } })), ...(options.extraModels ?? [])] }, () => s.settings.get())
      extensions.setBuiltinTools(tools)
      return createNativeEngine({
        trace,
        provider,
        tools,
        secrets,
        background,
        goals,
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
        readBlob: async (ref) => new Uint8Array(await Bun.file(s.blobPath(ref.sha256)).arrayBuffer()),
        storeBlob: async (bytes, mime, sessionId) => {
          const ref = s.putBlob(bytes, mime)
          s.refBlob(ref, sessionId)
          return ref
        },
        system: () => "BASE",
        compactionPrompt: "SUMMARIZE",
        subagents: true,
        tasks,
        agents,
        permissionPolicy: () => s.settings.get(),
        memoryAlways: () => emitGlobal({ type: "settings.changed", settings: s.settings.set({ memoryRequireApproval: false }) }),
        plans,
        modelFor: (sessionId, role) => {
          const session = s.sessionModel(sessionId)
          const roles = rolesFor(s.settings.get(), s.sessionDirectory(sessionId))
          return session || Object.keys(roles).length ? resolveModel({ role, session, roles, catalog }) : undefined
        },
        agentModel: (choice) => usableEffort(choice, catalog),
        toolOutput: () => s.settings.get().tool_output,
        shell: () => s.settings.get().shell,
        inlineShell,
        ...(options.sandbox ? { sandbox: () => options.sandbox } : {}),
        blobPath: (ref) => s.blobPath(ref.sha256),
        promptCache: () => s.settings.get().promptCache,
        compaction: () => s.settings.get().compaction,
        // As main.ts: the model's `modelContext` sits between the session's own window and the catalog.
        compactAtTokens: (_sessionId, model) => modelContextOf(s.settings.get(), model ? findModel(catalog.list(), model) : undefined)?.compactAt ?? s.settings.get().compactAtTokens,
        contextWindowFor: (sessionId) => findModel(catalog.list(), resolveModel({ role: "main", session: s.sessionModel(sessionId), roles: rolesFor(s.settings.get(), s.sessionDirectory(sessionId)), catalog }).model)?.contextWindow,
        contextWindowOverrideFor: (sessionId, model) => windowOverride({ meta: s.meta, sessionId, model: model ? findModel(catalog.list(), model) : undefined, settings: s.settings.get() })?.tokens,
      })
    },
  })
  cleanups.push(() => daemon.stop())
  const events: SessionEvent[] = []
  const globals: GlobalEvent[] = []
  const client = createClient({ socketPath: daemon.socketPath, name: "native-test", onEvent: (event) => void events.push(event), onGlobal: (event) => void globals.push(event) })
  await client.connect()
  cleanups.push(() => client.close())
  return {
    dir,
    project,
    daemon,
    client,
    events,
    globals,
    store,
    requests,
    steps,
    temp,
    async cleanup() {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    },
  }
}
export type NativeHarness = Awaited<ReturnType<typeof boot>>

export async function openSession(h: NativeHarness, mode: "ask" | "full" = "full") {
  const created = await h.client.send({ type: "session.create", directory: h.project })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await h.client.subscribe(sessionId, 0)
  await h.client.send({ type: "session.permission.set", sessionId, mode })
  return sessionId
}

/** Submits a prompt and waits for its turn to finish. */
export async function say(h: NativeHarness, sessionId: SessionId, text: string) {
  const before = h.store.turns.list(sessionId).filter((turn) => turn.status !== "running").length
  const ack = await h.client.send({ type: "user.submit", sessionId, text, attachments: [] })
  if (!ack.ok) throw new Error(`submit refused: ${JSON.stringify(ack)}`)
  await until(() => h.store.turns.list(sessionId).filter((turn) => turn.status !== "running").length > before)
}
