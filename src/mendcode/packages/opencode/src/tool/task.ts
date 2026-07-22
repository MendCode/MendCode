import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import path from "path"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { BackgroundTask } from "@/session/background-task"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { ConfigModelID } from "@/config/model-id"
import { Provider } from "@/provider/provider"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Permission } from "@/permission"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"
const SUBAGENT_WAIT_STATUS_TTL_MS = 6 * 60 * 60 * 1000
const ORCHESTRATION_ARTIFACT_MAX_CHARS = 24_000
const ORCHESTRATION_ARTIFACTS = [".agents/orchestration/CHAT.md", ".agents/orchestration/STATUS.md"] as const

export function normalizeSubagentType(value: string) {
  return value.trim().replace(/^(sub[/-])+/i, "")
}

function lastText(parts: readonly MessageV2.Part[]) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.type !== "text") continue
    const text = part.text.trim()
    if (text) return text
  }
  return ""
}

const GENERIC_TASK_RESULTS = new Set(["done", "listo", "ok", "complete", "completed"])

function isGenericTaskResult(text: string) {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
  return normalized.length > 0 && normalized.length <= 24 && GENERIC_TASK_RESULTS.has(normalized)
}

function changedFiles(parts: readonly MessageV2.Part[]) {
  return parts.flatMap((part) => (part.type === "patch" ? part.files : []))
}

function unique(items: string[]) {
  return Array.from(new Set(items))
}

function isOrchestrationArtifact(file: string) {
  const normalized = file.replace(/\\/g, "/")
  return ORCHESTRATION_ARTIFACTS.some((artifact) => normalized === artifact || normalized.endsWith(`/${artifact}`))
}

function artifactContent(text: string) {
  const trimmed = text.trim()
  if (trimmed.length <= ORCHESTRATION_ARTIFACT_MAX_CHARS) return trimmed
  return [
    `[orchestration artifact truncated: showing last ${ORCHESTRATION_ARTIFACT_MAX_CHARS} chars]`,
    trimmed.slice(-ORCHESTRATION_ARTIFACT_MAX_CHARS),
  ].join("\n")
}

function messageBases(history: readonly MessageV2.WithParts[]) {
  return unique(
    history.flatMap((message) => {
      const messagePath = "path" in message.info ? message.info.path : undefined
      return [messagePath?.root, messagePath?.cwd].filter((item): item is string => Boolean(item))
    }),
  )
}

function orchestrationArtifactCandidates(input: { history: readonly MessageV2.WithParts[]; files: readonly string[] }) {
  const bases = messageBases(input.history)
  return unique(
    input.files.flatMap((file) => {
      if (!isOrchestrationArtifact(file)) return []
      if (path.isAbsolute(file)) return [file]
      return bases.map((base) => path.join(base, file))
    }),
  )
}

function readOrchestrationArtifacts(input: { history: readonly MessageV2.WithParts[]; files: readonly string[] }) {
  const bases = messageBases(input.history)
  const candidates = orchestrationArtifactCandidates(input).map((file) =>
    path.isAbsolute(file) ? file : path.resolve(bases[0] ?? process.cwd(), file),
  )
  return Effect.forEach(
    unique(candidates),
    (file) =>
      Effect.promise(async () => {
        const content = await Bun.file(file).text()
        const base = bases.find((base) => file.startsWith(`${base}${path.sep}`))
        const display = base ? path.relative(base, file) : file
        return [`--- ${display} ---`, artifactContent(content)].join("\n")
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((items) => items.filter((item): item is string => Boolean(item))))
}

function childEvidenceText(
  history: readonly MessageV2.WithParts[],
  fallbackText: string,
  extraParts: readonly MessageV2.Part[] = [],
) {
  return Effect.gen(function* () {
    const trimmedFallback = fallbackText.trim()
    const text = (() => {
      for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i]
        if (message?.info.role !== "assistant") continue
        for (let j = message.parts.length - 1; j >= 0; j--) {
          const part = message.parts[j]
          if (part?.type !== "text") continue
          const value = part.text.trim()
          if (!value || value === trimmedFallback || isGenericTaskResult(value)) continue
          return value
        }
      }
      return ""
    })()
    const files = unique([...history.flatMap((message) => changedFiles(message.parts)), ...changedFiles(extraParts)])
    const artifacts = yield* readOrchestrationArtifacts({ history, files })
    if (!text && files.length === 0 && artifacts.length === 0) return trimmedFallback

    const lines = trimmedFallback ? [trimmedFallback] : []
    if (text) lines.push("", "Subagent session evidence:", text)
    if (files.length) {
      lines.push("", "Subagent changed files:", ...files.map((file) => `- ${file}`))
    }
    if (artifacts.length) lines.push("", "Subagent orchestration artifacts:", ...artifacts)
    return lines.join("\n")
  })
}

