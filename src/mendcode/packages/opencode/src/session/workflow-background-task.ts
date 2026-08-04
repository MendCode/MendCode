import { Context, Effect, Layer } from "effect"

import { Permission } from "@/permission"
import type { WorkspaceID } from "@/control-plane/schema"
import { BackgroundTask } from "./background-task"
import { WorkflowRunTable } from "./session.sql"
import { Session } from "./session"
import { SessionID } from "./schema"
import { WorkflowRunID, WorkflowTaskID } from "./workflow"
import type { WorkflowModelRoute } from "./workflow"
import { Database, eq } from "@/storage/db"
import { ModelID, ProviderID } from "@/provider/schema"

export interface WorkflowRootInput {
  readonly runID: WorkflowRunID
  readonly title: string
  readonly agent?: string
  readonly model?: WorkflowModelRoute
  readonly permission?: Permission.Ruleset
  readonly workspaceID?: WorkspaceID
}

export interface WorkflowRoot {
  readonly runID: WorkflowRunID
  readonly sessionID: SessionID
}

export interface WorkflowAttemptInput {
  readonly runID: WorkflowRunID
  readonly taskID: WorkflowTaskID
  readonly parentSessionID: SessionID
  readonly rootSessionID: SessionID
  readonly title: string
  readonly agent?: string
  readonly model?: WorkflowModelRoute
  readonly permission?: Permission.Ruleset
  readonly workspaceID?: WorkspaceID
  readonly depth: number
  readonly maxChildren?: number
  readonly maxDescendants?: number
  readonly sessionID?: SessionID
}

export interface WorkflowAttempt {
  readonly runID: WorkflowRunID
  readonly taskID: WorkflowTaskID
  readonly sessionID: SessionID
  readonly generation: number
  readonly revision: number
}

export interface Interface {
  readonly ensureRoot: (input: WorkflowRootInput) => Effect.Effect<WorkflowRoot>
  readonly startAttempt: (input: WorkflowAttemptInput) => Effect.Effect<WorkflowAttempt, unknown>
  readonly getAttempt: (input: {
    readonly sessionID: SessionID
    readonly generation?: number
  }) => Effect.Effect<BackgroundTask.Snapshot | undefined>
  readonly listChildren: (parentSessionID: SessionID) => Effect.Effect<readonly BackgroundTask.Snapshot[]>
  readonly finishAttempt: (input: BackgroundTask.FinishInput) => Effect.Effect<BackgroundTask.Snapshot>
  readonly cancelAttempt: (input: { readonly sessionID: SessionID; readonly generation?: number }) => Effect.Effect<BackgroundTask.Snapshot | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowBackgroundTask") {}

const toSessionModel = (model: WorkflowModelRoute | undefined) =>
  model
    ? {
        id: ModelID.make(model.modelID),
        providerID: ProviderID.make(model.providerID),
        ...(model.variant === undefined ? {} : { variant: model.variant }),
      }
    : undefined

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const backgroundTasks = yield* BackgroundTask.Service

    const ensureRoot = Effect.fn("WorkflowBackgroundTask.ensureRoot")(function* (input: WorkflowRootInput) {
      const existingID = Database.use((db) =>
        db.select({ rootSessionID: WorkflowRunTable.root_session_id })
          .from(WorkflowRunTable)
          .where(eq(WorkflowRunTable.id, input.runID))
          .get()?.rootSessionID,
      )
      if (existingID) {
        const existing = yield* sessions.get(existingID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (existing) return { runID: input.runID, sessionID: existing.id }
      }

      const session = yield* sessions.create({
        title: input.title,
        agent: input.agent,
        model: toSessionModel(input.model),
        permission: input.permission,
        workspaceID: input.workspaceID,
      })
      Database.use((db) =>
        db.update(WorkflowRunTable)
          .set({ root_session_id: session.id, time_updated: Date.now() })
          .where(eq(WorkflowRunTable.id, input.runID))
          .run(),
      )
      return { runID: input.runID, sessionID: session.id }
    })

    const startAttempt = Effect.fn("WorkflowBackgroundTask.startAttempt")(function* (input: WorkflowAttemptInput) {
      const session = input.sessionID
        ? yield* sessions.get(input.sessionID)
        : yield* sessions.create({
            parentID: input.parentSessionID,
            title: input.title,
            agent: input.agent,
            model: toSessionModel(input.model),
            permission: input.permission,
            workspaceID: input.workspaceID,
          })
      const task = yield* backgroundTasks.start({
        taskID: session.id,
        parentSessionID: input.parentSessionID,
        rootSessionID: input.rootSessionID,
        depth: Math.max(1, Math.floor(input.depth)),
        limits: {
          ...(input.maxChildren === undefined ? {} : { maxChildren: input.maxChildren }),
          ...(input.maxDescendants === undefined ? {} : { maxDescendants: input.maxDescendants }),
        },
        startRunning: true,
        title: input.title,
        agent: input.agent,
        model: input.model
          ? {
              providerID: input.model.providerID,
              modelID: input.model.modelID,
              ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
            }
          : undefined,
      })
      return {
        runID: input.runID,
        taskID: input.taskID,
        sessionID: session.id,
        generation: task.generation,
        revision: task.revision,
      }
    })

    const getAttempt = (input: { readonly sessionID: SessionID; readonly generation?: number }) =>
      backgroundTasks.get(input.sessionID, input.generation)

    const listChildren = (parentSessionID: SessionID) => backgroundTasks.list(parentSessionID)

    const finishAttempt = (input: BackgroundTask.FinishInput) => backgroundTasks.finish(input)

    const cancelAttempt = (input: { readonly sessionID: SessionID; readonly generation?: number }) =>
      backgroundTasks.requestCancel({ taskID: input.sessionID, generation: input.generation })

    return Service.of({ ensureRoot, startAttempt, getAttempt, listChildren, finishAttempt, cancelAttempt })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(BackgroundTask.defaultLayer), Layer.provide(Session.defaultLayer))

export * as WorkflowBackgroundTask from "./workflow-background-task"
