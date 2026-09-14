import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { createHash, randomUUID } from "node:crypto"
import type { Tool } from "@/tool/tool"
import type { Bus } from "@/bus"
import type { Config } from "@/config/config"
import type { SessionID } from "./schema"
import * as Mailbox from "./runtime-mailbox"

export const ELIGIBLE_TOOLS = ["read", "grep", "glob", "webfetch"] as const
export class ToolJobs {
  private stopping = false
  private queued: Array<{
    record: Mailbox.Record
    run: Effect.Effect<Tool.ExecuteResult>
    controller: AbortController
    cleanup: () => void
  }> = []
  private active = new Map<
    string,
    { controller: AbortController; fiber?: Fiber.Fiber<unknown, unknown>; sessionID: SessionID }
  >()
  constructor(
    private scope: Scope.Scope,
    private directory: string,
    private bus: Bus.Interface,
    private config: Pick<Config.Interface, "get">,
  ) {
    while (true) {
      const records = Mailbox.directoryRecords(directory, "job", { statuses: ["running", "queued"] })
      if (!records.length) break
      for (const record of records) Mailbox.completeRecord({
          ...record,
          status: "interrupted",
          data: { ...record.data, error: "Backend restarted; this job was not repeated." },
      })
    }
  }
  private publish(record: Mailbox.Record) {
    return this.bus.publish(Mailbox.Event.Updated, {
      sessionID: record.sessionID,
      id: record.id,
      kind: record.kind,
      status: record.status,
    })
  }
  start(tool: Tool.Def, args: unknown, context: Tool.Context) {
    const self = this
    return Effect.gen(function* () {
      if ((yield* self.config.get()).experimental?.async_tools !== true) throw new Error("Async tools are disabled")
      if (self.stopping) throw new Error("Async tools were disabled; reload the session after enabling them")
      if (!(ELIGIBLE_TOOLS as readonly string[]).includes(tool.id))
        throw new Error("Tool is not eligible for async execution; shell requires workspace mutation serialization")
      const id = context.callID
        ? `job_${createHash("sha256").update(`${context.sessionID}:${context.messageID}:${context.callID}`).digest("hex")}`
        : `job_${randomUUID()}`
      const existing = Mailbox.getRecord(context.sessionID, id)
      if (existing) return existing
      const records = Mailbox.listRecords(context.sessionID, "job", { statuses: ["running", "queued"] })
      if (records.filter((row) => ["running", "queued"].includes(row.status)).length >= 12)
        throw new Error("Async job capacity reached (4 active, 8 queued)")
      const controller = new AbortController()
      const onAbort = () => controller.abort(context.abort.reason)
      if (context.abort.aborted) controller.abort(context.abort.reason)
      else context.abort.addEventListener("abort", onAbort, { once: true })
      const record = Mailbox.putRecord({
        id,
        sessionID: context.sessionID,
        directory: self.directory,
        kind: "job",
        generation: Mailbox.generation(context.sessionID),
        status: "queued",
        data: { tool: tool.id, messageID: context.messageID, callID: context.callID },
        timeCreated: Date.now(),
        timeUpdated: Date.now(),
      })
      const run = tool.execute(args, { ...context, abort: controller.signal, metadata: () => Effect.void })
      self.queued.push({ record, run, controller, cleanup: () => context.abort.removeEventListener("abort", onAbort) })
      yield* self.publish(record)
      yield* self.pump()
      return Mailbox.getRecord(context.sessionID, id)!
    })
  }
  private pump(): Effect.Effect<void> {
    const self = this
    return Effect.gen(function* () {
      if (self.stopping) return
      for (const item of [...self.queued]) {
        if (!self.queued.includes(item)) continue
        const activeCount = [...self.active.values()].filter((row) => row.sessionID === item.record.sessionID).length
        if (activeCount >= 4) continue
        self.queued.splice(self.queued.indexOf(item), 1)
        const record = Mailbox.putRecord({ ...item.record, status: "running" })
        const active: { controller: AbortController; fiber?: Fiber.Fiber<unknown, unknown>; sessionID: SessionID } = {
          controller: item.controller,
          sessionID: record.sessionID,
        }
        self.active.set(record.id, active)
        const work = Effect.gen(function* () {
          const enabled =
            (yield* self.config.get()).experimental?.async_tools === true &&
            record.generation === Mailbox.generation(record.sessionID) &&
            !item.controller.signal.aborted
          const cancelledEffect = Effect.callback<never>((resume) => {
            const interrupt = () => resume(Effect.interrupt)
            if (item.controller.signal.aborted) interrupt()
            else item.controller.signal.addEventListener("abort", interrupt, { once: true })
            return Effect.sync(() => item.controller.signal.removeEventListener("abort", interrupt))
          })
          const result = enabled ? yield* Effect.exit(Effect.raceFirst(item.run, cancelledEffect)) : undefined
          const current = Mailbox.getRecord(record.sessionID, record.id)!
          const cancelled =
            item.controller.signal.aborted || current.generation !== Mailbox.generation(record.sessionID) || !enabled
          const next = cancelled
            ? {
                ...current,
                status: "cancelled",
                data: { ...current.data, ...(result && Exit.isSuccess(result) ? { result: result.value.output } : {}) },
              }
            : result && Exit.isSuccess(result)
              ? {
                  ...current,
                  status: "completed",
                  data: {
                    ...current.data,
                    result: result.value.output,
                    metadata: result.value.metadata,
                    ...(result.value.attachments?.length
                      ? { attachmentNotice: "Use synchronous read to retrieve media attachments." }
                      : {}),
                  },
                }
              : {
                  ...current,
                  status: "failed",
                  data: {
                    ...current.data,
                    error:
                      result && Exit.isFailure(result)
                        ? String(Cause.squash(result.cause)).slice(0, 4096)
                        : "Async tools disabled",
                  },
                }
          Mailbox.completeRecord(next)
          yield* self.publish(next)
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              self.active.delete(record.id)
              item.cleanup()
              return self.pump()
            }),
          ),
        )
        active.fiber = yield* work.pipe(Effect.forkIn(self.scope))
      }
    })
  }
  cancel(sessionID: SessionID, id: string) {
    const self = this
    return Effect.gen(function* () {
      const record = Mailbox.getRecord(sessionID, id)
      if (!record || record.kind !== "job") throw new Error("Unknown job in this session")
      if (!["queued", "running"].includes(record.status)) return record
      const active = self.active.get(id)
      active?.controller.abort("cancelled")
      self.queued.find((item) => item.record.id === id)?.cleanup()
      self.queued = self.queued.filter((item) => item.record.id !== id)
      const saved = Mailbox.completeRecord({ ...record, status: "cancelled" })
      if (active?.fiber) yield* Fiber.interrupt(active.fiber)
      yield* self.publish(saved)
      return saved
    })
  }
  stop() {
    const self = this
    return Effect.gen(function* () {
      self.stopping = true
      const records = [...self.queued.map((item) => item.record), ...[...self.active].flatMap(([id, active]) => {
        const record = Mailbox.getRecord(active.sessionID, id)
        return record ? [record] : []
      })]
      for (const record of records) {
        Mailbox.putRecord({ ...record, data: { ...record.data, continuationCancelled: true } })
        yield* self.cancel(record.sessionID, record.id)
      }
      Mailbox.cancelContinuations(self.directory, "job")
    })
  }
}
