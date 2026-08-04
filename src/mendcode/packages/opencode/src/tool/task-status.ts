import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./task-status.txt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { BackgroundTask } from "@/session/background-task"
import { SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import { errorMessage } from "@/util/error"
import { NonNegativeInt } from "@/util/schema"
import { subagentEvidenceText, type TaskPromptOps } from "./task"

const Action = Schema.Literals(["list", "get", "cancel", "wait"])

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description:
      "List or inspect tasks, cancel a registered background task, or wait once for a task to finish; do not use wait as a polling loop.",
  }),
  task_id: Schema.optional(SessionID).annotate({ description: "Child task ID. Required for get, cancel, and wait." }),
  timeout_ms: Schema.optional(NonNegativeInt).annotate({
    description:
      "Maximum wait time in milliseconds for one wait call. Defaults to 30000 and is capped at 300000; a timeout does not justify rapid retries.",
  }),
})

export type State = "ready" | "waiting" | "running" | "retrying" | "completed" | "failed" | "interrupted"

export function taskState(input: { status: SessionStatus.Info; messages: readonly MessageV2.WithParts[] }): State {
  if (input.status.type === "retry") return "retrying"
  if (input.status.type === "busy") return "running"
  const user = input.messages.findLast((message) => message.info.role === "user")
  const assistant = input.messages.findLast((message) => message.info.role === "assistant")
  if (assistant?.info.role === "assistant" && assistant.info.error) return "failed"
  if (user && (!assistant || assistant.info.time.created < user.info.time.created)) return "waiting"
  if (assistant?.info.role === "assistant" && assistant.info.finish) return "completed"
  if (assistant?.info.role === "assistant" && assistant.info.time.completed) return "interrupted"
  if (assistant) return "running"
  return "ready"
}

