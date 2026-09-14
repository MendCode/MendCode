import { Effect, Schema, Scope } from "effect"
import type { Tool } from "./tool"
import { ToolJobs } from "@/session/tool-jobs"
import * as Mailbox from "@/session/runtime-mailbox"
import type { Config } from "@/config/config"
import type { Bus } from "@/bus"
import type { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Parameters as QuestionParameters } from "./question"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { sessionNotes } from "./session-notes"

function result(value: unknown) {
  return { title: "Continuity", output: JSON.stringify(value), metadata: { truncated: false } }
}
export function continuityTools(input: {
  eligible: Tool.Def[]
  scope: Scope.Scope
  directory: string
  bus: Bus.Interface
  config: Config.Interface
  question: Question.Interface
  sessions: Session.Interface
}) {
  const jobs = new ToolJobs(input.scope, input.directory, input.bus, input.config)
  const enabled = (key: "async_tools" | "async_questions" | "session_recall") =>
    Effect.gen(function* () {
      if ((yield* input.config.get()).experimental?.[key] !== true) throw new Error(`${key} is disabled`)
    })
  const startParameters = Schema.Struct({
    tool: Schema.Literals(["read", "grep", "glob", "webfetch"]),
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  })
  const start: Tool.Def<typeof startParameters> = {
    id: "tool_start",
    description:
      "Start a read, grep, glob or webfetch job without waiting. Continue independent work; results arrive at safe checkpoints. Shell, mutations and arbitrary MCP are unavailable asynchronously. Original tool permissions still apply.",
    parameters: startParameters,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        yield* enabled("async_tools")
        const tool = input.eligible.find((tool) => tool.id === args.tool)
        if (!tool) throw new Error("Tool unavailable")
        const job = yield* jobs.start(tool, args.arguments, ctx)
        return result({ job_id: job.id, status: job.status })
      }),
  }
  const idParameters = Schema.Struct({
    job_id: Schema.String,
    offset: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.Number),
  })
  const status: Tool.Def<typeof idParameters> = {
    id: "tool_status",
    description: "Read a job and its stored result in the current session.",
    parameters: idParameters,
    execute: (args, ctx) =>
      Effect.sync(() => {
        const record = Mailbox.getRecord(ctx.sessionID, args.job_id)
        if (!record || record.kind !== "job") throw new Error("Unknown job in this session")
        const output = typeof record.data.result === "string" ? record.data.result : ""
        const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset!)) : 0
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(16000, Math.floor(args.limit!))) : 8000
        return result({
          job_id: record.id,
          status: record.status,
          tool: record.data.tool,
          error: record.data.error,
          output: output.slice(offset, offset + limit),
          next_offset: offset + limit < output.length ? offset + limit : undefined,
          attachment_notice: record.data.attachmentNotice,
        })
      }),
  }
  const cancel: Tool.Def<typeof idParameters> = {
    id: "tool_cancel",
    description:
      "Cancel a job from the current session. Retains history and late results without resuming cancelled work.",
    parameters: idParameters,
    execute: (args, ctx) => jobs.cancel(ctx.sessionID, args.job_id).pipe(Effect.map(result)),
  }
  const waitParameters = Schema.Struct({
    job_ids: Schema.Array(Schema.String),
    timeout_ms: Schema.optional(Schema.Number),
  })
  const wait: Tool.Def<typeof waitParameters> = {
    id: "tool_wait",
    description: "Wait up to 60 seconds for selected jobs. Returns immediately when all are terminal.",
    parameters: waitParameters,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        if (!args.job_ids.length || args.job_ids.length > 12) throw new Error("Provide 1 to 12 job IDs")
        const deadline =
          Date.now() + (Number.isFinite(args.timeout_ms) ? Math.max(0, Math.min(60000, args.timeout_ms!)) : 10000)
        while (true) {
          const records = args.job_ids.map((id) => Mailbox.getRecord(ctx.sessionID, id))
          if (records.some((record) => !record || record.kind !== "job")) throw new Error("Unknown job in this session")
          if (
            ctx.abort.aborted ||
            Date.now() >= deadline ||
            records.every((record) => !["running", "queued"].includes(record!.status))
          )
            return result(records.map((record) => ({ job_id: record!.id, status: record!.status })))
          yield* Effect.sleep(100)
        }
      }),
  }
  const question: Tool.Def<typeof QuestionParameters> = {
    id: "question_async",
    description:
      "Post questions and continue independent work. User replies arrive later. Silence never grants approval; tool authorizations use permissions.",
    parameters: QuestionParameters,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        yield* enabled("async_questions")
        const request = yield* input.question.post({
          sessionID: ctx.sessionID,
          questions: args.questions,
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })
        return result({ question_id: request.id, status: "pending" })
      }),
  }
  const questionGetParameters = Schema.Struct({ question_id: Schema.String })
  const questionGet: Tool.Def<typeof questionGetParameters> = {
    id: "question_get",
    description: "Read the current session's posted question, real reply or dismissal.",
    parameters: questionGetParameters,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        const record = yield* input.question.get(QuestionID.make(args.question_id))
        if (!record || record.sessionID !== ctx.sessionID) throw new Error("Unknown question in this session")
        return result(record)
      }),
  }
  const recallParameters = Schema.Struct({
    session_id: Schema.optional(Schema.String),
    before: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    query: Schema.optional(Schema.String),
    message_id: Schema.optional(Schema.String),
    offset: Schema.optional(Schema.Number),
  })
  const recall = (search: boolean): Tool.Def<typeof recallParameters> => ({
    id: search ? "session_search" : "session_read",
    description: search
      ? "Search one bounded page of historical messages including before compaction. Follow next_cursor for older pages. Only current session or linked descendants."
      : "Read one bounded page of session history, including before compaction. Only current session or linked descendants.",
    parameters: recallParameters,
    execute: (args, ctx) =>
      Effect.gen(function* () {
        yield* enabled("session_recall")
        const target = SessionID.make(args.session_id ?? ctx.sessionID)
        let current = yield* input.sessions.get(target).pipe(Effect.orDie)
        const seen = new Set<string>()
        while (current.id !== ctx.sessionID) {
          if (!current.parentID || seen.has(current.id))
            throw new Error("Session is outside the current session and its linked children")
          seen.add(current.id)
          current = yield* input.sessions.get(current.parentID).pipe(Effect.orDie)
        }
        if (args.message_id && !search) {
          const message = MessageV2.get({ sessionID: target, messageID: MessageID.make(args.message_id) })
          const text = message.parts
            .flatMap((part) =>
              part.type === "text"
                ? [part.text]
                : part.type === "tool" && part.state.status === "completed"
                  ? [`${part.tool}: ${part.state.output}`]
                  : [],
            )
            .join("\n")
          const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset!)) : 0
          return result({
            session_id: target,
            message_id: message.info.id,
            text: text.slice(offset, offset + 16000),
            next_offset: offset + 16000 < text.length ? offset + 16000 : undefined,
          })
        }
        const page = MessageV2.page({
          sessionID: target,
          limit: Number.isFinite(args.limit) ? Math.max(1, Math.min(10, Math.floor(args.limit!))) : 10,
          before: args.before,
        })
        const query = args.query?.toLowerCase()
        if (search && !query) throw new Error("Search requires query")
        const messages = page.items.flatMap((message) => {
          const text = message.parts
            .flatMap((part) =>
              part.type === "text"
                ? [part.text]
                : part.type === "tool" && part.state.status === "completed"
                  ? [`${part.tool}: ${part.state.output}`]
                  : [],
            )
            .join("\n")
          const match = query ? text.toLowerCase().indexOf(query) : 0
          if (search && match < 0) return []
          const offset = search ? Math.max(0, match - 200) : 0
          return [
            {
              message_id: message.info.id,
              role: message.info.role,
              text: text.slice(offset, offset + 2000),
              truncated: text.length > offset + 2000,
            },
          ]
        })
        return result({ session_id: target, messages, next_cursor: page.cursor, more: page.more })
      }),
  })
  return {
    jobs,
    jobTools: [start, status, wait, cancel] as Tool.Def[],
    questionTools: [question, questionGet] as Tool.Def[],
    recallTools: [recall(true), recall(false), sessionNotes(input.directory, input.config)] as Tool.Def[],
  }
}
