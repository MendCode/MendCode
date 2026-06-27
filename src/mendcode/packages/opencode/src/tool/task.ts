import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { ConfigModelID } from "@/config/model-id"
import { Provider } from "@/provider/provider"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"

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
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, "")
  return normalized.length > 0 && normalized.length <= 24 && GENERIC_TASK_RESULTS.has(normalized)
}

function changedFiles(parts: readonly MessageV2.Part[]) {
  return parts.flatMap((part) => (part.type === "patch" ? part.files : []))
}

function unique(items: string[]) {
  return Array.from(new Set(items))
}

function childEvidenceText(history: readonly MessageV2.WithParts[], fallbackText: string, extraParts: readonly MessageV2.Part[] = []) {
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
  const files = unique([
    ...history.flatMap((message) => changedFiles(message.parts)),
    ...changedFiles(extraParts),
  ])
  if (!text && files.length === 0) return trimmedFallback

  const lines = trimmedFallback ? [trimmedFallback] : []
  if (text) lines.push("", "Subagent session evidence:", text)
  if (files.length) {
    lines.push("", "Subagent changed files:", ...files.map((file) => `- ${file}`))
  }
  return lines.join("\n")
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
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
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
              (rule) => rule.permission === "external_directory" || rule.action === "deny",
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

      const output = (input: { status: "completed" | "interrupted" | "failed" | "retained"; text?: string; error?: unknown }) => {
        const lines = [
          `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
          `task_status: ${input.status}`,
        ]
        if (input.error) {
          lines.push(`task_error: ${errorText(input.error)}`)
        }
        lines.push("", "<task_result>", input.text ?? "", "</task_result>")
        if (input.status === "retained") {
          lines.push("", `Parent execution stopped before the subagent finished. Resume this subagent chat with task_id ${nextSession.id} to inspect or continue the work.`)
        } else if (input.status !== "completed") {
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

      const errorOutput = (input: { error: unknown; interrupted: boolean; status?: "failed" | "interrupted" | "retained" }) =>
        Effect.gen(function* () {
          const history = yield* sessions
            .messages({ sessionID: nextSession.id })
            .pipe(Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])))
          const partial = childEvidenceText(history, lastText(history.flatMap((item) => item.parts)))
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

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
          if (ctx.abort.aborted) onAbort()
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const child = yield* ops
              .prompt({
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
              .pipe(Effect.forkIn(scope))

            const result = yield* Fiber.await(child)
              .pipe(
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
                  if (error) return errorOutput({ error, interrupted: isAbortError(error) })
                  return sessions
                    .messages({ sessionID: nextSession.id })
                    .pipe(
                      Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])),
                      Effect.map((history) => output({
                        status: "completed",
                        text: childEvidenceText(history, lastText(childMessage.parts), childMessage.parts),
                      })),
                    )
                }),
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