export const TaskStatusTool = Tool.define(
  "task_status",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const backgroundTasks = yield* BackgroundTask.Service

    const snapshot = Effect.fn("TaskStatusTool.snapshot")(function* (task: Session.Info, limit?: number) {
      const [status, messages] = yield* Effect.all([
        statuses.get(task.id),
        sessions.messages({ sessionID: task.id, limit }),
      ])
      return {
        task,
        status,
        messages,
        state: taskState({ status, messages }),
      }
    })

    const registeredOutput = (input: {
      snapshot: BackgroundTask.Snapshot
      timedOut?: boolean
      action?: "get" | "cancel" | "wait"
    }) => {
      const lines = [
        `task_id: ${input.snapshot.taskID}`,
        `task_status: ${input.snapshot.state}`,
        `task_generation: ${input.snapshot.generation}`,
        `task_revision: ${input.snapshot.revision}`,
        `task_source: registry`,
        `task_root_session_id: ${input.snapshot.rootSessionID}`,
        `task_depth: ${input.snapshot.depth}`,
        `subagent: ${input.snapshot.agent ?? "unknown"}`,
        `title: ${input.snapshot.title}`,
      ]
      if (input.snapshot.leaseExpiresAt) lines.push(`lease_expires_at: ${input.snapshot.leaseExpiresAt}`)
      if (input.snapshot.controlIntent !== "none") lines.push(`control_intent: ${input.snapshot.controlIntent}`)
      if (input.timedOut !== undefined) lines.push(`wait_timed_out: ${input.timedOut}`)
      if (input.snapshot.result?.error) lines.push(`task_error: ${input.snapshot.result.error}`)
      lines.push("", "<task_result>", input.snapshot.result?.summary ?? "", "</task_result>")
      return {
        title:
          input.action === "cancel"
            ? `Cancel ${input.snapshot.title}`
            : input.action === "wait"
              ? `Wait for ${input.snapshot.title}`
              : `Inspect ${input.snapshot.title}`,
        metadata: {
          count: 1,
          sessionId: input.snapshot.taskID,
          status: input.snapshot.state as string,
          generation: input.snapshot.generation,
          revision: input.snapshot.revision,
          timedOut: input.timedOut,
        },
        output: lines.join("\n"),
      }
    }

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const children = (yield* sessions.children(ctx.sessionID)).toSorted(
              (a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id),
            )
            const registered = yield* backgroundTasks.list(ctx.sessionID)
            const registeredIDs = new Set(registered.map((item) => item.taskID))
            const legacy = yield* Effect.forEach(
              children.filter((task) => !registeredIDs.has(task.id)),
              (task) => snapshot(task, 2),
              { concurrency: "unbounded" },
            )
            const items = [
              ...registered.map((item) => ({
                id: item.taskID,
                state: item.state,
                agent: item.agent,
                title: item.title,
                source: "registry",
                      generation: item.generation,
                      depth: item.depth,
                      updated: item.time.updated,
              })),
              ...legacy.map(({ task, state }) => ({
                id: task.id,
                state,
                agent: task.agent,
                title: task.title,
                source: "legacy_derived",
                generation: undefined,
                depth: undefined,
                updated: task.time.updated,
              })),
            ].toSorted((a, b) => b.updated - a.updated || b.id.localeCompare(a.id))
            const output = items.length
              ? items
                  .map((item) =>
                    [
                      `task_id: ${item.id}`,
                      `status: ${item.state}`,
                      item.generation ? `generation: ${item.generation}` : undefined,
                      item.depth !== undefined ? `depth: ${item.depth}` : undefined,
                      `source: ${item.source}`,
                      `subagent: ${item.agent ?? "unknown"}`,
                      `title: ${item.title}`,
                    ]
                      .filter(Boolean)
                      .join(" | "),
                  )
                  .join("\n")
              : "No subagent tasks found for this session."
            return {
              title: "List subagent tasks",
              metadata: { count: items.length, sessionId: ctx.sessionID, status: "list" as string },
              output,
            }
          }

          if (!params.task_id) return yield* Effect.fail(new Error(`task_id is required for action ${params.action}`))
          const task = yield* sessions.get(params.task_id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          if (!task || task.parentID !== ctx.sessionID) {
            return yield* Effect.fail(new Error(`Task ${params.task_id} was not found`))
          }
          const stored = yield* backgroundTasks.get(params.task_id)
          const registered =
            stored && !BackgroundTask.isTerminal(stored.state)
              ? yield* Effect.gen(function* () {
                  const observed = yield* snapshot(task)
                  const currentMessages = observed.messages.filter(
                    (message) => message.info.time.created >= stored.time.queued,
                  )
                  const state = taskState({ status: observed.status, messages: currentMessages })
                  if (state !== "completed" && state !== "failed" && state !== "interrupted") return stored
                  const assistant = currentMessages.findLast((message) => message.info.role === "assistant")
                  const failure = assistant?.info.role === "assistant" ? assistant.info.error : undefined
                  const terminalState =
                    state === "completed" ? "completed" : stored.controlIntent === "cancel" ? "cancelled" : state
                  return yield* backgroundTasks.finish({
                    taskID: stored.taskID,
                    generation: stored.generation,
                    state: terminalState,
                    result: {
                      summary: yield* subagentEvidenceText(currentMessages),
                      error:
                        terminalState === "failed"
                          ? errorMessage(failure ?? "Background task failed")
                          : terminalState === "interrupted"
                            ? "Subagent response ended without a terminal finish"
                            : terminalState === "cancelled"
                              ? "Cancelled by parent session"
                              : undefined,
                    },
                  })
                })
              : stored

          if (params.action === "cancel") {
            if (!registered) {
              return yield* Effect.fail(new Error(`Task ${params.task_id} is a legacy task and cannot be controlled`))
            }
            const requested = yield* backgroundTasks.requestCancel({
              taskID: params.task_id,
              generation: registered.generation,
            })
            if (!requested || BackgroundTask.isTerminal(requested.state)) {
              return registeredOutput({ snapshot: requested ?? registered, action: "cancel" })
            }
            const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
            if (!ops) return yield* Effect.fail(new Error("task_status cancel requires promptOps in ctx.extra"))
            yield* ops.cancel(params.task_id)
            const current = yield* backgroundTasks.get(params.task_id, registered.generation)
            if (current && BackgroundTask.isTerminal(current.state)) {
              return registeredOutput({ snapshot: current, action: "cancel" })
            }
            const messages = yield* sessions
              .messages({ sessionID: params.task_id })
              .pipe(Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])))
            const cancelled = yield* backgroundTasks.finish({
              taskID: params.task_id,
              generation: registered.generation,
              state: "cancelled",
              result: {
                summary: yield* subagentEvidenceText(messages),
                error: "Cancelled by parent session",
              },
            })
            return registeredOutput({ snapshot: cancelled, action: "cancel" })
          }

          if (params.action === "wait") {
            if (!registered) {
              return yield* Effect.fail(new Error(`Task ${params.task_id} is a legacy task and cannot be waited on`))
            }
            const result = yield* backgroundTasks.wait({
              taskID: params.task_id,
              generation: registered.generation,
              timeoutMs: params.timeout_ms,
            })
            if (!result) return yield* Effect.fail(new Error(`Task ${params.task_id} was not found`))
            return registeredOutput({ snapshot: result.snapshot, timedOut: result.timedOut, action: "wait" })
          }

          if (registered) return registeredOutput({ snapshot: registered, action: "get" })

          const item = yield* snapshot(task)
          const assistant = item.messages.findLast((message) => message.info.role === "assistant")
          const result = yield* subagentEvidenceText(item.messages)
          const lines = [
            `task_id: ${task.id}`,
            `task_status: ${item.state}`,
            `task_source: legacy_derived`,
            `subagent: ${task.agent ?? "unknown"}`,
            `title: ${task.title}`,
          ]
          if (item.status.type === "retry") {
            lines.push(`retry_attempt: ${item.status.attempt}`, `retry_message: ${item.status.message}`)
          }
          if (assistant?.info.role === "assistant" && assistant.info.error) {
            lines.push(`task_error: ${errorMessage(assistant.info.error)}`)
          }
          lines.push("", "<task_result>", result, "</task_result>")
          return {
            title: `Inspect ${task.title}`,
            metadata: {
              count: 1,
              sessionId: task.id,
              status: item.state as string,
            },
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
