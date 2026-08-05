import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@mendcode/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { defaultModelsConfig, writeModelsConfig } from "@/mend/config/models"
import { writeProjectMemoryConfig } from "@/mend/memory/config"
import { listMemoryProposals } from "@/mend/memory/proposals"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { PlanReview } from "../../src/plan-review"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable } from "../../src/session/session.sql"
import { BackgroundTaskEventTable, BackgroundTaskTable } from "../../src/session/background-task.sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import {
  SessionPrompt,
  shouldCheckFinishedAssistantForAutoCompaction,
  promptRunMessages,
  autoRescueCompactionCount,
  shouldResumeAfterActiveCompaction,
  shouldResumeAfterAutoCompaction,
  shouldResumeAfterAutoRescueCompaction,
  shouldPreflightPromptOverflow,
  shouldSkipAutoCompaction,
  ownerWakePromptText,
  interruptedToolPromptText,
  shouldContinueAfterCompactionStop,
} from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { BackgroundTask } from "../../src/session/background-task"
import { SessionV2 } from "../../src/v2/session"
import { Skill } from "../../src/skill"
import { LoopWorkflow } from "../../src/session/loop"
import { LoopRunner } from "../../src/session/loop-runner"
import { WorkflowService } from "../../src/session/workflow-service"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Auth } from "@/auth"
import * as Log from "@mendcode/core/util/log"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import * as Database from "../../src/storage/db"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

test("maps tool execution to bounded activity labels", () => {
  expect(SessionStatus.activityLabelForTool("read")).toBe("Inspecting files")
  expect(SessionStatus.activityLabelForTool("bash")).toBe("Running a command")
  expect(SessionStatus.activityLabelForTool("apply_patch")).toBe("Updating files")
  expect(SessionStatus.activityLabelForTool("task")).toBe("Working with a subagent")
  expect(SessionStatus.activityLabelForTool("custom_tool")).toBe("Working with a tool")
})

test("owner wake prompts are internal runtime context", () => {
  const taskID = SessionID.make("ses_owner_wake_task")
  const text = ownerWakePromptText([
    {
      eventID: "evt_owner_wake",
      taskID,
      parentSessionID: SessionID.make("ses_owner_wake_parent"),
      generation: 1,
      revision: 2,
      state: "completed",
      title: "Inspect cache",
      summary: "Cache is healthy.",
      background: true,
    },
  ])

  expect(text).toContain('<mendcode_runtime_event type="background_task">')
  expect(text).toContain(`task_id: ${taskID}`)
  expect(text).toContain("not a user request")
  expect(text).toContain("task_status")
  expect(text).toContain("Do not poll or wait")
})

