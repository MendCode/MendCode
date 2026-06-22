import { Cause, Clock, Deferred, Duration, Effect, Fiber, Latch, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { PlanReview } from "@/plan-review"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import * as Session from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID, SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import * as Log from "@mendcode/core/util/log"
import { isRecord } from "@/util/record"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import { Modelv2 } from "@/v2/model"
import { readMemoryConfig, resolveProjectMemoryRoot } from "@/mend/memory/config"
import {
  extractorPrompt,
  memoryExtractorCandidateMessage,
  proposeMemoriesFromExtractorText,
  readMemoryExtractorContext,
  resolveMemoryExtractorRole,
  type ProposeMemoriesFromTextInput,
} from "@/mend/memory/proposals"
import { mendMemoryContext } from "@/mend/memory/retrieve"
import * as DateTime from "effect/DateTime"

const DOOM_LOOP_THRESHOLD = 3
const log = Log.create({ service: "session.processor" })
const DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS = 180_000

function llmStreamIdleTimeoutMs() {
  const value = Number(process.env.MENDCODE_LLM_STREAM_IDLE_TIMEOUT_MS)
  if (Number.isFinite(value) && value > 0) return value
  return DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS
}

function timeoutStreamUnless<A, E, R>(
  self: Stream.Stream<A, E, R>,
  input: {
    duration: Duration.Input
    keepWaiting: Effect.Effect<boolean>
    onTimeout: () => Error
  },
) {
  const duration = Duration.fromInputUnsafe(input.duration)
  if (!Duration.isFinite(duration)) return self
  const durationMs = Duration.toMillis(duration)
  const timeoutSymbol = Symbol()
  return Stream.catchCause(
    Stream.suspend(() => {
      const parent = Fiber.getCurrent()!
      const clock = parent.getRef(Clock.Clock)
      let deadline: number | undefined
      const latch = Latch.makeUnsafe(false)
      return Stream.merge(
        Stream.transformPull(self, (pull) =>
          Effect.suspend(() => {
            deadline = clock.currentTimeMillisUnsafe() + durationMs
            latch.openUnsafe()
            return pull
          }).pipe(
            Effect.map((arr) => {
              latch.closeUnsafe()
              deadline = undefined
              return arr
            }),
            Effect.succeed,
          ),
        ),
        Stream.fromEffectDrain(
          Effect.gen(function* () {
            while (true) {
              yield* latch.await
              if (deadline === undefined) continue
              yield* Effect.sleep(deadline - clock.currentTimeMillisUnsafe())
              if (deadline === undefined) continue
              const remaining = deadline - clock.currentTimeMillisUnsafe()
              if (remaining > 0) continue
              if (yield* input.keepWaiting) {
                deadline = clock.currentTimeMillisUnsafe() + durationMs
                continue
              }
              return yield* Effect.die(timeoutSymbol)
            }
          }),
        ),
        { haltStrategy: "left" },
      )
    }),
    (cause): Stream.Stream<never, E | Error> => {
      const isTimeout = cause.reasons.find((r) => r._tag === "Die" && r.defect === timeoutSymbol)
      if (isTimeout) return Stream.fail(input.onTimeout())
      return Stream.failCause(cause as Cause.Cause<E>)
    },
  )
}
function memoryExtractorAgent(): Agent.Info {
  return {
    name: "memoryExtractor",
    mode: "primary",
    native: true,
    hidden: true,
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
    prompt: extractorPrompt(),
    temperature: 0,
  }
}

function estimateTokenCount(text: string) {
  if (!text.trim()) return 0
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 4))
}

function modelContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: any) => {
      if (!part || typeof part !== "object") return ""
      if (typeof part.text === "string") return part.text
      if (typeof part.content === "string") return part.content
      if (part.type === "image" || part.type === "file") return `[${part.type}]`
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function messagePartsText(parts: MessageV2.Part[]) {
  return parts
    .map((part) => part.type === "text" && !part.synthetic ? part.text : "")
    .filter(Boolean)
    .join("\n")
}

function hasPersistedToolResult(parts: MessageV2.Part[]) {
  return parts.some(
    (part) =>
      part.type === "tool" &&
      (part.state.status === "completed" || part.state.status === "error"),
  )
}

function hasToolAttempt(parts: MessageV2.Part[], basePartIDs: Set<PartID>) {
  return parts.some((part) => part.type === "tool" && !basePartIDs.has(part.id))
}

function estimateStreamInputTokens(input: LLM.StreamInput) {
  const system = [input.agent.prompt ?? "", ...input.system, input.user.system ?? ""].join("\n")
  const messages = input.messages
    .map((message: any) => [message.role, modelContentText(message.content)].filter(Boolean).join("\n"))
    .join("\n")
  const tools = Object.entries(input.tools)
    .map(([name, tool]) => [name, (tool as any)?.description ?? ""].filter(Boolean).join("\n"))
    .join("\n")
  return estimateTokenCount([system, messages, tools].filter(Boolean).join("\n"))
}

function tokenNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function readPath(input: unknown, path: string[]) {
  let current = input
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function firstTokenNumber(input: unknown, paths: string[][]) {
  for (const path of paths) {
    const value = tokenNumber(readPath(input, path))
    if (value > 0) return value
  }
  return 0
}

function usageCandidates(raw: unknown) {
  const direct = isRecord(raw) && hasUsageLikeKeys(raw) ? [raw] : []
  return [
    readPath(raw, ["usage"]),
    readPath(raw, ["response", "usage"]),
    readPath(raw, ["message", "usage"]),
    readPath(raw, ["delta", "usage"]),
    readPath(raw, ["usageMetadata"]),
    readPath(raw, ["usage_metadata"]),
    ...direct,
  ].filter(isRecord)
}

function hasUsageLikeKeys(input: Record<string, unknown>) {
  return Object.keys(input).some((key) => /tokens?|token_?count/i.test(key))
}

function normalizeProviderUsage(
  usage: Record<string, unknown>,
  previous?: MessageV2.Assistant["liveUsage"],
): MessageV2.Assistant["liveUsage"] | undefined {
  const input = firstTokenNumber(usage, [
    ["input_tokens"],
    ["prompt_tokens"],
    ["inputTokens"],
    ["promptTokens"],
    ["promptTokenCount"],
    ["inputTokenCount"],
    ["input_token_count"],
    ["inputTokenDetails", "total"],
    ["inputTokensDetails", "total"],
  ])
  const cacheRead = firstTokenNumber(usage, [
    ["input_tokens_details", "cached_tokens"],
    ["prompt_tokens_details", "cached_tokens"],
    ["cached_input_tokens"],
    ["cachedInputTokens"],
    ["cache_read_input_tokens"],
    ["cacheReadInputTokens"],
    ["inputTokenDetails", "cacheReadTokens"],
    ["input_tokens_details", "cache_read_tokens"],
    ["cachedContentTokenCount"],
  ])
  const cacheWrite = firstTokenNumber(usage, [
    ["cache_creation_input_tokens"],
    ["cacheWriteInputTokens"],
    ["inputTokenDetails", "cacheWriteTokens"],
    ["input_tokens_details", "cache_write_tokens"],
  ])
  const output = firstTokenNumber(usage, [
    ["output_tokens"],
    ["completion_tokens"],
    ["outputTokens"],
    ["completionTokens"],
    ["candidatesTokenCount"],
    ["outputTokenCount"],
    ["completionTokenCount"],
    ["outputTokenDetails", "total"],
  ])
  const reasoning = firstTokenNumber(usage, [
    ["output_tokens_details", "reasoning_tokens"],
    ["completion_tokens_details", "reasoning_tokens"],
    ["reasoning_tokens"],
    ["reasoningTokens"],
    ["thoughtsTokenCount"],
    ["outputTokenDetails", "reasoningTokens"],
  ])

  const mergedInput = input || previous?.input || 0
  const mergedOutput = output || previous?.output || 0
  const mergedReasoning = reasoning || previous?.reasoning || 0
  const mergedCacheRead = cacheRead || previous?.cache.read || 0
  const mergedCacheWrite = cacheWrite || previous?.cache.write || 0
  if (mergedInput + mergedCacheRead + mergedCacheWrite + mergedOutput + mergedReasoning <= 0) return

  return {
    source: "provider",
    phase: output + reasoning > 0 ? "output" : previous?.phase ?? "input",
    input: mergedInput,
    output: mergedOutput,
    reasoning: mergedReasoning,
    cache: { read: mergedCacheRead, write: mergedCacheWrite },
  }
}

export function providerLiveUsage(
  raw: unknown,
  previous?: MessageV2.Assistant["liveUsage"],
): MessageV2.Assistant["liveUsage"] | undefined {
  for (const usage of usageCandidates(raw)) {
    const normalized = normalizeProviderUsage(usage, previous)
    if (normalized) return normalized
  }
}

function memoryMessageText(message: { content?: unknown }) {
  const content = message.content
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (isRecord(part) && typeof part.text === "string") return part.text
      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function memoryConversationWindow(messages: Array<{ role?: string; content?: unknown }>, maxMessages = 6) {
  return messages
    .slice(0, -1)
    .slice(-maxMessages)
    .map((message) => {
      const role = typeof message.role === "string" ? message.role.toUpperCase() : "UNKNOWN"
      const text = memoryMessageText(message)
      return text ? `${role}:\n${text.slice(0, 1800)}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

export type Result = "compact" | "stop" | "continue"

export type Event = LLM.Event

export interface Handle {
  readonly message: MessageV2.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
  ) => Effect.Effect<MessageV2.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: MessageV2.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly flushMemory: () => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: MessageV2.Assistant
  sessionID: SessionID
  model: Provider.Model
  abort?: AbortSignal
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: MessageV2.ToolPart["id"]
  messageID: MessageV2.ToolPart["messageID"]
  sessionID: MessageV2.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

type PendingMemoryExtraction = {
  memoryMetadata: {
    input: {
      enabled: boolean
      use: boolean
      references: unknown[]
      lines: number
    }
    output: {
      enabled: boolean
      generate: boolean
      extractorRole?: string
      queued: boolean
      saved: unknown[]
      proposals: unknown[]
    }
    callsProviders: boolean
  }
  finishPart: MessageV2.StepFinishPart
  memoryRoot: string
  memoryTurnText: string
  messagePath: MessageV2.Assistant["path"]
  user: MessageV2.User
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  pendingToolUpdates: Record<string, (part: MessageV2.ToolPart) => MessageV2.ToolPart>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: MessageV2.TextPart | undefined
  assistantText: string
  memoryQuery: string | null
  streamMessages: LLM.StreamInput["messages"]
  streamUser: MessageV2.User | undefined
  reasoningMap: Record<string, MessageV2.ReasoningPart>
  liveTokenOutputText: string
  liveTokenUpdatedAt: number
  pendingMemoryExtraction: PendingMemoryExtraction | undefined
}

type StreamEvent = Event

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Session.Service
  | Config.Service
  | Bus.Service
  | Snapshot.Service
  | Agent.Service
  | LLM.Service
  | Permission.Service
  | PlanReview.Service
  | Provider.Service
  | Plugin.Service
  | SessionSummary.Service
  | SessionStatus.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const planReview = yield* PlanReview.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        pendingToolUpdates: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
          currentText: undefined,
          assistantText: "",
          memoryQuery: null,
          streamMessages: [],
          streamUser: undefined,
          reasoningMap: {},
        liveTokenOutputText: "",
        liveTokenUpdatedAt: 0,
        pendingMemoryExtraction: undefined,
      }
      let aborted = false
      const slog = log.clone().tag("session.id", input.sessionID).tag("messageID", input.assistantMessage.id)

      const isExplicitAbort = () => input.abort?.aborted === true || aborted

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted: isExplicitAbort(),
        })

      const updateLiveTokenUsage = Effect.fn("SessionProcessor.updateLiveTokenUsage")(function* (force = false) {
        const now = Date.now()
        if (!force && now - ctx.liveTokenUpdatedAt < 250) return
        ctx.liveTokenUpdatedAt = now
        const output = estimateTokenCount(ctx.liveTokenOutputText)
        const current: NonNullable<MessageV2.Assistant["liveUsage"]> = ctx.assistantMessage.liveUsage ?? {
          source: "estimate",
          phase: "input",
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }
        if (current.source === "provider" || current.source === "tokenizer") return
        if (current.phase === "output" && current.output === output && !force) return
        ctx.assistantMessage.liveUsage = {
          ...current,
          phase: "output",
          output,
        }
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return
        }
        return { call, part }
      })

      const hasPendingHumanInteraction = Effect.fn("SessionProcessor.hasPendingHumanInteraction")(function* () {
        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (match?.part.tool === "question" && match.part.state.status === "running") return true
        }
        for (const request of yield* permission.list()) {
          if (request.sessionID !== ctx.sessionID) continue
          const callID = request.tool?.callID
          if (!callID) continue
          const match = yield* readToolCall(callID)
          if (match?.part.state.status === "running" || match?.part.state.status === "pending") return true
        }
        for (const request of yield* planReview.list()) {
          if (request.sessionID !== ctx.sessionID) continue
          const callID = request.tool?.callID
          if (!callID) continue
          const match = yield* readToolCall(callID)
          if (match?.part.state.status === "running" || match?.part.state.status === "pending") return true
        }
        return false
      })

      const proposeAutomaticMemories = Effect.fn("SessionProcessor.proposeAutomaticMemories")(function* (
        input: {
          user: MessageV2.User
          cwd: string
          root: string
          proposal: ProposeMemoriesFromTextInput
        },
      ) {
        const role = yield* Effect.promise(() => resolveMemoryExtractorRole(input.root))
        if (!role.ok) {
          return {
            proposals: [],
            callsProviders: false as const,
            skipped: true,
            reason: role.reason,
          }
        }
        const model = yield* provider.getModel(role.providerID as any, role.modelID as any)
        const extractorContext = yield* Effect.promise(() => readMemoryExtractorContext(input.root))
        const outputText = yield* llm
          .stream({
            agent: memoryExtractorAgent(),
            user: input.user,
            system: [],
            small: true,
            tools: {},
            toolChoice: "none",
            model,
            sessionID: ctx.sessionID,
            cwd: input.cwd,
            root: input.root,
            retries: 2,
            messages: [{
              role: "user",
              content: memoryExtractorCandidateMessage(input.proposal, extractorContext.existing),
            }],
          })
          .pipe(
            Stream.filter((event): event is Extract<LLM.Event, { type: "text-delta" }> => event.type === "text-delta"),
            Stream.map((event) => event.text),
            Stream.mkString,
          )
        return yield* Effect.promise(() =>
          proposeMemoriesFromExtractorText(input.proposal, outputText, input.root, extractorContext.existingFingerprints),
        )
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) {
          const pending = ctx.pendingToolUpdates[toolCallID]
          ctx.pendingToolUpdates[toolCallID] = pending ? (part) => update(pending(part)) : update
          return
        }
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: MessageV2.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata ?? match.part.state.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            metadata: match.part.state.metadata,
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof Permission.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const discardRetryAttempt = Effect.fn("SessionProcessor.discardRetryAttempt")(function* (
        basePartIDs: Set<PartID>,
      ) {
        for (const call of Object.values(ctx.toolcalls)) {
          yield* Deferred.succeed(call.done, undefined).pipe(Effect.ignore)
        }
        ctx.toolcalls = {}
        ctx.pendingToolUpdates = {}
        ctx.currentText = undefined
        ctx.reasoningMap = {}

        for (const part of MessageV2.parts(ctx.assistantMessage.id)) {
          if (basePartIDs.has(part.id)) continue
          if (part.type === "tool") continue
          yield* session.removePart({
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
          })
        }
      })

      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "start":
            yield* status.set(ctx.sessionID, { type: "busy" })
            return

          case "reasoning-start":
            if (value.id in ctx.reasoningMap) return
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Reasoning.Started.Sync, {
              sessionID: ctx.sessionID,
              reasoningID: value.id,
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            ctx.liveTokenOutputText += value.text
            yield* updateLiveTokenUsage()
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            if (!(value.id in ctx.reasoningMap)) return
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Reasoning.Ended.Sync, {
              sessionID: ctx.sessionID,
              reasoningID: value.id,
              text: ctx.reasoningMap[value.id].text,
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text
            ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePart(ctx.reasoningMap[value.id])
            delete ctx.reasoningMap[value.id]
            return

          case "tool-input-start":
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Input.Started.Sync, {
              sessionID: ctx.sessionID,
              callID: value.id,
              name: value.toolName,
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            const part = yield* session.updatePart({
              id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.id,
              state: { status: "pending", input: {}, raw: "" },
              metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
            } satisfies MessageV2.ToolPart)
            const pending = ctx.pendingToolUpdates[value.id]
            const updatedPart = pending ? yield* session.updatePart(pending(part)) : part
            delete ctx.pendingToolUpdates[value.id]
            ctx.toolcalls[value.id] = {
              done: yield* Deferred.make<void>(),
              partID: updatedPart.id,
              messageID: updatedPart.messageID,
              sessionID: updatedPart.sessionID,
            }
            return

          case "tool-input-delta":
            return

          case "tool-input-end": {
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Input.Ended.Sync, {
              sessionID: ctx.sessionID,
              callID: value.id,
              text: "",
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            return
          }

          case "tool-call": {
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
            }
            const toolCall = yield* readToolCall(value.toolCallId)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Called.Sync, {
              sessionID: ctx.sessionID,
              callID: value.toolCallId,
              tool: value.toolName,
              input: value.input,
              provider: {
                executed: toolCall?.part.metadata?.providerExecuted === true,
                ...(value.providerMetadata ? { metadata: value.providerMetadata } : {}),
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            yield* updateToolCall(value.toolCallId, (match) => ({
              ...match,
              tool: value.toolName,
              state: {
                ...match.state,
                status: "running",
                input: value.input,
                time: { start: Date.now() },
              },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = MessageV2.parts(ctx.assistantMessage.id)
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.toolName &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(value.input),
              )
            ) {
              return
            }

            const agent = yield* agents.get(ctx.assistantMessage.agent)
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.toolName],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.toolName, input: value.input },
              always: [value.toolName],
              ruleset: agent.permission,
            })
            return
          }

          case "tool-result": {
            const toolCall = yield* readToolCall(value.toolCallId)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Success.Sync, {
              sessionID: ctx.sessionID,
              callID: value.toolCallId,
              structured: value.output.metadata,
              content: [
                {
                  type: "text",
                  text: value.output.output,
                },
                ...(value.output.attachments?.map((item: MessageV2.FilePart) => ({
                  type: "file",
                  uri: item.url,
                  mime: item.mime,
                  name: item.filename,
                })) ?? []),
              ],
              provider: {
                executed: toolCall?.part.metadata?.providerExecuted === true,
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            yield* completeToolCall(value.toolCallId, value.output)
            return
          }

          case "tool-error": {
            const toolCall = yield* readToolCall(value.toolCallId)
            // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
            EventV2.run(SessionEvent.Tool.Failed.Sync, {
              sessionID: ctx.sessionID,
              callID: value.toolCallId,
              error: {
                type: "unknown",
                message: errorMessage(value.error),
              },
              provider: {
                executed: toolCall?.part.metadata?.providerExecuted === true,
              },
              timestamp: DateTime.makeUnsafe(Date.now()),
            })
            yield* failToolCall(value.toolCallId, value.error)
            return
          }

          case "raw": {
            const liveUsage = providerLiveUsage(value.rawValue, ctx.assistantMessage.liveUsage)
            if (!liveUsage) return
            ctx.assistantMessage.liveUsage = liveUsage
            yield* session.updateMessage(ctx.assistantMessage)
            return
          }

          case "error":
            throw value.error

          case "start-step":
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Step.Started.Sync, {
                sessionID: ctx.sessionID,
                agent: input.assistantMessage.agent,
                model: {
                  id: Modelv2.ID.make(ctx.model.id),
                  providerID: Modelv2.ProviderID.make(ctx.model.providerID),
                  variant: Modelv2.VariantID.make(input.assistantMessage.variant ?? "default"),
                },
                snapshot: ctx.snapshot,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "finish-step": {
            const completedSnapshot = yield* snapshot.track()
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            const memoryRoot = resolveProjectMemoryRoot(ctx.assistantMessage.path.root, ctx.assistantMessage.path.cwd)
            const persistedUserText = ctx.assistantMessage.parentID
              ? messagePartsText(MessageV2.parts(ctx.assistantMessage.parentID))
              : ""
            const memoryUserText = ctx.memoryQuery || persistedUserText
            const recentContext = memoryConversationWindow(ctx.streamMessages)
            const memoryTurnText = [
              recentContext ? `<recent_context>\n${recentContext}\n</recent_context>` : "",
              memoryUserText ? `USER:\n${memoryUserText}` : "",
              ctx.assistantText.trim() ? `ASSISTANT:\n${ctx.assistantText.trim()}` : "",
            ].filter(Boolean).join("\n\n")
            const memoryMetadata = yield* Effect.promise(async () => {
              if (ctx.assistantMessage.summary) return undefined
              if (!memoryRoot) return undefined
              const config = await readMemoryConfig(memoryRoot)
              const shouldReportInput = config.enabled && config.use
              const used = shouldReportInput
                ? await mendMemoryContext(ctx.model, memoryRoot, ctx.memoryQuery)
                : { enabled: config.enabled, use: config.use, entries: [], lines: [] }
              return {
                input: {
                  enabled: used.enabled,
                  use: used.use,
                  references: used.entries?.map((entry: any) => ({
                    id: entry.id,
                    scope: entry.scope,
                    source: entry.source,
                    evidence: entry.evidence,
                    score: entry.score,
                  })) ?? [],
                  lines: used.lines?.length ?? 0,
                },
                output: {
                  enabled: config.enabled,
                  generate: config.generate,
                  extractorRole: config.extractorRole,
                  queued: false,
                  saved: [],
                  proposals: [],
                },
                callsProviders: false,
              }
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Step.Ended.Sync, {
                sessionID: ctx.sessionID,
                finish: value.finishReason,
                cost: usage.cost,
                tokens: usage.tokens,
                snapshot: completedSnapshot,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.assistantMessage.finish = value.finishReason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            ctx.assistantMessage.liveUsage = undefined
            const shouldQueueMemory = Boolean(
              memoryRoot &&
              memoryMetadata?.output?.enabled &&
              memoryMetadata.output.generate &&
              memoryMetadata.output.extractorRole !== "none" &&
              memoryTurnText.trim(),
            )
            const queuedMemoryMetadata = memoryMetadata
              ? {
                  ...memoryMetadata,
                  output: { ...memoryMetadata.output, queued: shouldQueueMemory },
                }
              : undefined
            const finishPart = yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.finishReason,
              snapshot: completedSnapshot,
              metadata: queuedMemoryMetadata ? { mendMemory: queuedMemoryMetadata } : undefined,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            if (shouldQueueMemory && queuedMemoryMetadata && memoryRoot) {
              const messagePath = ctx.assistantMessage.path
              ctx.pendingMemoryExtraction = {
                memoryMetadata: queuedMemoryMetadata,
                finishPart,
                memoryRoot,
                memoryTurnText,
                messagePath,
                user: ctx.streamUser ?? {
                  id: ctx.assistantMessage.parentID ?? ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  role: "user",
                  agent: ctx.assistantMessage.agent,
                  model: { providerID: ctx.model.providerID, modelID: ctx.model.id },
                  time: { created: ctx.assistantMessage.time.created },
                },
              }
            }
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Text.Started.Sync, {
                sessionID: ctx.sessionID,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            ctx.assistantText += value.text
            ctx.liveTokenOutputText += value.text
            yield* updateLiveTokenUsage()
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            if (!ctx.assistantMessage.summary) {
              // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
              EventV2.run(SessionEvent.Text.Ended.Sync, {
                sessionID: ctx.sessionID,
                text: ctx.currentText.text,
                timestamp: DateTime.makeUnsafe(Date.now()),
              })
            }
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            yield* updateLiveTokenUsage(true)
            ctx.currentText = undefined
            return

          case "finish":
            return

          default:
            slog.info("unhandled", { event: value.type, value })
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          const retainedTaskSessionID =
            part.tool === "task" && typeof metadata.sessionId === "string" ? metadata.sessionId : undefined
          if (retainedTaskSessionID) {
            const childMessages = yield* session
              .messages({ sessionID: SessionID.make(retainedTaskSessionID) })
              .pipe(Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])))
            const childAssistant = childMessages.findLast((item) => item.info.role === "assistant")
            const childAborted =
              childAssistant?.info.role === "assistant" && childAssistant.info.error?.name === "MessageAbortedError"
            if (!childAborted) {
              const partial = messagePartsText(childMessages.flatMap((item) => item.parts))
              yield* session.updatePart({
                ...part,
                state: {
                  status: "completed",
                  input: "input" in part.state ? part.state.input : {},
                  title: "title" in part.state && part.state.title ? part.state.title : "Subagent task retained",
                  metadata: { ...metadata, status: "retained" },
                  output: [
                    `task_id: ${retainedTaskSessionID} (for resuming to continue this task if needed)`,
                    "task_status: retained",
                    "",
                    "<task_result>",
                    partial,
                    "</task_result>",
                    "",
                    `Parent task execution stopped before collecting this subagent result. Resume this subagent chat with task_id ${retainedTaskSessionID} to inspect or continue the work.`,
                  ].join("\n"),
                  time: { start: "time" in part.state ? part.state.time.start : end, end },
                },
              })
              continue
            }
          }
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution interrupted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        slog.error("process", { error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined })
        const error = parse(e)
        if (MessageV2.ContextOverflowError.isInstance(error)) {
          ctx.needsCompaction = true
          yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        if (!ctx.assistantMessage.summary) {
          // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
          EventV2.run(SessionEvent.Step.Failed.Sync, {
            sessionID: ctx.sessionID,
            error: {
              type: "unknown",
              message: errorMessage(e),
            },
            timestamp: DateTime.makeUnsafe(Date.now()),
          })
        }
        ctx.assistantMessage.error = error
        yield* bus.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        slog.info("process")
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          const processBasePartIDs = new Set(MessageV2.parts(ctx.assistantMessage.id).map((part) => part.id))
          let attempt = 0
          let attemptBasePartIDs = new Set<PartID>()
          yield* Effect.gen(function* () {
            if (attempt > 0) {
              try {
                if (!hasPersistedToolResult(MessageV2.parts(ctx.assistantMessage.id))) {
                  yield* discardRetryAttempt(processBasePartIDs)
                }
              } catch {
                yield* discardRetryAttempt(processBasePartIDs)
              }
            }
            attemptBasePartIDs = new Set(MessageV2.parts(ctx.assistantMessage.id).map((part) => part.id))
            attempt++
            ctx.currentText = undefined
            ctx.assistantText = ""
            ctx.liveTokenOutputText = ""
            ctx.liveTokenUpdatedAt = 0
            ctx.reasoningMap = {}
            ctx.streamMessages = streamInput.messages
            ctx.streamUser = streamInput.user
            ctx.assistantMessage.liveUsage = {
              source: "estimate",
              phase: "input",
              input: estimateStreamInputTokens(streamInput),
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            }
            yield* session.updateMessage(ctx.assistantMessage)
            const lastUser = [...streamInput.messages].reverse().find((message) => message.role === "user")
            ctx.memoryQuery = typeof lastUser?.content === "string"
              ? lastUser.content
              : Array.isArray(lastUser?.content)
                ? (lastUser.content.find((part: any) => part?.type === "text" && typeof part.text === "string") as any)?.text ?? null
                : null
            const idleTimeoutMs = llmStreamIdleTimeoutMs()
            const stream = llm.stream(streamInput)

            yield* timeoutStreamUnless(stream, {
              duration: idleTimeoutMs,
              keepWaiting: hasPendingHumanInteraction(),
              onTimeout: () => new Error(`LLM stream timed out after ${idleTimeoutMs}ms without events`),
            }).pipe(
              Stream.tap((event) => handleEvent(event)),
              Stream.takeUntil(() => ctx.needsCompaction),
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                if (input.abort?.aborted !== true) return
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            Effect.catchIf(
              (e) => {
                if (!SessionRetry.retryable(parse(e))) return false
                try {
                  return hasToolAttempt(MessageV2.parts(ctx.assistantMessage.id), attemptBasePartIDs)
                } catch {
                  return false
                }
              },
              (e) =>
                Effect.gen(function* () {
                  slog.warn("retry deferred to next prompt loop after visible tool attempt", {
                    error: errorMessage(e),
                  })
                  yield* status.set(ctx.sessionID, { type: "busy" })
                }),
            ),
            Effect.catchIf(
              (e) => {
                if (!SessionRetry.retryable(parse(e))) return false
                try {
                  return !hasPersistedToolResult(MessageV2.parts(ctx.assistantMessage.id))
                } catch {
                  return true
                }
              },
              (e) =>
                Effect.gen(function* () {
                  yield* discardRetryAttempt(attemptBasePartIDs)
                  return yield* Effect.fail(e)
                }),
            ),
            Effect.retry(
              SessionRetry.policy({
                parse,
                set: (info) => {
                  // TODO(v2): Temporary dual-write while migrating session messages to v2 events.
                  EventV2.run(SessionEvent.Retried.Sync, {
                    sessionID: ctx.sessionID,
                    attempt: info.attempt,
                    error: {
                      message: info.message,
                      isRetryable: true,
                    },
                    timestamp: DateTime.makeUnsafe(Date.now()),
                  })
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      const flushMemory = Effect.fn("SessionProcessor.flushMemory")(function* () {
        const pending = ctx.pendingMemoryExtraction
        ctx.pendingMemoryExtraction = undefined
        if (!pending || ctx.blocked || ctx.assistantMessage.error) return
        yield* status.set(ctx.sessionID, {
          type: "busy",
          kind: "memory-extract",
          message: "Preparing memory proposal...",
        })
        const sessionID = ctx.sessionID
        const messageID = ctx.assistantMessage.id
        const created = yield* proposeAutomaticMemories({
          user: pending.user,
          cwd: pending.messagePath.cwd,
          root: pending.memoryRoot,
          proposal: {
            scope: "project",
            text: pending.memoryTurnText,
            tags: ["tui", "auto"],
            cwd: pending.messagePath.cwd,
            source: "tui-session-auto-extract",
            evidence: `session:${sessionID}:message:${messageID}`,
            maxProposals: 1,
          },
        }).pipe(
          Effect.catchCause((cause) => {
            const reason = errorMessage(Cause.squash(cause))
            log.warn("memory extract", { error: reason })
            return Effect.succeed({
              proposals: [],
              candidates: 0,
              callsProviders: true as const,
              skipped: true,
              reason,
            })
          }),
        )
        const nextMetadata = {
          ...pending.memoryMetadata,
          output: {
            ...pending.memoryMetadata.output,
            queued: false,
            skipped: created.skipped ?? false,
            reason: created.reason ?? null,
            candidates: "candidates" in created ? created.candidates : 0,
            proposals: created.proposals.map((proposal) => ({
              id: proposal.id,
              status: proposal.status,
              sensitivity: proposal.sensitivity,
              confidence: proposal.confidence,
              durability: proposal.durability,
              changeRisk: proposal.changeRisk,
            })),
          },
          callsProviders: created.callsProviders,
        }
        yield* session.updatePart({
          ...pending.finishPart,
          metadata: { ...(pending.finishPart.metadata ?? {}), mendMemory: nextMetadata },
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        flushMemory,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(PlanReview.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SessionProcessor from "./processor"
