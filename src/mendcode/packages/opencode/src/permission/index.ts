import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { ConfigPermission } from "@/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { ProjectID } from "@/project/schema"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { zod } from "@/util/effect-zod"
import * as Log from "@mendcode/core/util/log"
import { withStatics } from "@/util/schema"
import { Wildcard } from "@/util/wildcard"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import os from "os"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"
import { markPermissionAbandoned, markPermissionPending, markPermissionResolved } from "@/session/pending-input"
import {
  isSafeSmartAutoApprovalRequest as isSafeSmartAutoApprovalRequestForShell,
  reviewPermissionRequestWithModel,
} from "@/mend/permission/smart-approval"
import {
  actionFingerprint,
  appendSmartReview,
  authorityForRequest,
  createSmartGrant,
  emptySmartStore,
  factsForRequest,
  matchingSmartGrant,
  normalizeSmartStore,
  revokeSmartGrant,
  summarizeSmartReason,
  type SmartGrant,
  type SmartReviewRecord,
  type SmartStore,
} from "@/mend/permission/smart-service"

const log = Log.create({ service: "permission" })

export const Action = Schema.Literals(["allow", "deny", "ask"])
  .annotate({ identifier: "PermissionAction" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Action = Schema.Schema.Type<typeof Action>

export const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
})
  .annotate({ identifier: "PermissionRule" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Rule = Schema.Schema.Type<typeof Rule>

export const Ruleset = Schema.mutable(Schema.Array(Rule))
  .annotate({ identifier: "PermissionRuleset" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Ruleset = Schema.Schema.Type<typeof Ruleset>

export const SESSION_MODE_PERMISSION = "__mendcode_session_permission_mode__"
export type SessionPermissionMode = "approval" | "smart" | "full_access"

export function sessionModeRule(mode: SessionPermissionMode): Rule {
  return { permission: SESSION_MODE_PERMISSION, pattern: mode, action: "allow" }
}

export function withSessionMode(ruleset: Ruleset, mode: SessionPermissionMode): Ruleset {
  return [...ruleset.filter((rule) => rule.permission !== SESSION_MODE_PERMISSION), sessionModeRule(mode)]
}

function isShellPermissionRequest(request: Pick<Request, "permission" | "metadata">) {
  return (
    request.permission === "bash" ||
    (request.permission === "external_directory" && request.metadata.source === "shell")
  )
}

function requiresHarnessApproval(request: Pick<Request, "metadata">) {
  return request.metadata.harnessApproval === true
}

export class Request extends Schema.Class<Request>("PermissionRequest")({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
}) {
  static readonly zod = zod(this)
}

export function isSafeSmartAutoApprovalRequest(request: Request) {
  return request.permission !== "external_directory" && isSafeSmartAutoApprovalRequestForShell(request)
}

export const Reply = Schema.Literals(["once", "always", "reject"]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Reply = Schema.Schema.Type<typeof Reply>

const reply = {
  reply: Reply,
  message: Schema.optional(Schema.String),
  smart: Schema.optional(
    Schema.Struct({
      actionFingerprint: Schema.optional(Schema.String),
      contextRevision: Schema.optional(Schema.Int),
      grant: Schema.optional(Schema.Literals(["once", "task"])),
    }),
  ),
}

export const ReplyBody = Schema.Struct(reply)
  .annotate({ identifier: "PermissionReplyBody" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyBody = Schema.Schema.Type<typeof ReplyBody>

export class Approval extends Schema.Class<Approval>("PermissionApproval")({
  projectID: ProjectID,
  patterns: Schema.Array(Schema.String),
}) {
  static readonly zod = zod(this)
}

export const Event = {
  Asked: BusEvent.define("permission.asked", Request),
  Replied: BusEvent.define(
    "permission.replied",
    Schema.Struct({
      sessionID: SessionID,
      requestID: PermissionID,
      reply: Reply,
    }),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export type Error = DeniedError | RejectedError | CorrectedError

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(PermissionID),
  ruleset: Ruleset,
})
  .annotate({ identifier: "PermissionAskInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AskInput = Schema.Schema.Type<typeof AskInput>

export const ReplyInput = Schema.Struct({
  requestID: PermissionID,
  ...reply,
})
  .annotate({ identifier: "PermissionReplyInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

export type StoredRequest = {
  info: Request
  ownerRuntimeID: string
  directory: string
  reply?: Reply
  message?: string
  timeCreated: number
  timeUpdated: number
}

export type { SmartGrant, SmartReviewRecord, SmartStore }

export type StoreData =
  | Ruleset
  | {
      version: 2
      approved: Ruleset
      requests: StoredRequest[]
      smart?: SmartStore
    }

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<boolean>
  readonly replyForSessions: (input: {
    sessionIDs: readonly SessionID[]
    reply: Reply
    filter?: (request: Request) => boolean
  }) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly listReviews: (input: {
    sessionID?: string
    cursor?: string
    limit?: number
  }) => Effect.Effect<{ items: ReadonlyArray<SmartReviewRecord>; nextCursor?: string }>
  readonly revokeGrant: (grantID: string) => Effect.Effect<boolean>
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
}

type Store = Exclude<StoreData, Ruleset>
const runtimeID = `permission:${process.pid}:${crypto.randomUUID()}`

function normalizeStore(data: StoreData | undefined): Store {
  if (Array.isArray(data)) return { version: 2, approved: [], requests: [], smart: emptySmartStore() }
  return {
    version: 2,
    // "Always" means for this MendCode runtime. Never restore grants left by
    // an older process, including legacy rows that persisted them.
    approved: [],
    requests: [...(data?.requests ?? [])],
    smart: normalizeSmartStore(data?.smart),
  }
}

function ownerProcessAlive(ownerRuntimeID: string) {
  const match = ownerRuntimeID.match(/^permission:(\d+):/)
  if (!match) return false
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EPERM"
    )
  }
}

function updateStore<T>(projectID: ProjectID, update: (store: Store) => T): T {
  return Database.transaction(
    (db) => {
      const current = db.select().from(PermissionTable).where(eq(PermissionTable.project_id, projectID)).get()
      const store = normalizeStore(current?.data)
      const result = update(store)
      const now = Date.now()
      db.insert(PermissionTable)
        .values({ project_id: projectID, time_created: current?.time_created ?? now, time_updated: now, data: store })
        .onConflictDoUpdate({ target: PermissionTable.project_id, set: { time_updated: now, data: store } })
        .run()
      return { result }
    },
    { behavior: "immediate" },
  ).result
}

function cleanDeadRequests(store: Store) {
  const abandoned = store.requests.filter((request) => !ownerProcessAlive(request.ownerRuntimeID))
  if (abandoned.length) {
    const ids = new Set(abandoned.map((request) => request.info.id))
    store.requests = store.requests.filter((request) => !ids.has(request.info.id))
  }
  return abandoned
}

function readRequest(projectID: ProjectID, requestID: PermissionID) {
  const row = Database.use((db) =>
    db.select().from(PermissionTable).where(eq(PermissionTable.project_id, projectID)).get(),
  )
  return normalizeStore(row?.data).requests.find((request) => request.info.id === requestID)
}

function smartRequestDetails(request: Request) {
  const authority = authorityForRequest(request.metadata)
  const facts = factsForRequest(request.metadata)
  return {
    authority,
    facts,
    actionFingerprint: actionFingerprint({
      permission: request.permission,
      patterns: request.patterns,
      actionFacts: facts,
    }),
  }
}

function isSmartManagedRequest(request: Request) {
  return request.metadata.smartApproval === true
}

function smartReviewRecord(input: {
  request: Request
  status: SmartReviewRecord["status"]
  source: SmartReviewRecord["source"]
  reason: string
  fingerprint: string
  now?: number
}): SmartReviewRecord {
  const now = input.now ?? Date.now()
  return {
    id: `smart-review:${input.request.id}`,
    requestID: String(input.request.id),
    sessionID: input.request.sessionID,
    actionFingerprint: input.fingerprint,
    status: input.status,
    source: input.source,
    reasonCode: input.status === "allowed" ? "allowed" : input.status === "denied" ? "denied" : "manual_required",
    summary: summarizeSmartReason(input.reason),
    createdAt: now,
    updatedAt: now,
  }
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return evalRule(permission, pattern, ...rulesets)
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const row = Database.use((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        const state = {
          pending: new Map<PermissionID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const abandoned = updateStore(ctx.project.id, (store) => {
              const owned = store.requests.filter(
                (request) => request.ownerRuntimeID === runtimeID && request.directory === ctx.directory,
              )
              const ids = new Set(owned.map((request) => request.info.id))
              store.requests = store.requests.filter((request) => !ids.has(request.info.id))
              return owned
            })
            for (const request of abandoned) markPermissionAbandoned(request.info.sessionID)
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const local = yield* InstanceState.get(state)
      const pending = local.pending
      const context = yield* InstanceState.context
      const loaded = yield* Effect.sync(() =>
        updateStore(context.project.id, (store) => ({
          approved: [...store.approved],
          smart: normalizeSmartStore(store.smart),
          abandoned: cleanDeadRequests(store),
        })),
      )
      for (const request of loaded.abandoned) markPermissionAbandoned(request.info.sessionID)
      const { ruleset, ...request } = input
      const modeRule = ruleset.findLast((rule) => rule.permission === SESSION_MODE_PERMISSION)
      const mode = modeRule?.pattern
      const evaluationRuleset = modeRule
        ? ruleset.filter((rule) => rule.permission !== SESSION_MODE_PERMISSION)
        : ruleset
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, evaluationRuleset, loaded.approved, local.approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new DeniedError({
            ruleset: evaluationRuleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (request.permission === "computer_activation") {
          const exactAllow = [...evaluationRuleset, ...loaded.approved, ...local.approved].some(
            (candidate) =>
              candidate.permission === request.permission &&
              candidate.pattern === pattern &&
              candidate.action === "allow",
          )
          if (exactAllow) continue
          needsAsk = true
          continue
        }
        if (mode === "full_access") continue
        if (requiresHarnessApproval(request) && (mode === "approval" || mode === "smart")) {
          const runtimeRule = evaluate(request.permission, pattern, local.approved)
          if (runtimeRule.action === "allow" && runtimeRule.pattern === pattern) continue
          needsAsk = true
          continue
        }
        if (isShellPermissionRequest(request) && (mode === "approval" || mode === "smart")) {
          needsAsk = true
          continue
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionID.ascending()
      let info = Schema.decodeUnknownSync(Request)({
        id,
        ...request,
        metadata: {
          ...request.metadata,
          ...(mode === "smart" ? { smartApproval: true } : {}),
        },
      })
      const smart = smartRequestDetails(info)
      if (mode === "smart") {
        info = {
          ...info,
          metadata: { ...info.metadata, smartActionFingerprint: smart.actionFingerprint },
        }
      }
      if (
        mode === "smart" &&
        matchingSmartGrant(loaded.smart, {
          permission: info.permission,
          actionFingerprint: smart.actionFingerprint,
          sessionID: info.sessionID,
          authority: smart.authority,
        })
      ) {
        yield* Effect.sync(() => {
          updateStore(context.project.id, (store) => {
            appendSmartReview(
              store.smart ?? (store.smart = emptySmartStore()),
              smartReviewRecord({
                request: info,
                status: "allowed",
                source: "grant",
                reason: "Exact Smart task grant matched this action.",
                fingerprint: smart.actionFingerprint,
              }),
            )
          })
        })
        return
      }
      if (mode === "smart" && isSafeSmartAutoApprovalRequest(info)) {
        yield* Effect.sync(() => {
          updateStore(context.project.id, (store) => {
            appendSmartReview(
              store.smart ?? (store.smart = emptySmartStore()),
              smartReviewRecord({
                request: info,
                status: "allowed",
                source: "deterministic",
                reason: "Bounded low-risk action matched the deterministic Smart lane.",
                fingerprint: smart.actionFingerprint,
              }),
            )
          })
        })
        return
      }
      if (mode === "smart" && isSmartManagedRequest(info)) {
        yield* Effect.sync(() => {
          updateStore(context.project.id, (store) => {
            appendSmartReview(
              store.smart ?? (store.smart = emptySmartStore()),
              smartReviewRecord({
                request: info,
                status: "reviewing",
                source: "model",
                reason: "Smart Approval is checking the bounded action and its causal user request.",
                fingerprint: smart.actionFingerprint,
              }),
            )
          })
        })
        const controller = new AbortController()
        const reviewed = yield* Effect.promise(async () => {
          try {
            return await reviewPermissionRequestWithModel(info, context.worktree, {
              userPrompt: smart.authority?.userText,
              authorityContext: smart.authority,
              actionFacts: smart.facts,
              signal: controller.signal,
              deadlineMs: 20_000,
            })
          } catch {
            return {
              triggered: true,
              decision: "ask" as const,
              reason: "Permission reviewer failed; manual approval is required.",
            }
          }
        }).pipe(Effect.ensuring(Effect.sync(() => controller.abort())))
        if (reviewed.decision === "allow") {
          yield* Effect.sync(() => {
            updateStore(context.project.id, (store) => {
              appendSmartReview(
                store.smart ?? (store.smart = emptySmartStore()),
                smartReviewRecord({
                  request: info,
                  status: "allowed",
                  source: reviewed.source ?? "model",
                  reason: reviewed.reason,
                  fingerprint: smart.actionFingerprint,
                }),
              )
            })
          })
          return
        }
        if (reviewed.decision === "reject") {
          yield* Effect.sync(() => {
            updateStore(context.project.id, (store) => {
              appendSmartReview(
                store.smart ?? (store.smart = emptySmartStore()),
                smartReviewRecord({
                  request: info,
                  status: "denied",
                  source: reviewed.source ?? "model",
                  reason: reviewed.reason,
                  fingerprint: smart.actionFingerprint,
                }),
              )
            })
          })
          return yield* new DeniedError({ ruleset: [] })
        }
        info = {
          ...info,
          metadata: {
            ...info.metadata,
            smartReviewSummary: summarizeSmartReason(reviewed.reason),
            smartRisk: reviewed.risk ?? "unknown",
            smartAuthorization: reviewed.authorization ?? "unknown",
          },
        }
        yield* Effect.sync(() => {
          updateStore(context.project.id, (store) => {
            appendSmartReview(
              store.smart ?? (store.smart = emptySmartStore()),
              smartReviewRecord({
                request: info,
                status: "waiting_manual",
                source: "model",
                reason: reviewed.reason,
                fingerprint: smart.actionFingerprint,
              }),
            )
          })
        })
      }
      log.info("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(id, { info, deferred })
      yield* Effect.sync(() => {
        updateStore(context.project.id, (store) => {
          store.requests = store.requests.filter((item) => item.info.id !== id)
          store.requests.push({
            info,
            ownerRuntimeID: runtimeID,
            directory: context.directory,
            timeCreated: Date.now(),
            timeUpdated: Date.now(),
          })
        })
        markPermissionPending(info)
      })
      yield* bus.publish(Event.Asked, info)
      return yield* Effect.gen(function* () {
        const persistedReply = Effect.gen(function* () {
          while (!readRequest(context.project.id, id)?.reply) yield* Effect.sleep("200 millis")
        })
        yield* Deferred.await(deferred).pipe(Effect.raceFirst(persistedReply))
        const decision = readRequest(context.project.id, id)
        if (decision?.reply === "always") {
          local.approved.push(
            ...decision.info.always.map((pattern) => ({
              permission: decision.info.permission,
              pattern,
              action: "allow" as const,
            })),
          )
        }
        if (decision?.reply !== "reject") return
        if (decision.message) return yield* new CorrectedError({ feedback: decision.message })
        return yield* new RejectedError()
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id)
            const removed = updateStore(context.project.id, (store) => {
              const existing = store.requests.find((item) => item.info.id === id)
              store.requests = store.requests.filter((item) => item.info.id !== id)
              return existing
                ? !store.requests.some((item) => item.info.sessionID === info.sessionID && item.reply === undefined)
                : false
            })
            if (removed) markPermissionResolved(info.sessionID)
          }),
        ),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      const pending = (yield* InstanceState.get(state)).pending
      const context = yield* InstanceState.context
      const released = yield* Effect.sync(() =>
        updateStore(context.project.id, (store) => {
          const existing = store.requests.find(
            (request) => request.info.id === input.requestID && request.reply === undefined,
          )
          if (!existing) return []
          const managedBySmart = isSmartManagedRequest(existing.info)
          const details = smartRequestDetails(existing.info)
          const hasServerFingerprint = typeof existing.info.metadata.smartActionFingerprint === "string"
          if (
            managedBySmart &&
            input.reply !== "reject" &&
            (!input.smart ||
              (hasServerFingerprint && input.smart.actionFingerprint !== details.actionFingerprint) ||
              (!hasServerFingerprint && input.smart.grant !== "once"))
          ) {
            return []
          }
          if (
            managedBySmart &&
            input.reply !== "reject" &&
            details.authority?.contextRevision !== undefined &&
            input.smart?.contextRevision !== details.authority.contextRevision
          ) {
            return []
          }
          const approvals =
            input.reply === "always" && !managedBySmart
              ? existing.info.always.map((pattern) => ({
                  permission: existing.info.permission,
                  pattern,
                  action: "allow" as const,
                }))
              : []
          const released: StoredRequest[] = []
          for (const request of store.requests) {
            if (
              request.reply !== undefined ||
              (managedBySmart
                ? request.info.id !== existing.info.id
                : request.info.sessionID !== existing.info.sessionID)
            )
              continue
            const reply =
              request.info.id === existing.info.id
                ? input.reply
                : input.reply === "reject"
                  ? "reject"
                  : input.reply === "always" &&
                      request.info.patterns.every(
                        (pattern) =>
                          evaluate(request.info.permission, pattern, store.approved, approvals).action === "allow",
                      )
                    ? "always"
                    : undefined
            if (!reply) continue
            request.reply = reply
            request.message = request.info.id === existing.info.id ? input.message : undefined
            request.timeUpdated = Date.now()
            released.push(request)
          }
          if (managedBySmart && input.smart?.grant === "task" && details.authority) {
            const smart = store.smart ?? (store.smart = emptySmartStore())
            smart.grants = [
              ...smart.grants.filter(
                (grant) =>
                  !(
                    grant.sessionID === existing.info.sessionID &&
                    grant.actionFingerprint === details.actionFingerprint &&
                    grant.objectiveEpoch === details.authority!.objectiveEpoch &&
                    grant.contextRevision === details.authority!.contextRevision &&
                    grant.revokedAt === undefined
                  ),
              ),
              createSmartGrant({
                permission: existing.info.permission,
                actionFingerprint: details.actionFingerprint,
                sessionID: existing.info.sessionID,
                authority: details.authority,
              }),
            ].slice(-100)
          }
          if (managedBySmart) {
            appendSmartReview(
              store.smart ?? (store.smart = emptySmartStore()),
              smartReviewRecord({
                request: existing.info,
                status: input.reply === "reject" ? "denied" : "allowed",
                source: "manual",
                reason:
                  input.reply === "reject"
                    ? input.message || "The user rejected this Smart Approval request."
                    : input.smart?.grant === "task"
                      ? "The user approved this exact action for the current task."
                      : "The user approved this exact action once.",
                fingerprint: details.actionFingerprint,
              }),
            )
          }
          return released
        }),
      )
      for (const request of released) {
        yield* bus.publish(Event.Replied, {
          sessionID: request.info.sessionID,
          requestID: request.info.id,
          reply: request.reply!,
        })
        const local = pending.get(request.info.id)
        if (local) yield* Deferred.succeed(local.deferred, undefined)
      }
      return released.length > 0
    })

    const replyForSessions = Effect.fn("Permission.replyForSessions")(function* (input: {
      sessionIDs: readonly SessionID[]
      reply: Reply
      filter?: (request: Request) => boolean
    }) {
      const context = yield* InstanceState.context
      const sessionIDs = new Set(input.sessionIDs)
      const result = yield* Effect.sync(() =>
        updateStore(context.project.id, (store) => {
          const abandoned = cleanDeadRequests(store)
          return {
            requests: store.requests
              .filter(
                (request) =>
                  request.reply === undefined &&
                  sessionIDs.has(request.info.sessionID) &&
                  (!input.filter || input.filter(request.info)),
              )
              .map((request) => Schema.decodeUnknownSync(Request)(request.info)),
            abandoned,
          }
        }),
      )
      for (const request of result.abandoned) markPermissionAbandoned(request.info.sessionID)
      for (const request of result.requests) {
        const details = smartRequestDetails(request)
        yield* reply({
          requestID: request.id,
          reply: input.reply,
          smart: isSmartManagedRequest(request)
            ? {
                actionFingerprint: details.actionFingerprint,
                ...(details.authority?.contextRevision === undefined
                  ? {}
                  : { contextRevision: details.authority.contextRevision }),
              }
            : undefined,
        })
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const context = yield* InstanceState.context
      const result = yield* Effect.sync(() =>
        updateStore(context.project.id, (store) => ({
          requests: store.requests
            .filter((request) => request.reply === undefined && request.directory === context.directory)
            .map((request) => Schema.decodeUnknownSync(Request)(request.info)),
          abandoned: cleanDeadRequests(store),
        })),
      )
      for (const request of result.abandoned) markPermissionAbandoned(request.info.sessionID)
      return result.requests.filter((request) => !result.abandoned.some((item) => item.info.id === request.id))
    })

    const listReviews = Effect.fn("Permission.listReviews")(function* (input: {
      sessionID?: string
      cursor?: string
      limit?: number
    }) {
      const context = yield* InstanceState.context
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0
      if (!Number.isSafeInteger(offset) || offset < 0) return { items: [], nextCursor: undefined }
      return yield* Effect.sync(() => {
        const store = updateStore(context.project.id, (current) => ({
          smart: normalizeSmartStore(current.smart),
        })).smart
        const reviews = store.reviews
          .filter((review) => !input.sessionID || review.sessionID === input.sessionID)
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
        const items = reviews.slice(offset, offset + limit)
        return {
          items,
          nextCursor: offset + items.length < reviews.length ? String(offset + items.length) : undefined,
        }
      })
    })

    const revokeGrant = Effect.fn("Permission.revokeGrant")(function* (grantID: string) {
      const context = yield* InstanceState.context
      return yield* Effect.sync(() =>
        updateStore(context.project.id, (store) => {
          const smart = store.smart ?? (store.smart = emptySmartStore())
          return revokeSmartGrant(smart, grantID)
        }),
      )
    })

    return Service.of({ ask, reply, replyForSessions, list, listReviews, revokeGrant })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: Ruleset = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

const EDIT_TOOLS = ["edit", "write", "apply_patch"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Permission from "."