test("interrupted tool prompts require a safe exact retry", () => {
  const user = promptUser([{ type: "text", id: PartID.ascending(), text: "run the checks" }])
  const assistant = promptAssistant(
    {
      id: MessageID.ascending(),
      finish: "tool-calls",
      summary: false,
      parentID: user.info.id,
    },
    [
      {
        id: PartID.ascending(),
        sessionID: user.info.sessionID,
        messageID: MessageID.ascending(),
        type: "tool",
        callID: "call-interrupted",
        tool: "shell",
        state: {
          status: "completed",
          input: { command: "bun typecheck" },
          output: "connection lost",
          title: "Run checks",
          metadata: { connectionLost: true, resultUnknown: true, retryRecommended: true },
          time: { start: Date.now(), end: Date.now() },
        },
      },
    ],
  )

  const text = interruptedToolPromptText([user, assistant])
  expect(text).toContain('<mendcode_runtime_event type="interrupted_tool">')
  expect(text).toContain("Treat that result as unknown")
  expect(text).toContain("retry that exact command once")
  expect(text).toContain("do not repeat destructive actions blindly")
})

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

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const bus = Bus.defaultLayer
const status = SessionStatus.layer.pipe(Layer.provide(bus))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
function makeHttp() {
  const deps = Layer.mergeAll(
    bus,
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
    BackgroundTask.layer.pipe(Layer.provide(bus)),
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const planReview = PlanReview.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(LoopWorkflow.defaultLayer),
    Layer.provide(LoopRunner.defaultLayer),
    Layer.provide(WorkflowService.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(planReview),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeHttp())
const unix = process.platform !== "win32" ? it.live : it.live.skip

type IdleRunnerControl = {
  started: Deferred.Deferred<void>
  release: Deferred.Deferred<void>
}

const idleRunnerControls = new Map<string, IdleRunnerControl>()
const controlledStatus = Layer.succeed(
  SessionStatus.Service,
  SessionStatus.Service.of({
    get: () => Effect.succeed({ type: "idle" as const }),
    list: () => Effect.succeed(new Map<SessionID, SessionStatus.Info>()),
    set: (sessionID, next) => {
      const control = idleRunnerControls.get(sessionID)
      if (!control || next.type !== "idle") return Effect.void
      return Effect.gen(function* () {
        yield* Deferred.succeed(control.started, undefined)
        yield* Deferred.await(control.release)
      })
    },
  }),
)
const runStateIt = testEffect(SessionRunState.layer.pipe(Layer.provide(controlledStatus)))

function promptUser(
  parts: Array<Omit<MessageV2.TextPart, "sessionID" | "messageID">>,
  id = MessageID.ascending(),
): MessageV2.WithParts {
  const sessionID = SessionID.make("test-session")
  return {
    info: {
      id,
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: "build",
      model: ref,
    },
    parts: parts.map((part) => ({ ...part, sessionID, messageID: id })),
  }
}

function promptAssistant(
  info: Pick<MessageV2.Assistant, "id" | "finish" | "summary" | "parentID">,
  parts: MessageV2.Part[] = [],
): MessageV2.WithParts {
  return {
    info: {
      id: info.id,
      role: "assistant",
      sessionID: SessionID.make("test-session"),
      time: { created: Date.now() },
      parentID: info.parentID,
      modelID: ref.modelID,
      providerID: ref.providerID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: info.finish,
      summary: info.summary,
    },
    parts,
  }
}

runStateIt.instance("cancels queued work with the active session", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses-run-state-cancel-queue")
    const started = yield* Deferred.make<void>()
    const fallback = promptAssistant({
      id: MessageID.ascending(),
      finish: "stop",
      summary: false,
      parentID: MessageID.ascending(),
    })
    const queuedResult = promptAssistant({
      id: MessageID.ascending(),
      finish: "stop",
      summary: false,
      parentID: MessageID.ascending(),
    })
    const active = yield* state
      .ensureRunning(
        sessionID,
        Effect.succeed(fallback),
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(started).pipe(Effect.timeout("1 second"))

    const queued = yield* state
      .ensureRunning(sessionID, Effect.succeed(fallback), Effect.succeed(queuedResult), { queue: true })
      .pipe(Effect.forkChild)
    yield* Effect.sleep("10 millis")

    yield* state.cancel(sessionID)

    expect((yield* Fiber.join(active)).info.id).toBe(fallback.info.id)
    const queuedValue = yield* Fiber.join(queued)
    expect(queuedValue.info.id).toBe(fallback.info.id)
    expect(queuedValue.info.id).not.toBe(queuedResult.info.id)
    expect(yield* state.isBusy(sessionID)).toBe(false)
  }),
)

runStateIt.instance("keeps the runner identity during idle cleanup", () =>
  Effect.gen(function* () {
    const state = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses-run-state-idle-race")
    const control = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    }
    const first = promptAssistant({
      id: MessageID.ascending(),
      finish: "stop",
      summary: false,
      parentID: MessageID.ascending(),
    })
    const firstFallback = promptAssistant({
      id: MessageID.ascending(),
      finish: "stop",
      summary: false,
      parentID: MessageID.ascending(),
    })
    const secondFallback = promptAssistant({
      id: MessageID.ascending(),
      finish: "stop",
      summary: false,
      parentID: MessageID.ascending(),
    })
    const second = promptAssistant({
      id: MessageID.ascending(),
      finish: "stop",
      summary: false,
      parentID: MessageID.ascending(),
    })
    const secondStarted = yield* Deferred.make<void>()
    const secondGate = yield* Deferred.make<void>()
    idleRunnerControls.set(sessionID, control)

    return yield* Effect.gen(function* () {
      const firstFiber = yield* state
        .ensureRunning(sessionID, Effect.succeed(firstFallback), Effect.succeed(first))
        .pipe(Effect.forkChild)
      yield* Deferred.await(control.started).pipe(Effect.timeout("1 second"))

      const secondFiber = yield* state
        .ensureRunning(
          sessionID,
          Effect.succeed(secondFallback),
          Effect.gen(function* () {
            yield* Deferred.succeed(secondStarted, undefined)
            yield* Deferred.await(secondGate)
            return second
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"))

      yield* Deferred.succeed(control.release, undefined)
      expect((yield* Fiber.join(firstFiber)).info.id).toBe(first.info.id)

      yield* state.interrupt(sessionID)
      expect((yield* Fiber.join(secondFiber)).info.id).toBe(firstFallback.info.id)
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.succeed(control.release, undefined)
          idleRunnerControls.delete(sessionID)
        }),
      ),
    )
  }),
)

function assistantInfo(
  input: Pick<MessageV2.Assistant, "id" | "finish" | "summary" | "parentID">,
): MessageV2.Assistant {
  return {
    id: input.id,
    role: "assistant",
    sessionID: SessionID.make("test-session"),
    time: { created: Date.now() },
    parentID: input.parentID,
    modelID: ref.modelID,
    providerID: ref.providerID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: input.finish,
    summary: input.summary,
  }
}

function userInfo(id = MessageID.ascending()): MessageV2.User {
  return {
    id,
    role: "user",
    sessionID: SessionID.make("test-session"),
    time: { created: Date.now() },
    agent: "build",
    model: ref,
  }
}

function compactionUser(discardTail: boolean, rescueAttempt?: number) {
  const info = userInfo()
  return {
    info,
    parts: [
      {
        id: PartID.ascending(),
        sessionID: info.sessionID,
        messageID: info.id,
        type: "compaction" as const,
        auto: true,
        overflow: true,
        resume: true,
        discard_tail: discardTail,
        rescue_attempt: rescueAttempt,
      },
    ],
  } satisfies MessageV2.WithParts
}

test("auto rescue compaction stops only after repeated rescues without progress", () => {
  const realUser = promptUser([{ type: "text", id: PartID.ascending(), text: "finish the request" }])
  const normalCompaction = compactionUser(false)
  const firstRescue = compactionUser(true, 1)
  const firstWork = promptAssistant({
    id: MessageID.ascending(),
    finish: "tool-calls",
    summary: false,
    parentID: realUser.info.id,
  })
  const secondRescue = compactionUser(true, 2)
  const secondWork = promptAssistant({
    id: MessageID.ascending(),
    finish: "tool-calls",
    summary: false,
    parentID: realUser.info.id,
  })
  const thirdRescue = compactionUser(true, 3)
  const thirdWork = promptAssistant({
    id: MessageID.ascending(),
    finish: "tool-calls",
    summary: false,
    parentID: realUser.info.id,
  })

  expect(autoRescueCompactionCount([realUser, normalCompaction])).toBe(0)
  expect(autoRescueCompactionCount([realUser, firstRescue])).toBe(1)
  expect(shouldResumeAfterAutoRescueCompaction([realUser, firstRescue])).toBe(true)
  expect(shouldResumeAfterAutoRescueCompaction([realUser, firstRescue, firstWork])).toBe(true)
  expect(autoRescueCompactionCount([realUser, firstRescue, firstWork, secondRescue])).toBe(2)
  expect(shouldResumeAfterAutoRescueCompaction([realUser, firstRescue, firstWork, secondRescue])).toBe(false)

  const afterSecondRescue = [realUser, firstRescue, firstWork, secondRescue, secondWork]
  expect(shouldResumeAfterAutoRescueCompaction(afterSecondRescue)).toBe(true)
  expect(autoRescueCompactionCount([...afterSecondRescue, thirdRescue])).toBe(3)
  expect(shouldResumeAfterAutoRescueCompaction([...afterSecondRescue, thirdRescue, thirdWork])).toBe(true)
})

test("auto compaction guard waits for real user input after a synthetic resume", () => {
  const oldUser = promptUser([{ type: "text", id: PartID.ascending(), text: "original request" }])
  const oldAssistant = promptAssistant({
    id: MessageID.ascending(),
    finish: "stop",
    summary: false,
    parentID: oldUser.info.id,
  })
  const summary = promptAssistant({
    id: MessageID.ascending(),
    finish: "stop",
    summary: true,
    parentID: oldUser.info.id,
  })
  const syntheticResume = promptUser([
    {
      type: "text",
      id: PartID.ascending(),
      text: "resume",
      synthetic: true,
      metadata: { compaction_continue: true },
    },
  ])
  const realUser = promptUser([{ type: "text", id: PartID.ascending(), text: "continue now" }])

  expect(shouldSkipAutoCompaction([summary, syntheticResume])).toBe(true)
  expect(shouldSkipAutoCompaction([summary, oldUser, oldAssistant, syntheticResume])).toBe(true)
  expect(shouldSkipAutoCompaction([summary, syntheticResume, realUser])).toBe(false)
})

test("auto compaction resumes only for active or incomplete assistant turns", () => {
  expect(shouldResumeAfterAutoCompaction(undefined)).toBe(true)
  expect(shouldResumeAfterAutoCompaction("tool-calls")).toBe(true)
  expect(shouldResumeAfterAutoCompaction("length")).toBe(true)
  expect(shouldResumeAfterAutoCompaction("unknown")).toBe(true)
  expect(shouldResumeAfterAutoCompaction("stop")).toBe(false)
  expect(shouldResumeAfterAutoCompaction("stop", true)).toBe(true)
})

test("active provider compaction resumes only unfinished turns", () => {
  expect(shouldResumeAfterActiveCompaction(undefined)).toBe(true)
  expect(shouldResumeAfterActiveCompaction("tool-calls")).toBe(true)
  expect(shouldResumeAfterActiveCompaction("length")).toBe(true)
  expect(shouldResumeAfterActiveCompaction("unknown")).toBe(true)
  expect(shouldResumeAfterActiveCompaction("stop")).toBe(false)
  expect(shouldResumeAfterActiveCompaction("stop", true)).toBe(true)
})

test("does not preflight an approximate prompt overflow below the configured threshold", () => {
  expect(
    shouldPreflightPromptOverflow({
      promptOverflow: true,
      promptTokens: 104,
      hardLimit: 100,
      previousContextAtThreshold: false,
    }),
  ).toBe(false)
  expect(
    shouldPreflightPromptOverflow({
      promptOverflow: true,
      promptTokens: 280_000,
      hardLimit: 272_000,
      previousContextAtThreshold: false,
    }),
  ).toBe(false)
  expect(
    shouldPreflightPromptOverflow({
      promptOverflow: true,
      promptTokens: 100,
      hardLimit: 100,
      previousContextAtThreshold: true,
    }),
  ).toBe(true)
  expect(shouldPreflightPromptOverflow({ promptOverflow: true, promptTokens: 100, hardLimit: 100 })).toBe(true)
  expect(
    shouldPreflightPromptOverflow({
      promptOverflow: true,
      promptTokens: 106,
      hardLimit: 100,
      previousContextAtThreshold: false,
    }),
  ).toBe(true)
  expect(
    shouldPreflightPromptOverflow({
      promptOverflow: false,
      promptTokens: 111,
      hardLimit: 100,
      previousContextAtThreshold: true,
    }),
  ).toBe(false)
})

test("auto compaction ignores a finished assistant that is older than queued user input", () => {
  const seedUser = userInfo()
  const olderAssistant = assistantInfo({
    id: MessageID.ascending(),
    finish: "stop",
    summary: false,
    parentID: seedUser.id,
  })
  const queuedUser = userInfo()
  const newerAssistant = assistantInfo({
    id: MessageID.ascending(),
    finish: "stop",
    summary: false,
    parentID: queuedUser.id,
  })
  const summaryAssistant = assistantInfo({
    id: MessageID.ascending(),
    finish: "stop",
    summary: true,
    parentID: queuedUser.id,
  })

  expect(shouldCheckFinishedAssistantForAutoCompaction({ lastUser: queuedUser, lastFinished: olderAssistant })).toBe(
    false,
  )
  expect(shouldCheckFinishedAssistantForAutoCompaction({ lastUser: queuedUser, lastFinished: newerAssistant })).toBe(
    true,
  )
  expect(shouldCheckFinishedAssistantForAutoCompaction({ lastUser: queuedUser, lastFinished: summaryAssistant })).toBe(
    false,
  )
})

test("queued prompt keeps its internal compaction chain instead of the latest internal user", () => {
  const activeUser = promptUser([{ type: "text", id: PartID.ascending(), text: "active" }])
  const activeAssistant = promptAssistant({
    id: MessageID.ascending(),
    finish: undefined,
    summary: false,
    parentID: activeUser.info.id,
  })
  const queuedUser = promptUser([{ type: "text", id: PartID.ascending(), text: "queued" }])
  const staleInternalUser = promptUser([
    {
      type: "text",
      id: PartID.ascending(),
      text: "stale active-run continuation",
      synthetic: true,
      metadata: { compaction_continue: true, compaction_parent_id: activeUser.info.id },
    },
  ])
  const staleInternalAssistant = promptAssistant({
    id: MessageID.ascending(),
    finish: "stop",
    summary: false,
    parentID: staleInternalUser.info.id,
  })
  const secondQueuedUser = promptUser([
    { type: "text", id: PartID.ascending(), text: "also queued" },
    { type: "text", id: PartID.ascending(), text: "editor context", synthetic: true },
  ])
  const compactionInfo = userInfo()
  const compactionUser: MessageV2.WithParts = {
    info: compactionInfo,
    parts: [
      {
        id: PartID.ascending(),
        sessionID: SessionID.make("test-session"),
        messageID: compactionInfo.id,
        type: "compaction",
        auto: true,
        overflow: true,
        resume: true,
      },
    ],
  }
  const compactionAssistant = promptAssistant({
    id: MessageID.ascending(),
    finish: "stop",
    summary: true,
    parentID: compactionUser.info.id,
  })
  const initial = new Set([
    activeUser.info.id,
    activeAssistant.info.id,
    queuedUser.info.id,
    staleInternalUser.info.id,
    staleInternalAssistant.info.id,
    secondQueuedUser.info.id,
  ])

  const selected = promptRunMessages({
    messages: [
      activeUser,
      activeAssistant,
      queuedUser,
      staleInternalUser,
      staleInternalAssistant,
      secondQueuedUser,
      compactionUser,
      compactionAssistant,
    ],
    targetMessageID: queuedUser.info.id,
    initialMessageIDs: initial,
  })

  expect(selected.map((message) => message.info.id)).toEqual([
    activeUser.info.id,
    activeAssistant.info.id,
    queuedUser.info.id,
    secondQueuedUser.info.id,
    compactionUser.info.id,
    compactionAssistant.info.id,
  ])
})

test("a queued target continues after an older interrupted compaction stops", () => {
  const compactionUser = promptUser([{ type: "text", id: PartID.ascending(), text: "compact" }])
  const queuedUser = promptUser([{ type: "text", id: PartID.ascending(), text: "queued" }])

  expect(
    shouldContinueAfterCompactionStop({
      messages: [compactionUser, queuedUser],
      targetMessageID: queuedUser.info.id,
      compactionParentID: compactionUser.info.id,
    }),
  ).toBe(true)
  expect(
    shouldContinueAfterCompactionStop({
      messages: [compactionUser, queuedUser],
      targetMessageID: compactionUser.info.id,
      compactionParentID: compactionUser.info.id,
    }),
  ).toBe(false)
})

test("queued prompts wait for the active response unless after-tools is configured", () => {
  const activeUser = promptUser([{ type: "text", id: PartID.ascending(), text: "active" }])
  const activeAssistant = promptAssistant({
    id: MessageID.ascending(),
    finish: "tool-calls",
    summary: false,
    parentID: activeUser.info.id,
  })
  const queuedUser = promptUser([{ type: "text", id: PartID.ascending(), text: "queued" }])
  const messages = [activeUser, activeAssistant, queuedUser]
  const initialMessageIDs = new Set([activeUser.info.id, activeAssistant.info.id])

  expect(
    promptRunMessages({ messages, targetMessageID: activeUser.info.id, initialMessageIDs }).map(
      (message) => message.info.id,
    ),
  ).toEqual([activeUser.info.id, activeAssistant.info.id])
  expect(
    promptRunMessages({
      messages,
      targetMessageID: activeUser.info.id,
      initialMessageIDs,
      includeQueuedUserMessages: true,
    }).map((message) => message.info.id),
  ).toEqual([activeUser.info.id, activeAssistant.info.id, queuedUser.info.id])
  expect(
    promptRunMessages({ messages, targetMessageID: MessageID.ascending(), initialMessageIDs }).map(
      (message) => message.info.id,
    ),
  ).toEqual([activeUser.info.id, activeAssistant.info.id])
  expect(promptRunMessages({ messages, initialMessageIDs }).map((message) => message.info.id)).toEqual([
    activeUser.info.id,
    activeAssistant.info.id,
  ])
})

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
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

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string; text?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, opts?.text ?? "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

it.live("cancel finalizes an orphaned unfinished assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const msg = yield* user(chat.id, "hello")
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: msg.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      } satisfies MessageV2.Assistant)
      const tool = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "orphaned-tool",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "sleep 60" },
          title: "Run command",
          time: { start: Date.now() },
        },
      } satisfies MessageV2.ToolPart)

      yield* prompt.cancel(chat.id)

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const repairedMessage = messages.find((item) => item.info.id === assistant.id)
      const repaired = repairedMessage?.info
      expect(repaired?.role).toBe("assistant")
      if (repaired?.role !== "assistant") return
      expect(repaired.time.completed).toBeNumber()
      expect(repaired.finish).toBe("error")
      expect(repaired.error?.name).toBe("MessageAbortedError")
      const repairedTool = repairedMessage?.parts.find((part) => part.id === tool.id)
      expect(repairedTool?.type).toBe("tool")
      if (repairedTool?.type !== "tool") return
      expect(repairedTool.state.status).toBe("error")
      if (repairedTool.state.status !== "error") return
      expect(repairedTool.state.error).toBe("Cancelled")
      expect(repairedTool.state.time.end).toBeNumber()
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("cancel only finalizes the targeted orphaned assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const firstUser = yield* user(chat.id, "first")
      const firstAssistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: firstUser.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() - 1_000 },
      } satisfies MessageV2.Assistant)
      const secondUser = yield* user(chat.id, "second")
      const secondAssistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: secondUser.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
      } satisfies MessageV2.Assistant)

      yield* prompt.cancel(chat.id)

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const older = messages.find((item) => item.info.id === firstAssistant.id)?.info
      const targeted = messages.find((item) => item.info.id === secondAssistant.id)?.info
      expect(older?.role).toBe("assistant")
      expect(targeted?.role).toBe("assistant")
      if (older?.role !== "assistant" || targeted?.role !== "assistant") return
      expect(older.time.completed).toBeUndefined()
      expect(older.finish).toBeUndefined()
      expect(targeted.time.completed).toBeNumber()
      expect(targeted.finish).toBe("error")
      expect(targeted.error?.name).toBe("MessageAbortedError")
    }),
    { git: true, config: providerCfg },
  ),
)

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

