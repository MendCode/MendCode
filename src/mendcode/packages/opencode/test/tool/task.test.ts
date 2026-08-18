import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { BUSY_STATUS_STALE_MS, SessionStatus } from "@/session/status"
import { BackgroundTask } from "@/session/background-task"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Provider } from "@/provider/provider"
import { normalizeSubagentType, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { taskState, TaskStatusTool } from "../../src/tool/task-status"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function model(providerID: ProviderID, modelID: ModelID): Provider.Model {
  return {
    id: modelID,
    providerID,
    api: { id: modelID, npm: "@ai-sdk/openai-compatible", url: "https://example.com/v1" },
    name: modelID,
    capabilities: {
      attachment: false,
      reasoning: false,
      temperature: true,
      toolcall: true,
      interleaved: false,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 16_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
    variants: { low: {}, high: {}, max: {} },
  }
}

const testProvider = Layer.mock(Provider.Service)({
  list: () =>
    Effect.succeed({
      [ref.providerID]: {
        id: ref.providerID,
        name: "Test",
        source: "config",
        env: [],
        options: {},
        models: {
          [ref.modelID]: model(ref.providerID, ref.modelID),
          explicit: model(ref.providerID, ModelID.make("explicit")),
          agent: model(ref.providerID, ModelID.make("agent")),
          subagent: model(ref.providerID, ModelID.make("subagent")),
        },
      },
    }),
  getProvider: (providerID) =>
    Effect.succeed({
      id: providerID,
      name: providerID,
      source: "config" as const,
      env: [],
      options: {},
      models: {},
    }),
  getModel: (providerID, modelID) => {
    if (providerID !== ref.providerID) return Effect.succeed(model(providerID, modelID))
    const known = new Set(["test-model", "explicit", "agent", "subagent"])
    if (!known.has(modelID)) return Effect.die(new Error(`Model not found: ${providerID}/${modelID}`))
    return Effect.succeed(model(providerID, modelID))
  },
  getLanguage: () => Effect.die("not implemented"),
  closest: () => Effect.succeed(undefined),
  getSmallModel: () => Effect.succeed(undefined),
  defaultModel: () => Effect.succeed(ref),
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    testProvider,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    BackgroundTask.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  test("normalizes repeated subagent prefixes from model input", () => {
    expect(normalizeSubagentType("sub/rust")).toBe("rust")
    expect(normalizeSubagentType("Sub/Sub/Security-Auditor")).toBe("Security-Auditor")
    expect(normalizeSubagentType("sub-code-reviewer")).toBe("code-reviewer")
  })

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
        expect(first).toContain("Optional subagent model selection:")
        expect(first).toContain("Available model examples:")
        expect(first).toContain("Pass model as provider/model-id and variant as a separate reasoning-effort name.")
        expect(first).toMatch(/^- .+ \(variants: .+\)$/m)
        expect(first).toContain("Do not use it for greetings")
        expect(first).toContain("Set `background: true`")
        expect(first).not.toContain("greeting-responder")
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`task_id: ${child.id}`)
      expect(seen?.sessionID).toBe(child.id)
    }),
  )

  it.instance("rejects nested task creation once the default depth is exhausted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const backgroundTasks = yield* BackgroundTask.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing parent" })
      const parentTask = yield* backgroundTasks.start({
        taskID: child.id,
        parentSessionID: chat.id,
        rootSessionID: chat.id,
        depth: 1,
        startRunning: true,
        title: "Existing parent",
        agent: "general",
      })
      const childAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: assistant.id,
        sessionID: child.id,
        mode: "general",
        agent: "general",
      } satisfies MessageV2.Assistant)
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "nested task",
            prompt: "delegate once more",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: childAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      yield* backgroundTasks.finish({ taskID: child.id, generation: parentTask.generation, state: "completed" })
    }),
  )

  it.instance(
    "allows one nested level when configured and reports the durable tree metadata",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const backgroundTasks = yield* BackgroundTask.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing parent" })
        const parentTask = yield* backgroundTasks.start({
          taskID: child.id,
          parentSessionID: chat.id,
          rootSessionID: chat.id,
          depth: 1,
          startRunning: true,
          title: "Existing parent",
          agent: "general",
        })
        const childAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: assistant.id,
          sessionID: child.id,
          mode: "general",
          agent: "general",
        } satisfies MessageV2.Assistant)
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const result = yield* def.execute(
          {
            description: "nested task",
            prompt: "delegate once more",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: childAssistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps({ text: "nested result" }) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.metadata.depth).toBe(2)
        expect(result.output).toContain("task_status: completed")
        yield* backgroundTasks.finish({ taskID: child.id, generation: parentTask.generation, state: "completed" })
      }),
    { config: { experimental: { subagent_depth: 2 } } },
  )

  it.instance("execute marks parent as waiting for subagent with a non-stale TTL", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<void>()
      const done = defer<void>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve()
            return done.promise
          }).pipe(Effect.as(reply(input, "finished child"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Effect.promise(() => ready.promise)
      const waiting = yield* status.get(chat.id)
      expect(waiting).toMatchObject({ type: "busy", kind: "subagent-wait", message: "Waiting for general subagent..." })
      if (waiting.type === "busy") expect(waiting.until).toBeGreaterThan(Date.now() + BUSY_STATUS_STALE_MS)

      done.resolve()
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* status.get(chat.id)).toMatchObject({ type: "busy" })
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute strips subagent prefixes before permission and lookup", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "sub/sub/general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        patterns: ["general"],
        metadata: { subagent_type: "general" },
      })
      expect(seen?.agent).toBe("general")
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/test-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute does not cancel child session when abort signal is not a user cancel", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const done = defer<void>()
      const abort = new AbortController()
      let cancelled = false
      const promptOps: TaskPromptOps = {
        cancel: () =>
          Effect.sync(() => {
            cancelled = true
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return done.promise
          }).pipe(Effect.as(reply(input, "retained child result"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/test-model",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps, abortReason: () => undefined },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Effect.promise(() => ready.promise)
      abort.abort()
      yield* Effect.sleep("10 millis")
      expect(cancelled).toBe(false)
      done.resolve()

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.output).toContain("task_status: retained")
        expect(exit.value.output).toContain("Connection interrupted; subagent session retained")
        expect(exit.value.output).toContain("Parent execution stopped before the subagent finished")
        expect(exit.value.output).not.toContain("task_status: failed")
        expect(exit.value.output).not.toContain("task_status: interrupted")
      }
    }),
  )

  it.instance("execute does not cancel child session when task effect is interrupted without abort signal", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<void>()
      let cancelled = false
      const promptOps: TaskPromptOps = {
        cancel: () =>
          Effect.sync(() => {
            cancelled = true
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: () =>
          Effect.gen(function* () {
            ready.resolve()
            return yield* Effect.never
          }),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Effect.promise(() => ready.promise)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(cancelled).toBe(false)
    }),
  )

  it.instance("execute includes child evidence when final subagent reply is generic", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const messageID = MessageID.ascending()
            yield* sessions.updateMessage({
              id: messageID,
              role: "assistant",
              parentID: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              mode: input.agent ?? "general",
              agent: input.agent ?? "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? ref.modelID,
              providerID: input.model?.providerID ?? ref.providerID,
              time: { created: Date.now() },
              finish: "tool-calls",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID,
              sessionID: input.sessionID,
              type: "text",
              text: "Mapped FB10 fact-sheet schema, reusable cache artifacts, and tests.",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID,
              sessionID: input.sessionID,
              type: "patch",
              hash: "abc123",
              files: ["/tmp/project/.agents/orchestration/CHAT.md"],
            })
            return reply(input, "Listo.")
          }),
      }

      const result = yield* def.execute(
        {
          description: "explore fact sheet",
          prompt: "map patterns",
          subagent_type: "general",
          model: "test/test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("task_status: completed")
      expect(result.output).toContain("Listo.")
      expect(result.output).toContain("Subagent session evidence:")
      expect(result.output).toContain("Mapped FB10 fact-sheet schema")
      expect(result.output).toContain("Subagent changed files:")
      expect(result.output).toContain("/tmp/project/.agents/orchestration/CHAT.md")
    }),
  )

  it.instance("execute includes orchestration artifact contents when subagent writes CHAT", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const root = path.join("/tmp", `mendcode-task-artifact-${Date.now()}`)
      const artifactDir = path.join(root, ".agents", "orchestration")
      const chatPath = path.join(artifactDir, "CHAT.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(artifactDir, { recursive: true })
        await Bun.write(chatPath, "### worker-1 -> ALL\n**Result**: full worker result visible to parent")
      })
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const messageID = MessageID.ascending()
            yield* sessions.updateMessage({
              id: messageID,
              role: "assistant",
              parentID: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              mode: input.agent ?? "general",
              agent: input.agent ?? "general",
              cost: 0,
              path: { cwd: root, root },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? ref.modelID,
              providerID: input.model?.providerID ?? ref.providerID,
              time: { created: Date.now() },
              finish: "tool-calls",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID,
              sessionID: input.sessionID,
              type: "patch",
              hash: "artifact",
              files: [chatPath],
            })
            return reply(input, "done")
          }),
      }

      const result = yield* def.execute(
        {
          description: "read artifact",
          prompt: "write full result to .agents/orchestration/CHAT.md",
          subagent_type: "general",
          model: "test/test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("Subagent orchestration artifacts:")
      expect(result.output).toContain("--- .agents/orchestration/CHAT.md ---")
      expect(result.output).toContain("full worker result visible to parent")
    }),
  )

  it.instance("execute does not read orchestration artifacts based only on mentioned paths", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const root = path.join("/tmp", `mendcode-task-artifact-mention-${Date.now()}`)
      const artifactDir = path.join(root, ".agents", "orchestration")
      const chatPath = path.join(artifactDir, "CHAT.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(artifactDir, { recursive: true })
        await Bun.write(chatPath, "### stale worker output that should stay private")
      })
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const messageID = MessageID.ascending()
            yield* sessions.updateMessage({
              id: messageID,
              role: "user",
              sessionID: input.sessionID,
              agent: input.agent ?? "general",
              model: input.model ?? ref,
              path: { cwd: root, root },
              time: { created: Date.now() },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID,
              sessionID: input.sessionID,
              type: "text",
              text: "Please summarize .agents/orchestration/CHAT.md when you finish.",
            })
            return reply(input, "done")
          }),
      }

      const result = yield* def.execute(
        {
          description: "read artifact",
          prompt: "mention artifact path only",
          subagent_type: "general",
          model: "test/test-model",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).not.toContain("Subagent orchestration artifacts:")
      expect(result.output).not.toContain("stale worker output that should stay private")
      expect(result.output).toContain("<task_result>\ndone\n</task_result>")
    }),
  )

  it.instance("execute returns partial child output when the subagent aborts internally after writing text", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const messageID = MessageID.ascending()
            yield* sessions.updateMessage({
              id: messageID,
              role: "assistant",
              parentID: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              mode: input.agent ?? "general",
              agent: input.agent ?? "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? ref.modelID,
              providerID: input.model?.providerID ?? ref.providerID,
              time: { created: Date.now() },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID,
              sessionID: input.sessionID,
              type: "text",
              text: "partial investigation result",
            })
            return yield* Effect.die(new DOMException("Aborted", "AbortError"))
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      expect(result.output).toContain("task_status: failed")
      expect(result.output).toContain("task_error: Aborted")
      expect(result.output).toContain("partial investigation result")
      expect(result.metadata.status).toBe("failed")
    }),
  )

  it.instance("execute marks an aborted child result as interrupted instead of completed empty output", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.gen(function* () {
            const partialMessageID = MessageID.ascending()
            yield* sessions.updateMessage({
              id: partialMessageID,
              role: "assistant",
              parentID: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              mode: input.agent ?? "general",
              agent: input.agent ?? "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? ref.modelID,
              providerID: input.model?.providerID ?? ref.providerID,
              time: { created: Date.now() },
              finish: "stop",
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: partialMessageID,
              sessionID: input.sessionID,
              type: "text",
              text: "saved child text before abort",
            })

            const abortedMessageID = MessageID.ascending()
            return {
              info: {
                id: abortedMessageID,
                role: "assistant",
                parentID: partialMessageID,
                sessionID: input.sessionID,
                mode: input.agent ?? "general",
                agent: input.agent ?? "general",
                cost: 0,
                path: { cwd: "/tmp", root: "/tmp" },
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: input.model?.modelID ?? ref.modelID,
                providerID: input.model?.providerID ?? ref.providerID,
                time: { created: Date.now() },
                error: new MessageV2.AbortedError({ message: "Aborted" }).toObject(),
              },
              parts: [],
            }
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("task_status: interrupted")
      expect(result.output).toContain("saved child text before abort")
      expect(result.output).not.toContain("task_status: completed")
      expect(result.metadata.status).toBe("interrupted")
    }),
  )

  it.instance("execute interrupts a child response without a terminal finish", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const tasks = yield* BackgroundTask.Service
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          const messageID = MessageID.ascending()
          return Effect.succeed({
            info: {
              id: messageID,
              role: "assistant",
              parentID: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              mode: input.agent ?? "general",
              agent: input.agent ?? "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? ref.modelID,
              providerID: input.model?.providerID ?? ref.providerID,
              time: { created: Date.now(), completed: Date.now() },
            },
            parts: [
              {
                id: PartID.ascending(),
                messageID,
                sessionID: input.sessionID,
                type: "text" as const,
                text: "partial result without a finish marker",
              },
            ],
          })
        },
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("task_status: interrupted")
      expect(result.output).toContain("Subagent response ended without a terminal finish")
      expect(result.output).toContain("partial result without a finish marker")
      expect(result.metadata.status).toBe("interrupted")
      expect((yield* tasks.get(SessionID.make(result.metadata.sessionId)))?.state).toBe("interrupted")
    }),
  )

  test("task status treats a completed assistant without finish as interrupted", () => {
    const message = reply(
      { sessionID: SessionID.make("ses_task_status_partial"), parts: [], agent: "general" },
      "partial result",
    )
    if (message.info.role === "assistant") {
      message.info.finish = undefined
      message.info.time.completed = Date.now()
    }

    expect(taskState({ status: { type: "idle" }, messages: [message] })).toBe("interrupted")
  })

  it.instance("execute includes returned child parts when child message ends with error", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          const messageID = MessageID.ascending()
          return Effect.succeed({
            info: {
              id: messageID,
              role: "assistant",
              parentID: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              mode: input.agent ?? "general",
              agent: input.agent ?? "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? ref.modelID,
              providerID: input.model?.providerID ?? ref.providerID,
              time: { created: Date.now() },
              error: new MessageV2.APIError({ message: "child failed", isRetryable: false }).toObject(),
            },
            parts: [
              {
                id: PartID.ascending(),
                messageID,
                sessionID: input.sessionID,
                type: "text" as const,
                text: "returned child evidence despite error",
              },
            ],
          })
        },
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("task_status: failed")
      expect(result.output).toContain("returned child evidence despite error")
      expect(result.metadata.status).toBe("failed")
    }),
  )

  it.instance("execute reports retryable child provider errors as failed, not interrupted", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.succeed({
            info: {
              id: MessageID.ascending(),
              role: "assistant",
              parentID: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              mode: input.agent ?? "general",
              agent: input.agent ?? "general",
              cost: 0,
              path: { cwd: "/tmp", root: "/tmp" },
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: input.model?.modelID ?? ref.modelID,
              providerID: input.model?.providerID ?? ref.providerID,
              time: { created: Date.now() },
              error: new MessageV2.APIError({ message: "Network connection lost", isRetryable: true }).toObject(),
            },
            parts: [],
          }),
      }

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("task_status: failed")
      expect(result.output).toContain("task_error: Network connection lost")
      expect(result.output).not.toContain("task_status: interrupted")
      expect(result.metadata.status).toBe("failed")
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "execute uses explicit task model over all configured defaults",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/explicit",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("explicit") })
        expect(result.metadata.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("explicit") })
      }),
    {
      config: {
        subagent_model: "test/subagent",
        agent: {
          general: {
            model: "test/agent",
          },
        },
      },
    },
  )

  it.instance("execute applies explicit reasoning variant", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect deeply",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model: "test/explicit",
          variant: "max",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("explicit") })
      expect(seen?.variant).toBe("max")
      expect(result.metadata.variant).toBe("max")
    }),
  )

  it.instance("execute accepts model hash variant shorthand", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "inspect deeply",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model: "test/explicit#max",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(seen?.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("explicit") })
      expect(seen?.variant).toBe("max")
    }),
  )

  it.instance("execute rejects unsupported variant before creating child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect deeply",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/explicit",
            variant: "ultra",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.pretty(exit.cause)).toContain('Variant "ultra" is not available for test/explicit')
      expect(Cause.pretty(exit.cause)).toContain("Available variants: low, high, max")
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "execute uses agent model over subagent_model",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("agent") })
        expect(seen?.variant).toBe("high")
        expect(result.metadata.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("agent") })
      }),
    {
      config: {
        subagent_model: "test/subagent",
        agent: {
          general: {
            model: "test/agent",
            variant: "high",
          },
        },
      },
    },
  )

  it.instance(
    "execute uses subagent_model before parent chat model",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("subagent") })
        expect(seen?.variant).toBe("low")
        expect(result.metadata.model).toEqual({ providerID: ref.providerID, modelID: ModelID.make("subagent") })
      }),
    {
      config: {
        subagent_model: "test/subagent",
        subagent_variant: "low",
      },
    },
  )

  it.instance(
    "execute reports the resolved fallback model consistently",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "parent-model-agent",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(seen?.model).toEqual(result.metadata.model)
        expect(result.metadata.model).toBeDefined()
      }),
    {
      config: {
        agent: {
          "parent-model-agent": {
            description: "Parent model fallback test agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute rejects unavailable explicit task model", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/missing",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("execute validates the inherited parent model before creating a child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      yield* sessions.updateMessage({ ...assistant, modelID: ModelID.make("missing") })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "allow",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
          },
        ])
        expect(seen?.tools).toEqual({
          todowrite: false,
          bash: false,
          read: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<void>()
      const done = defer<void>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve()
            return done.promise
          }).pipe(Effect.as(reply(input, "background result"))),
      }

      const result = yield* def.execute(
        {
          description: "inspect in background",
          prompt: "inspect the cache path independently",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.status).toBe("started")
      expect(result.output).toContain(`task_status with task_id ${result.metadata.sessionId}`)
      expect(result.output).toContain("do not call task_status.wait")
      yield* Effect.promise(() => ready.promise)
      expect(yield* status.get(result.metadata.sessionId)).toMatchObject({ type: "busy" })
      expect(yield* status.get(chat.id)).toEqual({ type: "idle" })
      const statusTool = yield* TaskStatusTool
      const statusDef = yield* statusTool.init()
      const inspected = yield* statusDef.execute(
        { action: "get", task_id: result.metadata.sessionId },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(inspected.output).toContain("task_status: running")
      expect(inspected.output).toContain("task_source: registry")
      expect(inspected.output).toContain("task_generation: 1")
      done.resolve()
      const background = yield* BackgroundTask.Service
      const completed = yield* background.wait({ taskID: result.metadata.sessionId, timeoutMs: 2_000 })
      expect(completed).toMatchObject({
        timedOut: false,
        snapshot: {
          generation: 1,
          state: "completed",
          result: { summary: expect.stringContaining("background result") },
        },
      })
    }),
  )

  it.instance("task_status lists background tasks and collects their persisted result", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Background inspection", agent: "general" })
      const childAssistant: MessageV2.Assistant = {
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
        mode: "general",
        agent: "general",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(childAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: childAssistant.id,
        sessionID: child.id,
        type: "text",
        text: "Found the cache ownership bug.",
      })
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const ctx = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const listed = yield* def.execute({ action: "list" }, ctx)
      expect(listed.output).toContain(`task_id: ${child.id}`)
      expect(listed.output).toContain("status: completed")

      const result = yield* def.execute({ action: "get", task_id: child.id }, ctx)
      expect(result.metadata).toMatchObject({ sessionId: child.id, status: "completed" })
      expect(result.output).toContain("task_status: completed")
      expect(result.output).toContain("Found the cache ownership bug.")
    }),
  )

  it.instance("task_status cancels a registered background task idempotently", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const taskTool = yield* TaskTool
      const taskDef = yield* taskTool.init()
      const done = defer<void>()
      let cancels = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.sync(() => cancels++),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => Effect.promise(() => done.promise).pipe(Effect.as(reply(input, "late completion"))),
      }
      const ctx = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const launched = yield* taskDef.execute(
        {
          description: "cancel background work",
          prompt: "wait until cancelled",
          subagent_type: "general",
          background: true,
        },
        ctx,
      )
      const statusTool = yield* TaskStatusTool
      const statusDef = yield* statusTool.init()
      const first = yield* statusDef.execute({ action: "cancel", task_id: launched.metadata.sessionId }, ctx)
      const second = yield* statusDef.execute({ action: "cancel", task_id: launched.metadata.sessionId }, ctx)
      expect(cancels).toBe(1)
      expect(first.output).toContain("task_status: cancelled")
      expect(second.output).toContain("task_status: cancelled")
      done.resolve()
    }),
  )

  it.instance("task_status wait returns when the captured generation completes", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const taskTool = yield* TaskTool
      const taskDef = yield* taskTool.init()
      const done = defer<void>()
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => Effect.promise(() => done.promise).pipe(Effect.as(reply(input, "waited result"))),
      }
      const ctx = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const launched = yield* taskDef.execute(
        {
          description: "wait background work",
          prompt: "return after release",
          subagent_type: "general",
          background: true,
        },
        ctx,
      )
      const statusTool = yield* TaskStatusTool
      const statusDef = yield* statusTool.init()
      const scope = yield* Scope.Scope
      const waiting = yield* statusDef
        .execute({ action: "wait", task_id: launched.metadata.sessionId, timeout_ms: 2_000 }, ctx)
        .pipe(Effect.forkIn(scope))
      yield* Effect.sleep(10)
      done.resolve()
      const result = yield* Fiber.join(waiting)
      expect(result.output).toContain("task_status: completed")
      expect(result.output).toContain("wait_timed_out: false")
      expect(result.output).toContain("waited result")
    }),
  )

  it.instance("task_status reconciles a committed child result into the registry", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const background = yield* BackgroundTask.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Reconcile child", agent: "general" })
      const run = yield* background.start({
        taskID: child.id,
        parentSessionID: chat.id,
        title: "Reconcile child",
        agent: "general",
      })
      yield* background.markRunning({ taskID: child.id, generation: run.generation })
      const childUser: MessageV2.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID: child.id,
        agent: "general",
        model: ref,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(childUser)
      const childAssistant: MessageV2.Assistant = {
        ...assistant,
        id: MessageID.ascending(),
        parentID: childUser.id,
        sessionID: child.id,
        mode: "general",
        agent: "general",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      }
      yield* sessions.updateMessage(childAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: childAssistant.id,
        sessionID: child.id,
        type: "text",
        text: "Recovered committed result.",
      })

      const statusTool = yield* TaskStatusTool
      const statusDef = yield* statusTool.init()
      const result = yield* statusDef.execute(
        { action: "get", task_id: child.id },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.output).toContain("task_status: completed")
      expect(result.output).toContain("Recovered committed result.")
      expect((yield* background.get(child.id))?.state).toBe("completed")
    }),
  )

  it.instance("task_status does not present the child prompt as partial output", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Pending background task", agent: "general" })
      const childUser: MessageV2.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID: child.id,
        agent: "general",
        model: ref,
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(childUser)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: childUser.id,
        sessionID: child.id,
        type: "text",
        text: "private child instructions",
      })
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        { action: "get", task_id: child.id },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("task_status: waiting")
      expect(result.output).not.toContain("private child instructions")
    }),
  )
})