export function subagentEvidenceText(
  history: readonly MessageV2.WithParts[],
  extraParts: readonly MessageV2.Part[] = [],
) {
  return childEvidenceText(
    history,
    lastText([
      ...history.filter((item) => item.info.role === "assistant").flatMap((item) => item.parts),
      ...extraParts,
    ]),
    extraParts,
  )
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "MessageAbortedError") ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "MessageAbortedError")
  )
}

function isExplicitUserAbort(ctx: Tool.Context) {
  const reason = ctx.extra?.abortReason
  if (typeof reason === "function") return reason() === "user"
  if (typeof reason === "string") return reason === "user"
  return ctx.abort.aborted
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const data = "data" in error ? error.data : undefined
    if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string") {
      return data.message
    }
    if ("message" in error && typeof error.message === "string") return error.message
  }
  return String(error)
}

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  model: Schema.optional(ConfigModelID).annotate({
    description:
      "Optional model to use for this subagent in provider/model-id format. Must be one of the models available in MendCode.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Return immediately while the subagent continues. Use task_status with the returned task_id to inspect it later.",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const backgroundTasks = yield* BackgroundTask.Service
    const scope = yield* Scope.Scope

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const subagentType = normalizeSubagentType(params.subagent_type)

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [subagentType],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: subagentType,
          },
        })
      }

      const next = yield* agent.get(subagentType)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${subagentType} is not a valid agent type`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...(parent.permission ?? []).filter(
              (rule) =>
                rule.permission === "external_directory" ||
                rule.permission === Permission.SESSION_MODE_PERMISSION ||
                rule.action === "deny",
            ),
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const requestedModel = params.model ? Provider.parseModel(params.model) : undefined
      const configuredSubagentModel = cfg.subagent_model ? Provider.parseModel(cfg.subagent_model) : undefined
      let model = requestedModel ??
        next.model ??
        configuredSubagentModel ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }
      const variant = requestedModel
        ? undefined
        : next.model
          ? next.variant
          : configuredSubagentModel
            ? cfg.subagent_variant
            : msg.info.variant
      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      if (requestedModel || next.model || configuredSubagentModel) {
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        model = { providerID: resolved.providerID, modelID: resolved.id }
        yield* ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: nextSession.id,
            model,
          },
        })
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const runCancel = yield* EffectBridge.make()
      const abortEvent = yield* Deferred.make<"user" | "external">()

      const messageID = MessageID.ascending()
      const cancel = ops.cancel(nextSession.id)
      let parentAborted = isExplicitUserAbort(ctx)

      const output = (input: {
        status: "started" | "completed" | "interrupted" | "failed" | "retained"
        text?: string
        error?: unknown
      }) => {
        const lines = [
          `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
          `task_status: ${input.status}`,
        ]
        if (input.error) {
          lines.push(`task_error: ${errorText(input.error)}`)
        }
        lines.push("", "<task_result>", input.text ?? "", "</task_result>")
        if (input.status === "retained") {
          lines.push(
            "",
            `Parent execution stopped before the subagent finished. Resume this subagent chat with task_id ${nextSession.id} to inspect or continue the work.`,
          )
        } else if (input.status !== "completed" && input.status !== "started") {
          lines.push("", `Resume this subagent chat with task_id ${nextSession.id} to inspect or continue the work.`)
        }
        return {
          title: params.description,
          metadata: {
            sessionId: nextSession.id,
            model,
            status: input.status,
          },
          output: lines.join("\n"),
        }
      }

      const errorOutput = (input: {
        error: unknown
        interrupted: boolean
        status?: "failed" | "interrupted" | "retained"
        extraParts?: readonly MessageV2.Part[]
      }) =>
        Effect.gen(function* () {
          const history = yield* sessions
            .messages({ sessionID: nextSession.id })
            .pipe(Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])))
          const extraParts = input.extraParts ?? []
          const partial = yield* subagentEvidenceText(history, extraParts)
          return output({
            status: input.status ?? (input.interrupted ? "interrupted" : "failed"),
            text: partial,
            error: input.error,
          })
        })

      function onAbort() {
        const reason = isExplicitUserAbort(ctx) ? "user" : "external"
        parentAborted = reason === "user"
        runCancel.fork(Deferred.succeed(abortEvent, reason))
        if (parentAborted) runCancel.fork(cancel)
      }

      const prompt = Effect.gen(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        return yield* ops.prompt({
          messageID,
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant,
          agent: next.name,
          tools: {
            ...(canTodo ? {} : { todowrite: false }),
            ...(canTask ? {} : { task: false }),
            ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          },
          parts,
        })
      })

      if (params.background) {
        const task = yield* backgroundTasks.start({
          taskID: nextSession.id,
          parentSessionID: ctx.sessionID,
          originMessageID: ctx.messageID,
          originCallID: ctx.callID,
          title: params.description,
          agent: next.name,
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
            variant,
          },
        })
        const running = yield* backgroundTasks.markRunning({ taskID: nextSession.id, generation: task.generation })
        yield* status.set(nextSession.id, { type: "busy" })
        yield* prompt.pipe(
          Effect.flatMap((message) =>
            Effect.gen(function* () {
              const history = yield* sessions
                .messages({ sessionID: nextSession.id })
                .pipe(Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])))
              const text = yield* subagentEvidenceText(history, message.parts)
              const error = message.info.role === "assistant" ? message.info.error : undefined
              const current = yield* backgroundTasks.get(nextSession.id, task.generation)
              const state = error
                ? current?.controlIntent === "cancel" && isAbortError(error)
                  ? "cancelled"
                  : isAbortError(error)
                    ? "interrupted"
                    : "failed"
                : "completed"
              yield* backgroundTasks.finish({
                taskID: nextSession.id,
                generation: task.generation,
                state,
                result: {
                  summary: text,
                  error: error ? errorText(error) : undefined,
                  changedFiles: unique(history.flatMap((item) => changedFiles(item.parts))),
                },
              })
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const error = Cause.squash(cause)
              const history = yield* sessions
                .messages({ sessionID: nextSession.id })
                .pipe(Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])))
              const current = yield* backgroundTasks.get(nextSession.id, task.generation)
              yield* backgroundTasks.finish({
                taskID: nextSession.id,
                generation: task.generation,
                state:
                  current?.controlIntent === "cancel" && (Cause.hasInterrupts(cause) || isAbortError(error))
                    ? "cancelled"
                    : Cause.hasInterrupts(cause) || isAbortError(error)
                      ? "interrupted"
                      : "failed",
                result: {
                  summary: yield* subagentEvidenceText(history),
                  error: errorText(error),
                  changedFiles: unique(history.flatMap((item) => changedFiles(item.parts))),
                },
              })
            }).pipe(Effect.catchCause(() => Effect.void)),
          ),
          Effect.ensuring(status.set(nextSession.id, { type: "idle" })),
          Effect.forkIn(scope),
        )
        const started = output({
          status: "started",
          text: `Subagent started in the background. Use task_status with task_id ${nextSession.id} to inspect progress or collect the result.`,
        })
        return {
          ...started,
          metadata: {
            ...started.metadata,
            generation: task.generation,
            revision: running.revision,
          },
        }
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
          if (ctx.abort.aborted) onAbort()
        }),
        () =>
          Effect.gen(function* () {
            const child = yield* prompt.pipe(Effect.forkIn(scope))

            yield* status.set(ctx.sessionID, {
              type: "busy",
              kind: "subagent-wait",
              message: `Waiting for ${next.name} subagent...`,
              until: Date.now() + SUBAGENT_WAIT_STATUS_TTL_MS,
            })

            const result = yield* Fiber.await(child).pipe(
              Effect.map((exit) => ({ type: "exit" as const, exit })),
              Effect.raceFirst(
                Deferred.await(abortEvent).pipe(Effect.map((reason) => ({ type: "abort" as const, reason }))),
              ),
              Effect.flatMap((outcome) => {
                if (outcome.type === "abort") {
                  return errorOutput({
                    error: new DOMException(
                      outcome.reason === "user" ? "Aborted" : "Connection interrupted; subagent session retained",
                      "AbortError",
                    ),
                    interrupted: outcome.reason === "user",
                    status: outcome.reason === "user" ? "interrupted" : "retained",
                  })
                }
                if (Exit.isFailure(outcome.exit)) {
                  const error = Cause.squash(outcome.exit.cause)
                  return errorOutput({
                    error,
                    interrupted: parentAborted && (Cause.hasInterrupts(outcome.exit.cause) || isAbortError(error)),
                  })
                }
                const childMessage = outcome.exit.value
                const error = childMessage.info.role === "assistant" ? childMessage.info.error : undefined
                if (error)
                  return errorOutput({ error, interrupted: isAbortError(error), extraParts: childMessage.parts })
                return sessions.messages({ sessionID: nextSession.id }).pipe(
                  Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])),
                  Effect.flatMap((history) =>
                    Effect.map(subagentEvidenceText(history, childMessage.parts), (text) =>
                      output({
                        status: "completed",
                        text,
                      }),
                    ),
                  ),
                )
              }),
              Effect.ensuring(status.set(ctx.sessionID, { type: "busy" })),
            )

            return result
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit) && parentAborted) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