it.live("wakes an idle parent by default for a background task", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Owner wake parent" })
      yield* llm.text("parent ready")
      yield* prompt.prompt({
        sessionID: parent.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "start" }],
      })
      yield* llm.reset
      const child = yield* sessions.create({ parentID: parent.id, title: "Inspect cache", agent: "general" })
      const run = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        title: "Inspect cache",
        agent: "general",
        startRunning: true,
      })
      yield* llm.text("wake acknowledged")
      yield* tasks.finish({
        taskID: child.id,
        generation: run.generation,
        state: "completed",
        background: true,
        result: { summary: "Cache is healthy." },
      })
      const events = Database.use((db) => db.select().from(BackgroundTaskEventTable).all())
      expect(events.at(-1)?.payload).toMatchObject({ background: true })
      yield* Effect.sleep(500)

      expect(yield* llm.calls).toBe(1)
      const messages = yield* sessions.messages({ sessionID: parent.id })
      expect(
        messages.some(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.synthetic === true && part.metadata?.kind === "background_task_owner_wake",
            ),
        ),
      ).toBe(true)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(BackgroundTaskEventTable)
            .where(Database.eq(BackgroundTaskEventTable.id, events.at(-1)!.id))
            .get(),
        )?.time_acknowledged,
      ).toBeNumber()
    }),
    {
      git: true,
      config: (url: string) => ({
        ...providerCfg(url),
      }),
    },
  ),
)

