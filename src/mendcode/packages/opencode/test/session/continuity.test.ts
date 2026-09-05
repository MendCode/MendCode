import { expect } from "bun:test"
import { Effect, Layer, Scope, Schema } from "effect"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Question } from "@/question"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { ToolJobs } from "@/session/tool-jobs"
import * as Mailbox from "@/session/runtime-mailbox"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"
import { notifyDisabled, waitForDisable } from "@/session/continuity-control"
import { provideInstance, reloadTestInstance, tmpdirScoped } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Question.defaultLayer, Bus.layer, CrossSpawnSpawner.defaultLayer))
it.live("pending async questions survive instance reload and use the existing reply path", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const sessions = yield* Session.Service
    const questions = yield* Question.Service
    const session = yield* sessions.create({ title: "Reload question" }).pipe(provideInstance(directory))
    const request = yield* questions.post({ sessionID: session.id, questions: [] }).pipe(provideInstance(directory))
    yield* Effect.promise(() => reloadTestInstance({ directory }))
    const pending = yield* questions.list().pipe(provideInstance(directory))
    expect(pending.some((item) => item.id === request.id && item.async)).toBe(true)
    yield* questions.reply({ requestID: request.id, answers: [] }).pipe(provideInstance(directory))
    expect((yield* questions.get(request.id).pipe(provideInstance(directory)))?.status).toBe("answered")
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(1)
  }),
)
it.instance("immediate jobs release slots without double execution", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "Immediate" })
    const scope = yield* Scope.Scope
    const bus = yield* Bus.Service
    const context = yield* InstanceState.context
    const jobs = new ToolJobs(scope, context.directory, bus, {
      get: () => Effect.succeed({ experimental: { async_tools: true } }),
    })
    yield* Effect.addFinalizer(() => jobs.stop())
    let executions = 0
    const tool: Tool.Def = {
      id: "read",
      description: "Test",
      parameters: Schema.Unknown,
      execute: () => Effect.sync(() => ({ title: "done", output: String(++executions), metadata: {} })),
    }
    for (let i = 0; i < 20; i++) {
      yield* jobs.start(
        tool,
        {},
        {
          sessionID: session.id,
          messageID: MessageID.ascending(),
          callID: String(i),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          ask: () => Effect.void,
          metadata: () => Effect.void,
        },
      )
      yield* Effect.yieldNow
    }
    yield* Effect.sleep(20)
    expect(executions).toBe(20)
    expect(Mailbox.listRecords(session.id, "job", { statuses: ["running", "queued"] })).toHaveLength(0)
  }),
)

it.instance("disable cancels active jobs and suppresses their continuations", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "Disable" })
    const scope = yield* Scope.Scope
    const bus = yield* Bus.Service
    const context = yield* InstanceState.context
    const jobs = new ToolJobs(scope, context.directory, bus, {
      get: () => Effect.succeed({ experimental: { async_tools: true } }),
    })
    yield* Effect.addFinalizer(() => jobs.stop())
    yield* waitForDisable(context.directory, "tools").pipe(
      Effect.andThen(jobs.stop()),
      Effect.forkScoped({ startImmediately: true }),
    )
    const tool: Tool.Def = { id: "read", description: "Test", parameters: Schema.Unknown, execute: () => Effect.never }
    const ctx: Tool.Context = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      callID: "active",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      ask: () => Effect.void,
      metadata: () => Effect.void,
    }
    const job = yield* jobs.start(tool, {}, ctx)
    notifyDisabled({ directory: context.directory, experimental: { async_tools: false } })
    yield* Effect.sleep(20)
    expect(Mailbox.getRecord(session.id, job.id)?.status).toBe("cancelled")
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(0)
    expect((yield* Effect.exit(jobs.start(tool, {}, { ...ctx, callID: "new" })))._tag).toBe("Failure")
  }),
)

it.instance("bounded mailbox acknowledges only complete included events", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "Batch" })
    const context = yield* InstanceState.context
    for (let i = 0; i < 10; i++)
      Mailbox.completeRecord({
        id: `large_${session.id}_${i}`,
        sessionID: session.id,
        directory: context.directory,
        kind: "job",
        generation: 0,
        status: "completed",
        data: { result: "x".repeat(10000) },
        timeCreated: Date.now() + i,
        timeUpdated: Date.now(),
      })
    const batch = Mailbox.boundedEventBatch(Mailbox.pendingEvents(session.id))
    expect(batch.length).toBeGreaterThan(0)
    expect(batch.length).toBeLessThan(10)
    expect(JSON.stringify(Mailbox.eventContext(batch)).length).toBeLessThanOrEqual(24000)
    Mailbox.acknowledgeEvents(batch)
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(10 - batch.length)
  }),
)
it.instance("async questions persist replies once without blocking posting", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const questions = yield* Question.Service
    const session = yield* sessions.create({ title: "Questions" })
    const request = yield* questions.post({
      sessionID: session.id,
      questions: [
        { question: "Which output?", header: "Output", options: [{ label: "Text", description: "Plain text" }] },
      ],
    })
    expect(request.async).toBe(true)
    expect((yield* questions.list()).some((row) => row.id === request.id)).toBe(true)
    yield* questions.reply({ requestID: request.id, answers: [["Text"]] })
    yield* questions.reply({ requestID: request.id, answers: [["changed"]] })
    expect(yield* questions.wait(request.id)).toEqual([["Text"]])
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(1)
    Mailbox.acknowledgeEvents(Mailbox.pendingEvents(session.id))
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(0)
  }),
)

