import { NodeFileSystem } from "@effect/platform-node"
import { tool } from "ai"
import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { z } from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "@/config/config"
import { Permission } from "../../src/permission"
import { PlanReview } from "../../src/plan-review"
import { Plugin } from "../../src/plugin"
import { Question } from "../../src/question"
import { Provider } from "@/provider/provider"
import { defaultModelsConfig, writeModelsConfig } from "@/mend/config/models"
import { writeProjectMemoryConfig } from "@/mend/memory/config"
import { listMemoryProposals } from "@/mend/memory/proposals"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { initProjectors } from "@/server/projectors"
import * as Log from "@mendcode/core/util/log"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })
initProjectors()

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  PlanReview.defaultLayer,
  Question.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)

const it = testEffect(env)
const originalStreamIdleTimeout = process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const neverTool = (description: string) =>
  tool({
    description,
    inputSchema: z.object({}).passthrough(),
    execute: () => new Promise(() => {}),
  })

afterEach(() => {
  if (originalStreamIdleTimeout === undefined) delete process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS
  else process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = originalStreamIdleTimeout
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor prepares automatic memory extraction metadata without flushing early", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const root = path.resolve(dir)
        yield* Effect.promise(() => writeProjectMemoryConfig({
          enabled: true,
          use: false,
          generate: true,
          extractorRole: "none",
        }, root))
        const { processors, session, provider } = yield* boot()

        yield* llm.text("Decision: keep automatic memory proposals approval gated.")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "remember durable preference")
        const msg = yield* assistant(chat.id, parent.id, root)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "remember durable preference" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const finish = [...parts].reverse().find((part): part is MessageV2.StepFinishPart => part.type === "step-finish")
        const persistedFinish = finish
          ? yield* session.getPart({ sessionID: chat.id, messageID: msg.id, partID: finish.id })
          : undefined
        const memory = persistedFinish?.type === "step-finish" ? (persistedFinish.metadata?.mendMemory as any) : undefined

        expect(value).toBe("continue")
        expect(memory?.output?.generate).toBe(true)
        expect(memory?.output?.queued).toBe(false)
        expect(yield* llm.calls).toBe(1)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor routes automatic memory extraction through LLM service", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const root = path.resolve(dir)
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        process.env.XDG_CONFIG_HOME = path.join(root, ".xdg")
        try {
          yield* Effect.promise(() => writeProjectMemoryConfig({
            enabled: true,
            use: false,
            generate: true,
            extractorRole: "memoryExtractor",
          }, root))
          yield* Effect.promise(() => writeModelsConfig({
            ...defaultModelsConfig,
            enabled: true,
            roles: {
              ...defaultModelsConfig.roles,
              default: { providerID: "test", modelID: "test-model" },
              memoryExtractor: { providerID: "test", modelID: "test-model" },
            },
          }, root))
          const { processors, session, provider } = yield* boot()
          const bus = yield* Bus.Service

          yield* llm.text("Ok, understood.")
          yield* llm.text(JSON.stringify({
            proposals: [{
              shouldRemember: true,
              scope: "global",
              text: "The user wants AskUserQuestion before new features or plans.",
              tags: ["workflow"],
              durability: 0.95,
              confidence: 0.9,
              changeRisk: 0.05,
              reason: "Durable workflow preference.",
            }],
          }))

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "bro it is important that you always ask before any new feature or plan, ok?")
          const msg = yield* assistant(chat.id, parent.id, root)
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const memoryStatuses: string[] = []
          const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
            if (evt.properties.sessionID !== chat.id) return
            if (evt.properties.status.type === "busy" && evt.properties.status.kind) {
              memoryStatuses.push(evt.properties.status.kind)
            }
          })
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "bro it is important that you always ask before any new feature or plan, ok?" }],
            tools: {},
          })
          const callsBeforeFlush = yield* llm.calls
          yield* handle.flushMemory()
          off()

          const parts = MessageV2.parts(msg.id)
          const finish = [...parts].reverse().find((part): part is MessageV2.StepFinishPart => part.type === "step-finish")
          const persistedFinish = finish
            ? yield* session.getPart({ sessionID: chat.id, messageID: msg.id, partID: finish.id })
            : undefined
          const memory = persistedFinish?.type === "step-finish" ? (persistedFinish.metadata?.mendMemory as any) : undefined
          const inputs = yield* llm.inputs

          expect(callsBeforeFlush).toBe(1)
          expect(yield* llm.calls).toBe(2)
          expect(JSON.stringify(inputs[1])).toContain("You are MendCode's memory extractor")
          expect(memoryStatuses).toContain("memory-extract")
          expect(memory?.output?.skipped).toBe(false)
          expect(memory?.output?.candidates).toBe(1)
          expect(memory?.output?.proposals?.length).toBe(1)
        } finally {
          if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
          else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor writes automatic memory proposals under cwd when message root is filesystem root", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const root = path.resolve(dir)
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        process.env.XDG_CONFIG_HOME = path.join(root, ".xdg")
        try {
          yield* Effect.promise(() => writeProjectMemoryConfig({
            enabled: true,
            use: false,
            generate: true,
            extractorRole: "memoryExtractor",
          }, root))
          yield* Effect.promise(() => writeModelsConfig({
            ...defaultModelsConfig,
            enabled: true,
            roles: {
              ...defaultModelsConfig.roles,
              default: { providerID: "test", modelID: "test-model" },
              memoryExtractor: { providerID: "test", modelID: "test-model" },
            },
          }, root))
          const { processors, session, provider } = yield* boot()

          yield* llm.text("Understood.")
          yield* llm.text(JSON.stringify({
            proposals: [{
              shouldRemember: true,
              scope: "project",
              text: "For non-git folders, automatic memory proposals should be stored under the session cwd.",
              tags: ["memory", "workflow"],
              durability: 0.95,
              confidence: 0.9,
              changeRisk: 0.05,
              reason: "Durable project memory routing rule.",
            }],
          }))

          const chat = yield* session.create({})
          const parent = yield* user(chat.id, "remember this non-git folder memory rule")
          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: chat.id,
            mode: "build",
            agent: "build",
            path: { cwd: root, root: "/" },
            cost: 0,
            tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: parent.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* session.updateMessage(msg)
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({
            assistantMessage: msg,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "remember this non-git folder memory rule" }],
            tools: {},
          })
          yield* handle.flushMemory()

          const proposals = yield* Effect.promise(() => listMemoryProposals(root, "pending"))

          expect(yield* llm.calls).toBe(2)
          expect(proposals).toHaveLength(1)
          expect(proposals[0]?.cwd).toBe(root)
          expect(proposals[0]?.text).toContain("non-git folders")
        } finally {
          if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
          else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        }
      }),
    { git: false, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const stop = Date.now() + 500
          while (Date.now() < stop) {
            const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")
            if (text?.time?.start) return
            await Bun.sleep(10)
          }
          throw new Error("timed out waiting for text part")
        })
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = MessageV2.parts(msg.id).find((part): part is MessageV2.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry idle llm streams instead of staying busy", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = "25"
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().hang(), reply().text("recovered").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "recover")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "recover" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests discard abandoned attempt parts before retry", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = "25"
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          reply().text("stale partial attempt").hang(),
          reply().text("recovered after retry").stop(),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "run slow command")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "run slow command" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "recovered after retry")).toBe(true)
        expect(parts.some((part) => part.type === "text" && part.text === "stale partial attempt")).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests keep question toolcalls pending across idle stream timeout", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = "25"
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("question", {
          questions: [
            {
              header: "Decision",
              question: "Choose a path",
              options: [{ label: "Continue", description: "Keep waiting for the user" }],
            },
          ],
        })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "ask")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "ask" }],
            tools: { question: neverTool("Ask a question") },
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Effect.sleep("100 millis")

        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(yield* llm.calls).toBe(1)
        expect(call?.tool).toBe("question")
        expect(call?.state.status).toBe("running")
        yield* Fiber.interrupt(run)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests keep permission toolcalls pending across idle stream timeout", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = "500"
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("bash", { command: "echo waiting" })

        const chat = yield* session.create({
          permission: [{ permission: "*", pattern: "*", action: "ask" }],
        })
        const parent = yield* user(chat.id, "run")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "run" }],
            tools: { bash: neverTool("Run a shell command") },
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const permission = yield* Permission.Service
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            if (MessageV2.parts(msg.id).some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(call?.callID).toBeDefined()

        const pending = yield* permission
          .ask({
            sessionID: chat.id,
            permission: "bash",
            patterns: ["echo waiting"],
            always: ["*"],
            metadata: {},
            tool: { messageID: msg.id, callID: call!.callID },
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          })
          .pipe(Effect.forkScoped)

        yield* Effect.sleep("650 millis")
        const requests = yield* permission.list()

        expect(yield* llm.calls).toBe(1)
        expect(requests.some((request) => request.tool?.callID === call?.callID)).toBe(true)
        expect(call?.tool).toBe("bash")
        expect(call?.state.status).toBe("running")
        yield* Fiber.interrupt(pending)
        yield* Fiber.interrupt(run)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests keep plan review toolcalls pending across idle stream timeout", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = "500"
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("plan_review", {
          title: "Profile Bundle v2",
          markdown: "# Profile Bundle v2\n\n- Review the plan before edits.",
        })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "preview plan")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "preview plan" }],
            tools: { plan_review: neverTool("Show plan review") },
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        const planReview = yield* PlanReview.Service
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            if (MessageV2.parts(msg.id).some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(call?.callID).toBeDefined()

        const pending = yield* planReview
          .ask({
            sessionID: chat.id,
            title: "Profile Bundle v2",
            markdown: "# Profile Bundle v2\n\n- Review the plan before edits.",
            tool: { messageID: msg.id, callID: call!.callID },
          })
          .pipe(Effect.forkScoped)

        yield* Effect.sleep("650 millis")
        const requests = yield* planReview.list()

        expect(yield* llm.calls).toBe(1)
        expect(requests.some((request) => request.tool?.callID === call?.callID)).toBe(true)
        expect(call?.tool).toBe("plan_review")
        expect(call?.state.status).toBe("running")
        yield* Fiber.interrupt(pending)
        yield* Fiber.interrupt(run)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = "25"
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.attempt)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        off()

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests defer retry to prompt loop after persisted tool output", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().streamError(new Error("LLM stream timed out after 250ms without events")))
        yield* llm.push(reply().text("should not be used").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "flash the device")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: chat.id,
          type: "tool",
          callID: "call_long_command",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "sleep 120 && flash-device" },
            output: "Writing at 0x00120800... 100%\nVerifying written data... interrupted after provider retry",
            title: "sleep 120 && flash-device",
            metadata: {},
            time: { start: Date.now() - 1_000, end: Date.now() },
          },
        })
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "flash the device" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const currentStatus = yield* SessionStatus.Service.use((svc) => svc.get(chat.id))

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(currentStatus.type).toBe("busy")
        expect(parts.some((part) => part.type === "text" && part.text.includes("should not be used"))).toBe(false)
        expect(
          parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "bash" &&
              part.state.status === "completed" &&
              part.state.output.includes("Verifying written data"),
          ),
        ).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests preserve visible text and tool attempt on retryable stream error", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          reply()
            .text("Voy a ejecutar la compilacion larga.")
            .pendingTool("bash", { command: "pnpm build:windows --target production --verbose" })
            .streamError(new Error("Network connection lost")),
        )
        yield* llm.push(reply().text("should not be used").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compila windows")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compila windows" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const currentStatus = yield* SessionStatus.Service.use((svc) => svc.get(chat.id))

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(currentStatus.type).toBe("busy")
        expect(parts.some((part) => part.type === "text" && part.text.includes("compilacion larga"))).toBe(true)
        expect(
          parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "bash" &&
              JSON.stringify(part.state).includes("pnpm build:windows"),
          ),
        ).toBe(true)
        expect(parts.some((part) => part.type === "text" && part.text.includes("should not be used"))).toBe(false)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry silent provider streams", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS = "25"
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service

        yield* llm.push(reply().hang(), reply().text("after reconnect").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "silent stream")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: string[] = []
        const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (evt.properties.status.type === "retry") states.push(evt.properties.status.message)
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "silent stream" }],
          tools: {},
        })

        off()
        const parts = MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states.length).toBeGreaterThan(0)
        expect(parts.some((part) => part.type === "text" && part.text === "after reconnect")).toBe(true)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Effect.promise(async () => {
          const end = Date.now() + 500
          while (Date.now() < end) {
            const parts = await MessageV2.parts(msg.id)
            if (parts.some((part) => part.type === "tool")) return
            await Bun.sleep(10)
          }
        })
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution interrupted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retain pending task tools with child sessions on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("task", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        })

        const chat = yield* session.create({})
        const child = yield* session.create({
          parentID: chat.id,
          title: "inspect bug (@general subagent)",
          agent: "general",
        })
        const childParent = yield* user(child.id, "look into the cache key path")
        const childAssistant = yield* assistant(child.id, childParent.id, path.resolve(dir))
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: childAssistant.id,
          sessionID: child.id,
          type: "text",
          text: "partial child investigation",
        })

        const parent = yield* user(chat.id, "tool retain")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool retain" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        for (let i = 0; i < 50; i++) {
          const parts = MessageV2.parts(msg.id)
          const part = parts.find((item): item is MessageV2.ToolPart => item.type === "tool")
          if (part) {
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                metadata: {
                  ...("metadata" in part.state && part.state.metadata ? part.state.metadata : {}),
                  sessionId: child.id,
                },
              },
            })
            break
          }
          yield* Effect.sleep("10 millis")
        }
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = MessageV2.parts(msg.id)
        const call = parts.find((part): part is MessageV2.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("completed")
        if (call?.state.status === "completed") {
          expect(call.state.metadata.status).toBe("retained")
          expect(call.state.output).toContain(`task_id: ${child.id}`)
          expect(call.state.output).toContain("task_status: retained")
          expect(call.state.output).toContain("partial child investigation")
          expect(call.state.output).not.toContain("interrupted")
        }
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const bus = yield* Bus.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const controller = new AbortController()
        const errs: string[] = []
        const off = yield* bus.subscribeCallback(Session.Event.Error, (evt) => {
          if (evt.properties.sessionID !== chat.id) return
          if (!evt.properties.error) return
          errs.push(evt.properties.error.name)
          seen.resolve()
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          abort: controller.signal,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        controller.abort()
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        off()

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error).toBeUndefined()
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error).toBeUndefined()
        }
        expect(state?.type).toBe("busy")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)