it.live("wakes an async parent by default for a background task", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const bus = yield* Bus.Service
      const ownerWakeIDs: string[] = []
      const off = yield* bus.subscribeCallback(BackgroundTask.Event.OwnerWake, (event) => {
        ownerWakeIDs.push(event.properties.wakeID)
      })
      const parent = yield* sessions.create({ title: "Async owner wake parent" })
      yield* llm.text("parent ready")
      yield* prompt.promptAsync({
        sessionID: parent.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "start" }],
      })

      const child = yield* sessions.create({ parentID: parent.id, title: "Inspect cache", agent: "general" })
      const run = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        title: "Inspect cache",
        agent: "general",
        startRunning: true,
      })
      yield* llm.text("wake acknowledged")
      yield* tasks.finish({
        taskID: child.id,
        generation: run.generation,
        state: "completed",
        background: true,
        result: { summary: "Cache is healthy." },
      })
      yield* Effect.sleep(500)
      off()

      expect(ownerWakeIDs).toHaveLength(1)
      expect(yield* llm.calls).toBe(2)
      const messages = yield* sessions.messages({ sessionID: parent.id })
      expect(
        messages.some(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.synthetic === true && part.metadata?.kind === "background_task_owner_wake",
            ),
        ),
      ).toBe(true)
    }),
    {
      git: true,
      config: (url: string) => ({
        ...providerCfg(url),
      }),
    },
  ),
)

it.live("does not wake a parent after manual cancellation", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const tasks = yield* BackgroundTask.Service
      const parent = yield* sessions.create({ title: "Cancelled owner wake parent" })
      yield* llm.text("parent ready")
      yield* prompt.prompt({
        sessionID: parent.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "start" }],
      })

      const child = yield* sessions.create({ parentID: parent.id, title: "Inspect cache", agent: "general" })
      const run = yield* tasks.start({
        taskID: child.id,
        parentSessionID: parent.id,
        title: "Inspect cache",
        agent: "general",
        startRunning: true,
      })
      yield* prompt.cancel(parent.id)
      yield* tasks.finish({
        taskID: child.id,
        generation: run.generation,
        state: "completed",
        background: true,
        result: { summary: "Cache is healthy." },
      })
      yield* Effect.sleep(500)

      const messages = yield* sessions.messages({ sessionID: parent.id })
      expect(
        messages.some(
          (message) =>
            message.info.role === "user" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.synthetic === true && part.metadata?.kind === "background_task_owner_wake",
            ),
        ),
      ).toBe(false)
      expect(yield* llm.calls).toBe(1)
      expect(yield* tasks.pendingNotifications(parent.id)).toEqual([])
      expect(
        Database.use((db) =>
          db.select().from(BackgroundTaskTable).where(Database.eq(BackgroundTaskTable.task_id, child.id)).get(),
        )?.time_dismissed,
      ).toBeNumber()
    }),
    {
      git: true,
      config: (url: string) => ({
        ...providerCfg(url),
      }),
    },
  ),
)

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        variant: "low",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.variant).toBe("low")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("replays an already persisted prompt without duplicating the user turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const original = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "original request" }],
      })
      yield* llm.text("recovered response")

      const result = yield* prompt.prompt({
        sessionID: chat.id,
        messageID: original.info.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "must not replace the original" }],
      })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const users = messages.filter((message) => message.info.role === "user")

      expect(result.info.role).toBe("assistant")
      expect(yield* llm.hits).toHaveLength(1)
      expect(users).toHaveLength(1)
      expect(users[0]?.parts.some((part) => part.type === "text" && part.text === "original request")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("preflights oversized prompt and compacts before calling provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const marker = "END_MARKER_SHOULD_NOT_REACH_PROVIDER"
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: `${"x".repeat(240_000)}${marker}` }],
      })
      yield* llm.text("## Goal\n- rescued summary")

      const result = yield* prompt.loop({ sessionID: chat.id })
      const inputs = yield* llm.inputs
      const messages = yield* sessions.messages({ sessionID: chat.id })

      expect(result.info.role).toBe("assistant")
      expect(inputs.length).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(inputs[0])).not.toContain(marker)
      expect(messages.some((msg) => msg.parts.some((part) => part.type === "compaction" && part.auto))).toBe(true)
    }),
    {
      git: true,
      config: (url) => {
        const next = providerCfg(url)
        return {
          ...next,
          compaction: { auto: false },
          agent: {
            build: { model: "test/test-model" },
            compaction: { model: "test/test-model" },
          },
          provider: {
            ...next.provider,
            test: {
              ...next.provider.test,
              models: {
                ...next.provider.test.models,
                "test-model": {
                  ...next.provider.test.models["test-model"],
                  limit: { context: 60_000, output: 5_000 },
                },
              },
            },
          },
        }
      },
    },
  ),
)

it.live("resumes after auto-compaction of an incomplete assistant turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const request = "termina la migración y ejecuta la verificación enfocada"

      const { assistant } = yield* seed(chat.id, { finish: "tool-calls", text: request })

      assistant.tokens.input = 95_000

      yield* sessions.updateMessage(assistant)
      yield* llm.text("compaction summary")
      yield* llm.text("continued work")

      const result = yield* prompt.loop({ sessionID: chat.id })
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const inputs = yield* llm.inputs

      expect(result.parts.some((part) => part.type === "text" && part.text === "continued work")).toBe(true)
      expect(inputs.some((input) => JSON.stringify(input).includes(request))).toBe(true)
      expect(inputs.some((input) => JSON.stringify(input).includes("compaction summary"))).toBe(true)
      expect(inputs.some((input) => JSON.stringify(input).includes("Latest real user language hint: Spanish"))).toBe(
        true,
      )
      expect(
        messages.some(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.compaction_continue),
        ),
      ).toBe(true)

      expect(yield* llm.calls).toBe(2)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          build: { model: "test/test-model" },
          compaction: { model: "test/test-model" },
        },
      }),
    },
  ),
)

it.live("resumes automatic compaction when a stop response still has tool work", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const request = "termina la migración y ejecuta la verificación enfocada"
      const { assistant } = yield* seed(chat.id, { finish: "stop", text: request })

      assistant.tokens.input = 95_000
      yield* sessions.updateMessage(assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "call-1",
        tool: "shell",
        state: {
          status: "completed",
          input: { command: "git status" },
          output: "working tree status",
          title: "git status",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })
      yield* llm.text("compaction summary")
      yield* llm.text("continued work")

      const result = yield* prompt.loop({ sessionID: chat.id })
      const messages = yield* sessions.messages({ sessionID: chat.id })

      expect(result.parts.some((part) => part.type === "text" && part.text === "continued work")).toBe(true)
      expect(
        messages.some(
          (message) =>
            message.info.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.compaction_continue),
        ),
      ).toBe(true)
      expect(yield* llm.calls).toBe(2)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          build: { model: "test/test-model" },
          compaction: { model: "test/test-model" },
        },
      }),
    },
  ),
)

it.live("runs a prompt queued during compaction after the resumed turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const compaction = yield* SessionCompaction.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* user(chat.id, "active request")
      yield* compaction.create({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        auto: true,
        overflow: true,
        resume: true,
      })
      const gate = defer<void>()
      yield* llm.hold("compaction summary", gate.promise)

      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const compactionStatus = yield* status.get(chat.id)
      expect(compactionStatus).toEqual(
        expect.objectContaining({
          type: "busy",
          kind: "compaction",
          message: SessionStatus.SESSION_ACTIVITY_COMPACTION,
        }),
      )

      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued while compacting" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.text("resumed turn")
      yield* llm.text("queued turn")
      gate.resolve()

      const [firstResult, queuedResult] = yield* Effect.all([Fiber.join(first), Fiber.join(queued)])
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const queuedUser = messages.find(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === "queued while compacting"),
      )
      expect(firstResult.parts.some((part) => part.type === "text" && part.text === "resumed turn")).toBe(true)
      expect(queuedResult.parts.some((part) => part.type === "text" && part.text === "queued turn")).toBe(true)
      expect(queuedResult.info.agent).toBe("build")
      expect(queuedResult.info.summary).not.toBe(true)
      expect(queuedResult.info.role === "assistant" ? queuedResult.info.parentID : undefined).toBe(queuedUser?.info.id)
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("queued while compacting"))).toBe(true)
      expect(yield* llm.calls).toBe(3)
    }),
    {
      git: true,
      config: (url) => {
        const next = providerCfg(url)
        return {
          ...next,
          compaction: { auto: false },
          queue: { mode: "immediate" },
          agent: {
            build: { model: "test/test-model" },
            compaction: { model: "test/test-model" },
          },
        }
      },
    },
  ),
)

