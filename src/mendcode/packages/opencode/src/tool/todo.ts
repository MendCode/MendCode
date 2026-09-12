import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"
import { InstanceState } from "@/effect/instance-state"
import path from "node:path"

// Todo.Info is still a zod schema (session/todo.ts). Inline the field shape
// here rather than referencing its `.shape` — the LLM-visible JSON Schema is
// identical, and it removes the last zod dependency from this tool.
const TodoItem = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
})

const TargetLock = Schema.Struct({
  expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "Current target-lock revision; use 0 only when creating the first lock",
  }),
  target_id: Schema.String.annotate({ description: "Exact operation target ID" }),
  artifact: Schema.String.annotate({ description: "Exact artifact path" }),
  sha256: Schema.String.annotate({ description: "Lowercase SHA-256 of the artifact" }),
  port: Schema.String.annotate({ description: "Exact device or port, for example COM9" }),
  stage: Schema.Literals(["transfer", "flash", "verify"]),
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoItem)).annotate({ description: "The updated todo list" }),
  target_lock: Schema.optional(TargetLock).annotate({
    description: "Required operation identity for transfer, flash, or verify tasks",
  }),
})

type Metadata = {
  todos: Todo.Info[]
  targetLock?: Todo.TargetLockState
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const targetLock = params.target_lock
            ? yield* todo.setTargetLock({
                sessionID: ctx.sessionID,
                expectedRevision: params.target_lock.expected_revision,
                target: {
                  targetID: params.target_lock.target_id,
                  artifact: path.isAbsolute(params.target_lock.artifact)
                    ? path.normalize(params.target_lock.artifact)
                    : path.resolve(instance.directory, params.target_lock.artifact),
                  sha256: params.target_lock.sha256.toLowerCase(),
                  port: params.target_lock.port,
                  stage: params.target_lock.stage,
                },
              })
            : undefined

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos: params.todos,
          })

          return {
            title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(
              { todos: params.todos, ...(targetLock ? { target_lock: targetLock } : {}) },
              null,
              2,
            ),
            metadata: {
              todos: params.todos,
              ...(targetLock ? { targetLock } : {}),
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