it.instance("cancelled generation retains late answers without wake", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const questions = yield* Question.Service
    const context = yield* InstanceState.context
    const session = yield* sessions.create({ title: "Cancel" })
    const request = yield* questions.post({ sessionID: session.id, questions: [] })
    Mailbox.cancelGeneration(session.id, context.directory)
    yield* questions.reply({ requestID: request.id, answers: [] })
    expect((yield* questions.get(request.id))?.status).toBe("answered")
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(0)
  }),
)

it.instance("jobs enforce active and queued bounds, idempotency, and cancellation", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "Jobs" })
    const scope = yield* Scope.Scope
    const bus = yield* Bus.Service
    const context = yield* InstanceState.context
    const jobs = new ToolJobs(scope, context.directory, bus, {
      get: () => Effect.succeed({ experimental: { async_tools: true } }),
    })
    yield* Effect.addFinalizer(() => jobs.stop())
    const tool: Tool.Def = { id: "read", description: "Test", parameters: Schema.Unknown, execute: () => Effect.never }
    const controller = new AbortController()
    const makeContext = (callID: string): Tool.Context => ({
      sessionID: session.id,
      messageID: MessageID.ascending(),
      callID,
      agent: "build",
      abort: controller.signal,
      messages: [],
      ask: () => Effect.void,
      metadata: () => Effect.void,
    })
    const firstContext = makeContext("first")
    const first = yield* jobs.start(tool, {}, firstContext)
    expect((yield* jobs.start(tool, {}, firstContext)).id).toBe(first.id)
    for (let i = 0; i < 11; i++) yield* jobs.start(tool, {}, makeContext(`call_${i}`))
    const records = Mailbox.listRecords(session.id, "job")
    expect(records.filter((row) => row.status === "running")).toHaveLength(4)
    expect(records.filter((row) => row.status === "queued")).toHaveLength(8)
    const over = yield* Effect.exit(jobs.start(tool, {}, makeContext("overflow")))
    expect(over._tag).toBe("Failure")
    yield* jobs.cancel(session.id, first.id)
    expect(Mailbox.getRecord(session.id, first.id)?.status).toBe("cancelled")
  }),
)

it.instance("jobs finish out of order and retain correlated results", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "Order" })
    const scope = yield* Scope.Scope
    const bus = yield* Bus.Service
    const context = yield* InstanceState.context
    const jobs = new ToolJobs(scope, context.directory, bus, {
      get: () => Effect.succeed({ experimental: { async_tools: true } }),
    })
    yield* Effect.addFinalizer(() => jobs.stop())
    const tool: Tool.Def = {
      id: "read",
      description: "Test",
      parameters: Schema.Unknown,
      execute: (args) =>
        Effect.gen(function* () {
          const delay = Number(args)
          yield* Effect.sleep(delay)
          return { title: "result", output: String(delay), metadata: {} }
        }),
    }
    const ctx: Tool.Context = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      callID: "slow",
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      ask: () => Effect.void,
      metadata: () => Effect.void,
    }
    const slow = yield* jobs.start(tool, 60, ctx)
    const fast = yield* jobs.start(tool, 1, { ...ctx, callID: "fast" })
    yield* Effect.sleep(120)
    expect(Mailbox.getRecord(session.id, slow.id)?.data.result).toBe("60")
    expect(Mailbox.getRecord(session.id, fast.id)?.data.result).toBe("1")
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(2)
  }),
)

it.instance("restart marks lost jobs interrupted without executing them", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "Restart" })
    const scope = yield* Scope.Scope
    const bus = yield* Bus.Service
    const context = yield* InstanceState.context
    Mailbox.putRecord({
      id: "lost",
      sessionID: session.id,
      directory: context.directory,
      kind: "job",
      generation: 0,
      status: "running",
      data: { tool: "read" },
      timeCreated: Date.now(),
      timeUpdated: Date.now(),
    })
    new ToolJobs(scope, context.directory, bus, { get: () => Effect.succeed({}) })
    expect(Mailbox.getRecord(session.id, "lost")?.status).toBe("interrupted")
    expect(Mailbox.pendingEvents(session.id)).toHaveLength(1)
  }),
)