it.live("does not re-dispatch a completed response after active compaction", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.push(reply().text("active response").usage({ input: 95_000, output: 1 }).wait(gate.promise).stop())
      yield* llm.text("compaction summary")
      yield* llm.text("queued response")

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued after response" }],
        })
        .pipe(Effect.forkChild)
      gate.resolve()

      const [activeResult, queuedResult] = yield* Effect.all([Fiber.join(active), Fiber.join(queued)])
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const queuedUser = messages.find(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text === "queued after response"),
      )
      expect(activeResult.parts.some((part) => part.type === "text" && part.text === "compaction summary")).toBe(true)
      expect(queuedResult.parts.some((part) => part.type === "text" && part.text === "queued response")).toBe(true)
      expect(queuedResult.info.agent).toBe("build")
      expect(queuedResult.info.summary).not.toBe(true)
      expect(queuedResult.info.role === "assistant" ? queuedResult.info.parentID : undefined).toBe(queuedUser?.info.id)
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("queued after response"))).toBe(true)
      expect(yield* llm.calls).toBe(3)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          build: { model: "test/test-model" },
          compaction: { model: "test/test-model" },
        },
      }),
    },
  ),
)

it.live("default queue mode waits for the complete active response", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.push(reply().tool("glob", { pattern: "**/*.txt" }).wait(gate.promise))
      yield* llm.text("active response complete")
      yield* llm.text("queued response")

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request" }],
        })
        .pipe(Effect.forkChild)
      gate.resolve()

      const [activeResult, queuedResult] = yield* Effect.all([Fiber.join(active), Fiber.join(queued)])
      expect(activeResult.parts.some((part) => part.type === "text" && part.text === "active response complete")).toBe(
        true,
      )
      expect(queuedResult.parts.some((part) => part.type === "text" && part.text === "queued response")).toBe(true)
      expect(yield* llm.calls).toBe(3)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("promptAsync promotes an accepted queued prompt into its own turn", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Async queue",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.hold("active response", gate.promise)
      yield* llm.text("queued response")

      const active = yield* prompt.promptAsync({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "active request" }],
      })
      yield* llm.wait(1)

      const queued = yield* prompt.promptAsync({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "queued request" }],
      })
      gate.resolve()

      yield* Effect.gen(function* () {
        while (true) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          if (
            messages.some(
              (message) =>
                message.info.role === "assistant" &&
                message.info.parentID === active.info.id &&
                message.info.time.completed !== undefined,
            ) &&
            messages.some(
              (message) =>
                message.info.role === "assistant" &&
                message.info.parentID === queued.info.id &&
                message.info.time.completed !== undefined,
            )
          )
            return
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("2 seconds"))

      const messages = yield* sessions.messages({ sessionID: chat.id })
      const activeAssistant = messages.find(
        (message) => message.info.role === "assistant" && message.info.parentID === active.info.id,
      )
      const queuedAssistants = messages.filter(
        (message) => message.info.role === "assistant" && message.info.parentID === queued.info.id,
      )
      expect(activeAssistant?.parts.some((part) => part.type === "text" && part.text === "active response")).toBe(true)
      expect(queuedAssistants).toHaveLength(1)
      expect(queuedAssistants[0]?.parts.some((part) => part.type === "text" && part.text === "queued response")).toBe(
        true,
      )
      expect(yield* llm.calls).toBe(2)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("queued prompt runs after an interrupted manual compaction", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const compaction = yield* SessionCompaction.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted compaction queue",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("seed response")
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "seed request" }],
      })

      const gate = defer<void>()
      yield* llm.hold("partial summary", gate.promise)
      yield* llm.text("completed summary")
      yield* llm.text("queued response")
      yield* compaction.create({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        auto: false,
      })
      const compacting = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(2)

      const cancelling = yield* prompt.cancel(chat.id).pipe(Effect.forkChild)
      yield* Effect.sleep("5 millis")
      const queued = yield* prompt.promptAsync({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "queued request" }],
      })
      yield* Effect.sleep("20 millis")
      gate.resolve()
      yield* Fiber.join(cancelling).pipe(Effect.timeout("1 second"))
      yield* Fiber.join(compacting)

      yield* Effect.gen(function* () {
        while (true) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          if (
            messages.some(
              (message) =>
                message.info.role === "assistant" &&
                message.info.summary !== true &&
                message.info.parentID === queued.info.id &&
                message.info.time.completed !== undefined,
            )
          )
            return
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("2 seconds"))

      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(
        messages.some(
          (message) =>
            message.info.role === "assistant" &&
            message.info.summary !== true &&
            message.info.parentID === queued.info.id &&
            message.parts.some((part) => part.type === "text" && part.text === "queued response"),
        ),
      ).toBe(true)
      expect(yield* llm.calls).toBe(4)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("publishes bounded tool activity until the prompt returns to idle", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({
        title: "Activity",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const statuses: SessionStatus.Info[] = []

      const off = yield* bus.subscribeCallback(SessionStatus.Event.Status, (event) => {
        if (event.properties.sessionID === chat.id) statuses.push(event.properties.status)
      })

      yield* llm.push(reply().tool("glob", { pattern: "**/*.txt" }).item())
      yield* llm.text("done")

      const run = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "inspect" }],
        })
        .pipe(Effect.forkChild)

      yield* Effect.gen(function* () {
        while (!statuses.some((status) => status.type === "busy" && status.message === "Inspecting files")) {
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("1 second"))

      expect(statuses.some((status) => status.type === "busy" && status.message === "Inspecting files")).toBe(true)

      yield* Fiber.join(run)
      yield* Effect.gen(function* () {
        while (!statuses.some((status) => status.type === "idle")) {
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("1 second"))

      off()
      expect(statuses.some((status) => status.type === "idle")).toBe(true)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("runs distinct queued prompts in FIFO order", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.push(reply().tool("glob", { pattern: "**/*.txt" }).wait(gate.promise))
      yield* llm.text("active response complete")
      yield* llm.text("queued response one")
      yield* llm.text("queued response two")

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      const firstQueued = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request one" }],
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (true) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          if (
            messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "queued request one"),
            )
          )
            return
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("1 second"))
      const secondQueued = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request two" }],
        })
        .pipe(Effect.forkChild)
      gate.resolve()

      const [activeResult, firstResult, secondResult] = yield* Effect.all([
        Fiber.join(active),
        Fiber.join(firstQueued),
        Fiber.join(secondQueued),
      ])
      expect(activeResult.parts.some((part) => part.type === "text" && part.text === "active response complete")).toBe(
        true,
      )
      expect(firstResult.parts.some((part) => part.type === "text" && part.text === "queued response one")).toBe(true)
      expect(secondResult.parts.some((part) => part.type === "text" && part.text === "queued response two")).toBe(true)
      expect(yield* llm.calls).toBe(4)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("removes an edited queued prompt before sending its replacement", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.push(reply().tool("glob", { pattern: "**/*.txt" }).wait(gate.promise))
      yield* llm.text("active response complete")
      yield* llm.text("edited queued response")

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)

      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request before edit" }],
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (true) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          if (messages.some((message) => message.info.id === queuedID)) return
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("1 second"))

      expect(
        yield* prompt.cancelQueued({
          sessionID: chat.id,
          messageID: queuedID,
        }),
      ).toBe(true)
      yield* sessions.removeMessage({ sessionID: chat.id, messageID: queuedID })
      const removed = yield* sessions.messages({ sessionID: chat.id })
      expect(removed.some((message) => message.info.id === queuedID)).toBe(false)

      const replacement = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request after edit" }],
        })
        .pipe(Effect.forkChild)

      gate.resolve()
      const [activeResult, cancelledResult, replacementResult] = yield* Effect.all([
        Fiber.join(active),
        Fiber.join(queued),
        Fiber.join(replacement),
      ])
      expect(cancelledResult.info.role).toBe("assistant")
      expect(activeResult.parts.some((part) => part.type === "text" && part.text === "active response complete")).toBe(
        true,
      )
      expect(
        replacementResult.parts.some((part) => part.type === "text" && part.text === "edited queued response"),
      ).toBe(true)
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("queued request after edit"))).toBe(
        true,
      )
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("queued request before edit"))).toBe(
        false,
      )
      expect(yield* llm.calls).toBe(3)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("keeps direct in-place queued prompt replacement compatible", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.push(reply().tool("glob", { pattern: "**/*.txt" }).wait(gate.promise))
      yield* llm.text("active response complete")
      yield* llm.text("edited queued response")

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)

      const queuedID = MessageID.ascending()
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: queuedID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request before edit" }],
        })
        .pipe(Effect.forkChild)
      yield* Effect.gen(function* () {
        while (true) {
          const messages = yield* sessions.messages({ sessionID: chat.id })
          if (messages.some((message) => message.info.id === queuedID)) return
          yield* Effect.sleep("1 millis")
        }
      }).pipe(Effect.timeout("1 second"))

      const edited = yield* prompt.prompt({
        sessionID: chat.id,
        messageID: queuedID,
        replaceExisting: true,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "queued request after edit" }],
      })
      expect(edited.info.id).toBe(queuedID)
      expect(edited.parts.some((part) => part.type === "text" && part.text === "queued request after edit")).toBe(true)
      expect(edited.parts.some((part) => part.type === "text" && part.text === "queued request before edit")).toBe(
        false,
      )

      const stored = yield* sessions.messages({ sessionID: chat.id })
      const storedQueued = stored.filter((message) => message.info.id === queuedID)
      expect(storedQueued).toHaveLength(1)
      expect(
        storedQueued[0]?.parts.some((part) => part.type === "text" && part.text === "queued request after edit"),
      ).toBe(true)
      expect(
        storedQueued[0]?.parts.some((part) => part.type === "text" && part.text === "queued request before edit"),
      ).toBe(false)

      gate.resolve()
      const [activeResult, queuedResult] = yield* Effect.all([Fiber.join(active), Fiber.join(queued)])
      expect(activeResult.parts.some((part) => part.type === "text" && part.text === "active response complete")).toBe(
        true,
      )
      expect(queuedResult.parts.some((part) => part.type === "text" && part.text === "edited queued response")).toBe(
        true,
      )
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("queued request after edit"))).toBe(
        true,
      )
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("queued request before edit"))).toBe(
        false,
      )
      expect(yield* llm.calls).toBe(3)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("after-tools queue mode joins after the current tool iteration", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.push(reply().tool("glob", { pattern: "**/*.txt" }).wait(gate.promise))
      yield* llm.text("queued after tools")

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request" }],
        })
        .pipe(Effect.forkChild)
      gate.resolve()

      const [activeResult, queuedResult] = yield* Effect.all([Fiber.join(active), Fiber.join(queued)])
      expect(activeResult.parts.some((part) => part.type === "text" && part.text === "queued after tools")).toBe(true)
      expect(queuedResult.info.id).toBe(activeResult.info.id)
      expect(yield* llm.calls).toBe(2)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        queue: { mode: "after-tools" },
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("global immediate queue mode interrupts the active turn and runs the queued prompt", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.hold("active turn", gate.promise)

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* llm.text("queued immediately")

      const queued = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "run now" }],
      })
      const interrupted = yield* Fiber.join(active)
      gate.resolve()
      const persisted = (yield* sessions.messages({ sessionID: chat.id })).find(
        (message) => message.info.id === interrupted.info.id,
      )

      expect(interrupted.info.role).toBe("assistant")
      expect(persisted?.info.role).toBe("assistant")
      if (persisted?.info.role === "assistant") {
        expect(persisted.info.time.completed).toBeNumber()
        expect(persisted.info.error?.name).toBe("MessageAbortedError")
      }
      expect(queued.parts.some((part) => part.type === "text" && part.text === "queued immediately")).toBe(true)
      expect(yield* llm.calls).toBe(2)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        queue: { mode: "immediate" },
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("manual interrupt stops only the active turn and preserves its queued prompt", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = defer<void>()
      yield* llm.hold("active turn", gate.promise)

      const active = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "active request" }],
        })
        .pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* llm.text("queued response")
      const queued = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "queued request" }],
        })
        .pipe(Effect.forkChild)
      yield* Effect.sleep("20 millis")

      yield* prompt.interrupt(chat.id).pipe(Effect.timeout("1 second"))
      const [interrupted, queuedResult] = yield* Effect.all([Fiber.join(active), Fiber.join(queued)])
      gate.resolve()
      const messages = yield* sessions.messages({ sessionID: chat.id })

      expect(interrupted.info.role).toBe("assistant")
      expect(queuedResult.parts.some((part) => part.type === "text" && part.text === "queued response")).toBe(true)
      expect(
        messages.filter(
          (message) => message.info.role === "assistant" && message.info.error?.name === "MessageAbortedError",
        ),
      ).toHaveLength(1)
      expect(
        messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "queued request"),
        ),
      ).toBe(true)
      expect(yield* llm.calls).toBe(2)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        queue: { mode: "after-turn" },
        agent: { build: { model: "test/test-model" } },
      }),
    },
  ),
)

it.live("injects the latest approved plan review as runtime context after compaction", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const oldPlan = "# Old approved plan\n\n- stale step"
      const latestPlan = [
        "# Latest approved plan",
        "",
        "## Requirements",
        "- Keep this whole plan verbatim after compaction.",
        "- Do not merge it with older plans.",
      ].join("\n")

      const planUser = yield* user(chat.id, "please plan the work")
      for (const item of [
        { title: "Old", markdown: oldPlan },
        { title: "Latest", markdown: latestPlan },
      ]) {
        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: planUser.id,
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: dir, root: dir },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "tool-calls",
        }
        yield* sessions.updateMessage(assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: assistant.id,
          sessionID: chat.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "plan_review",
          state: {
            status: "completed",
            input: item,
            output: "User approved the plan and switched to build. Continue by implementing the approved plan.",
            title: "Plan approved",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
      }

      const compacted = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: compacted.id,
        sessionID: chat.id,
        type: "compaction",
        auto: true,
        overflow: true,
      })
      const summaryAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: compacted.id,
        sessionID: chat.id,
        mode: "compaction",
        agent: "compaction",
        cost: 0,
        path: { cwd: dir, root: dir },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
        summary: true,
        finish: "end_turn",
      }
      yield* sessions.updateMessage(summaryAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryAssistant.id,
        sessionID: chat.id,
        type: "text",
        text: "## Goal\n- compacted summary without the approved plan",
      })
      yield* user(chat.id, "continue implementing the approved plan")
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: chat.id })

      const body = JSON.stringify(yield* llm.inputs)
      const start = body.indexOf("<latest_accepted_plan_review>")
      const end = body.indexOf("</latest_accepted_plan_review>", start)
      const planContext = body.slice(start, end).replaceAll("\\n", "\n")
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      expect(planContext).toContain(latestPlan)
      expect(planContext).toContain("title: Latest")
      expect(planContext).not.toContain(oldPlan)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("does not duplicate approved plan context when the preserved tail already contains it", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      const latestPlan = ["# Latest approved plan", "", "- preserved in tail"].join("\n")

      const planUser = yield* user(chat.id, "please plan the work")
      const approved = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: planUser.id,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: dir, root: dir },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
        finish: "tool-calls",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: approved.id,
        sessionID: chat.id,
        type: "tool",
        callID: crypto.randomUUID(),
        tool: "plan_review",
        state: {
          status: "completed",
          input: { title: "Latest", markdown: latestPlan },
          output: "User approved the plan.",
          title: "Plan approved",
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      })

      const compacted = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: compacted.id,
        sessionID: chat.id,
        type: "compaction",
        auto: true,
        overflow: true,
        tail_start_id: planUser.id,
      })
      const summaryAssistant: MessageV2.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: compacted.id,
        sessionID: chat.id,
        mode: "compaction",
        agent: "compaction",
        cost: 0,
        path: { cwd: dir, root: dir },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
        summary: true,
        finish: "end_turn",
      }
      yield* sessions.updateMessage(summaryAssistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: summaryAssistant.id,
        sessionID: chat.id,
        type: "text",
        text: "## Goal\n- compacted summary",
      })
      yield* user(chat.id, "continue implementing the approved plan")
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: chat.id })

      const body = JSON.stringify(yield* llm.inputs)
      expect(body).not.toContain("<latest_accepted_plan_review>")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("prompt updates persisted session model to the latest user selection", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        agent: "build",
        model: { providerID: ProviderID.make("test"), id: ModelID.make("test-model") },
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model-alt") },
        variant: "low",
        noReply: true,
        parts: [{ type: "text", text: "switch the prompt model" }],
      })

      const updated = yield* sessions.get(session.id)
      expect(updated.agent).toBe("build")
      expect(updated.model).toEqual({
        providerID: ProviderID.make("test"),
        id: ModelID.make("test-model-alt"),
        variant: "low",
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        provider: {
          ...providerCfg(url).provider,
          test: {
            ...providerCfg(url).provider.test,
            models: {
              ...providerCfg(url).provider.test.models,
              "test-model-alt": {
                ...providerCfg(url).provider.test.models["test-model"],
                id: "test-model-alt",
                name: "Test Model Alt",
                variants: { low: {} },
              },
            },
          },
        },
      }),
    },
  ),
)

it.live("prompt emits v2 prompted and synthetic events", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionV2.layer),
      )
      const row = Database.use((db) =>
        db.select().from(SessionMessageTable).where(Database.eq(SessionMessageTable.session_id, chat.id)).get(),
      )
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })

      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(1)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop flushes automatic memory extraction after a normal assistant stop", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const root = path.resolve(dir)
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        process.env.XDG_CONFIG_HOME = path.join(root, ".xdg")
        try {
          yield* Effect.promise(() =>
            writeProjectMemoryConfig(
              {
                enabled: true,
                use: false,
                generate: true,
                extractorRole: "memoryExtractor",
              },
              root,
            ),
          )
          yield* Effect.promise(() =>
            writeModelsConfig(
              {
                ...defaultModelsConfig,
                enabled: true,
                roles: {
                  ...defaultModelsConfig.roles,
                  default: { providerID: "test", modelID: "test-model" },
                  memoryExtractor: { providerID: "test", modelID: "test-model" },
                },
              },
              root,
            ),
          )

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: "Memory flush",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [
              {
                type: "text",
                text: "For this repo, when you make visible TUI changes, run a smoke test before saying done. Respond only: understood.",
              },
            ],
          })

          yield* llm.text("understood")
          yield* llm.text(
            JSON.stringify({
              proposals: [
                {
                  shouldRemember: true,
                  scope: "project",
                  text: "For this repo, visible TUI changes should be validated with a smoke test before saying done.",
                  tags: ["workflow", "tui"],
                  durability: 0.92,
                  confidence: 0.9,
                  changeRisk: 0.1,
                  reason: "Durable repo-specific validation preference.",
                },
              ],
            }),
          )

          const result = yield* prompt.loop({ sessionID: session.id })
          const proposals = yield* Effect.promise(() => listMemoryProposals(root, "pending"))
          const inputs = yield* llm.inputs

          expect(result.info.role).toBe("assistant")
          expect(yield* llm.calls).toBe(2)
          expect(JSON.stringify(inputs[1])).toContain("You are MendCode's memory extractor")
          expect(JSON.stringify(inputs[1])).toContain("<memory_context>")
          expect(JSON.stringify(inputs[1])).toContain("<candidate_turn>")
          expect(proposals).toHaveLength(1)
          expect(proposals[0]?.scope).toBe("project")
          expect(proposals[0]?.text).toContain("visible TUI changes")
        } finally {
          if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
          else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        }
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop returns to idle when automatic memory extraction times out", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const root = path.resolve(dir)
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        const previousTimeout = process.env.MENDCODE_MEMORY_EXTRACTION_TIMEOUT_MS
        process.env.XDG_CONFIG_HOME = path.join(root, ".xdg")
        process.env.MENDCODE_MEMORY_EXTRACTION_TIMEOUT_MS = "100"
        try {
          yield* Effect.promise(() =>
            writeProjectMemoryConfig(
              {
                enabled: true,
                use: false,
                generate: true,
                extractorRole: "memoryExtractor",
              },
              root,
            ),
          )
          yield* Effect.promise(() =>
            writeModelsConfig(
              {
                ...defaultModelsConfig,
                enabled: true,
                roles: {
                  ...defaultModelsConfig.roles,
                  default: { providerID: "test", modelID: "test-model" },
                  memoryExtractor: { providerID: "test", modelID: "test-model" },
                },
              },
              root,
            ),
          )

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const status = yield* SessionStatus.Service
          const session = yield* sessions.create({
            title: "Memory timeout",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "Remember that stalled memory extraction must never keep the session busy." }],
          })

          yield* llm.text("understood")
          yield* llm.hang

          const result = yield* prompt.loop({ sessionID: session.id })
          const finish = [...result.parts]
            .reverse()
            .find((part): part is MessageV2.StepFinishPart => part.type === "step-finish")
          const memory = finish?.metadata?.mendMemory as any

          expect(result.info.role).toBe("assistant")
          expect(yield* llm.calls).toBe(2)
          expect(memory?.output?.skipped).toBe(true)
          expect(memory?.output?.reason).toBeTruthy()
          expect(yield* status.get(session.id)).toEqual({ type: "idle" })
        } finally {
          if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
          else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
          if (previousTimeout === undefined) delete process.env.MENDCODE_MEMORY_EXTRACTION_TIMEOUT_MS
          else process.env.MENDCODE_MEMORY_EXTRACTION_TIMEOUT_MS = previousTimeout
        }
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Prompt provider turns",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      })

      yield* llm.text("world one")

      const first = yield* prompt.loop({ sessionID: session.id })
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      })

      yield* llm.text("world two")

      const second = yield* prompt.loop({ sessionID: session.id })
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(2)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("glob tool keeps instance context during prompt runs", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          title: "Glob context",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const file = path.join(dir, "probe.txt")
        yield* Effect.promise(() => Bun.write(file, "probe"))

        yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "find text files" }],
        })
        yield* llm.tool("glob", { pattern: "**/*.txt" })
        yield* llm.text("done")

        const result = yield* prompt.loop({ sessionID: session.id })
        expect(result.info.role).toBe("assistant")

        const msgs = yield* MessageV2.filterCompactedEffect(session.id)
        const tool = msgs
          .flatMap((msg) => msg.parts)
          .find(
            (part): part is CompletedToolPart =>
              part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
          )
        if (!tool) return

        expect(tool.state.output).toContain(file)
        expect(tool.state.output).not.toContain("No context found for instance")
        expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
      }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is stop but assistant has tool parts", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.push(reply().tool("first", { value: "first" }).stop())
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(2)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live(
  "running subtask preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
            const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running subtask metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBeDefined()
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  5_000,
)

it.live(
  "running task tool preserves metadata after tool-call transition",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.tool("task", {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

        const tool = yield* Effect.promise(async () => {
          const end = Date.now() + 5_000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(MessageV2.filterCompactedEffect(chat.id))
            const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
            const tool = assistant?.parts.find(
              (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
            )
            if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for running task metadata")
        })

        if (tool.state.status !== "running") return
        expect(typeof tool.state.metadata?.sessionId).toBe("string")
        expect(tool.state.title).toBe("inspect bug")
        expect(tool.state.metadata?.model).toBeDefined()

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        const remoteBusy = yield* SessionStatus.Service.use((remote) => remote.get(chat.id)).pipe(
          Effect.provide(SessionStatus.defaultLayer),
        )
        expect(remoteBusy.type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const remoteIdle = yield* SessionStatus.Service.use((remote) => remote.get(chat.id)).pipe(
          Effect.provide(SessionStatus.defaultLayer),
        )
        expect(remoteIdle.type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "loop refreshes the session title every fifteen human messages",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        yield* sessions.create({ title: "Recent packaging cleanup" })
        const chat = yield* sessions.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        for (let i = 1; i <= 30; i++) {
          yield* user(chat.id, `human turn ${i}`)
          yield* llm.text(`assistant-only-long-output ${"x".repeat(1_000)}`)
          yield* prompt.loop({ sessionID: chat.id })
        }

        yield* llm.wait(33)
        const hits = yield* llm.hits
        const titleHits = hits.filter((hit) =>
          JSON.stringify(hit.body).includes("Generate an updated title for this conversation"),
        )
        expect(titleHits).toHaveLength(2)
        const firstBody = JSON.stringify(titleHits[0]?.body)
        const latestBody = JSON.stringify(titleHits.at(-1)?.body)
        expect(firstBody).toContain("Latest human messages")
        expect(firstBody).toContain("human turn 1")
        expect(firstBody).toContain("human turn 15")
        expect(firstBody).not.toContain("human turn 16")
        expect(firstBody).not.toContain("assistant-only-long-output")
        expect(firstBody).toContain("3 to 5 words")
        expect(latestBody).toContain("human turn 16")
        expect(latestBody).toContain("human turn 30")
        expect(latestBody).not.toContain("human turn 15")
        expect(latestBody).not.toContain("assistant-only-long-output")
        expect(latestBody).toContain("Current and recent session titles")
        expect(latestBody).toContain("shortest clear wording")
        expect(latestBody).toContain("E2E Title")
        expect(latestBody).toContain("Recent packaging cleanup")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          agent: { title: { model: "test/test-model" } },
        }),
      },
    ),
  10_000,
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const registry = yield* ToolRegistry.Service
          const { task } = yield* registry.named()
          const original = task.execute
          task.execute = (_args, ctx) =>
            Effect.callback<never>((_resume) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              return Effect.sync(() => aborted.resolve())
            })
          yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel propagates from slash command subtask to child session",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        const msg = yield* user(chat.id, "hello")
        yield* addSubtask(chat.id, msg.id)

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
        const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
        const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
        const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
        expect(typeof sessionID).toBe("string")
        if (typeof sessionID !== "string") throw new Error("missing child session id")
        const childID = SessionID.make(sessionID)
        expect((yield* status.get(childID)).type).toBe("busy")

        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)

        expect((yield* status.get(chat.id)).type).toBe("idle")
        expect((yield* status.get(childID)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.fail("boom")
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(2)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants).toHaveLength(2)
        const last = assistants.at(-1)
        if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
        expect(last.info.parentID).toBe(id)
        expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(2)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell completes a fast command on the preferred shell", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("pwd")
        expect(tool.state.output).toContain(dir)
        expect(tool.state.metadata.output).toContain(dir)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            const result = yield* prompt.shell({
              sessionID: chat.id,
              agent: "build",
              command: "[[ 1 -eq 1 ]] && printf configured",
            })

            const tool = completedTool(result.parts)
            if (!tool) return
            expect(tool.state.output).toContain("configured")
          }),
        { git: true, config: { ...cfg, shell: "bash" } },
      ),
    ),
  30_000,
)

unix("shell commands can change directory after startup", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell captures stderr from a failing command", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("not found")
        expect(tool.state.metadata.output).toContain("not found")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = await MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            yield* llm.text("done")

            const result = yield* prompt.command({
              sessionID: chat.id,
              command: "probe",
              arguments: "",
            })

            expect(result.info.role).toBe("assistant")
            const inputs = yield* llm.inputs
            expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
          }),
        {
          git: true,
          config: (url) => ({
            ...providerCfg(url),
            shell: "bash",
            command: {
              probe: {
                template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
              },
            },
          }),
        },
      ),
    ),
  30_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command:
              'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; sleep 30',
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* Effect.sleep(150)
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
          expect(tool.state.output).toMatch(/Output excerpt saved to:\s+\S+/)
          expect(tool.state.metadata.output).toContain("Output excerpt saved to:")
          expect(tool.state.metadata.output).toContain(String(tool.state.metadata.outputPath))
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            const tool = completedTool(exit.value.parts)
            expect(tool?.state.output).toContain("User aborted the command")
          }

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

/** Override a tool's execute to hang until aborted. Returns ready/aborted defers and a finalizer. */
function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  const ready = defer<void>()
  const aborted = defer<void>()
  const original = tool.execute
  tool.execute = (_args: any, ctx: any) => {
    ready.resolve()
    ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
    return Effect.callback<never>(() => {})
  }
  const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
  return { ready, aborted, restore }
}

it.live(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const testFile = path.join(dir, "test.txt")
          yield* Effect.promise(() => Bun.write(testFile, "hello world"))

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const { read } = yield* registry.named()
          const { ready, aborted, restore } = hangUntilAborted(read)
          yield* restore

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Abort Test" })

          const fiber = yield* prompt
            .prompt({
              sessionID: chat.id,
              agent: "build",
              parts: [
                { type: "text", text: "read this" },
                { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
              ],
            })
            .pipe(Effect.forkChild)

          yield* Effect.promise(() => ready.promise)
          yield* Fiber.interrupt(fiber)

          yield* Effect.promise(() =>
            Promise.race([
              aborted.promise,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("abort signal not propagated within 2s")), 2_000),
              ),
            ]),
          )
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

// Missing file handling

it.live("does not fail the prompt when a file part is missing", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "does-not-exist.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")
        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

it.live("keeps stored part order stable when file resolution is async", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const missing = path.join(dir, "still-missing.ts")
        const msg = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

// Special characters in filenames

it.live("handles filenames with # character", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(dir, "file#name.txt"), "special content\n"))

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

        const message = yield* prompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        yield* sessions.remove(session.id)
      }),
    { git: true, config: cfg },
  ),
)

// Regression: empty assistant turn loop

it.live("does not loop empty assistant turns for a simple reply", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt regression" })

      yield* llm.text("packages/opencode/src/session/processor.ts")

      const result = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Where is SessionProcessor?" }],
      })

      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
      expect(yield* llm.calls).toBe(1)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Prompt cancel regression" })

        yield* llm.hang

        const fiber = yield* prompt
          .prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Cancel me" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* prompt.cancel(session.id)

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          if (exit.value.info.role === "assistant") {
            expect(exit.value.info.error?.name).toBe("MessageAbortedError")
          }
        }

        const msgs = yield* sessions.messages({ sessionID: session.id })
        const last = msgs.findLast((msg) => msg.info.role === "assistant")
        expect(last?.info.role).toBe("assistant")
        if (last?.info.role === "assistant") {
          expect(last.info.error?.name).toBe("MessageAbortedError")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Agent variant

it.live("applies agent variant only when using agent model", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})

        const other = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        if (other.info.role !== "user") throw new Error("expected user message")
        expect(other.info.model.variant).toBeUndefined()

        const match = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello again" }],
        })
        if (match.info.role !== "user") throw new Error("expected user message")
        expect(match.info.model).toEqual({
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("test-model"),
          variant: "xhigh",
        })
        expect(match.info.model.variant).toBe("xhigh")

        const override = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "hello third" }],
        })
        if (override.info.role !== "user") throw new Error("expected user message")
        expect(override.info.model.variant).toBe("high")

        yield* sessions.remove(session.id)
      }),
    {
      git: true,
      config: {
        ...cfg,
        provider: {
          ...cfg.provider,
          test: {
            ...cfg.provider.test,
            models: {
              "test-model": {
                ...cfg.provider.test.models["test-model"],
                variants: { xhigh: {}, high: {} },
              },
            },
          },
        },
        agent: {
          build: {
            model: "test/test-model",
            variant: "xhigh",
          },
        },
      },
    },
  ),
)

// Agent / command resolution errors

it.live(
  "unknown agent throws typed error",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
            }
          }
        }),
      { git: true },
    ),
  30_000,
)

it.live(
  "unknown agent error includes available agent names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .prompt({
              sessionID: session.id,
              agent: "nonexistent-agent-xyz",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain("build")
            }
          }
        }),
      { git: true },
    ),
  30_000,
)

it.live(
  "unknown command throws typed error with available names",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({})
          const exit = yield* prompt
            .command({
              sessionID: session.id,
              command: "nonexistent-command-xyz",
              arguments: "",
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).not.toBeInstanceOf(TypeError)
            expect(NamedError.Unknown.isInstance(err)).toBe(true)
            if (NamedError.Unknown.isInstance(err)) {
              expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
              expect(err.data.message).toContain("init")
            }
          }
        }),
      { git: true },
    ),
  30_000,
)
