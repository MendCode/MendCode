import type { Argv } from "yargs"
import { asc, eq } from "drizzle-orm"
import { Effect, Stream } from "effect"
import { spawn } from "node:child_process"
import path from "path"
import { EOL } from "os"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { automationEnvelope, writeAutomationEnvelope } from "../automation"
import { resolveRuntimeModel } from "../model-selection"
import { Bus } from "@/bus"
import { Database } from "@/storage/db"
import { EventTable } from "@/sync/event.sql"
import { Session, type Info as SessionInfo } from "@/session/session"
import { MessageID, SessionID } from "../../session/schema"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { BackgroundTask } from "@/session/background-task"
import { LoopWorkflow } from "@/session/loop"
import { MessageV2 } from "@/session/message-v2"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { PlanReview } from "@/plan-review"
import { ModelID, ProviderID } from "@/provider/schema"
import { NotFoundError } from "@/storage/storage"
import { Locale } from "@/util/locale"

const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_WAIT_INTERVAL_MS = 250

type OutputArgs = {
  format?: string
  json?: boolean
}

type SessionCommandArgs = OutputArgs & {
  dir?: string
}

function sessionDirectory(args: SessionCommandArgs) {
  return args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd()
}

function withSessionOptions(yargs: Argv) {
  return yargs
    .option("dir", {
      describe: "project directory to operate on",
      type: "string",
    })
    .option("format", {
      describe: "output format",
      type: "string",
      choices: ["table", "json"],
      default: "table",
    })
    .option("json", {
      describe: "emit versioned JSON output",
      type: "boolean",
      default: false,
    })
}

function wantsJSON(args: OutputArgs) {
  return args.json === true || args.format === "json"
}

function writeResult<T>(args: OutputArgs, event: string, data: T, human: string, sessionID?: string) {
  if (wantsJSON(args)) {
    writeAutomationEnvelope({ kind: "result", event, sessionID, data })
    return
  }
  if (human) console.log(human)
}

function sessionID(value: string) {
  try {
    return SessionID.make(value)
  } catch {
    throw new Error(`Invalid session ID: ${value}`)
  }
}

function parseModel(value?: string, variant?: string) {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) throw new Error(`Invalid model: ${value}; expected provider/model`)
  return {
    providerID: ProviderID.make(providerID),
    id: ModelID.make(modelID),
    ...(variant ? { variant } : {}),
  }
}

function modelText(model?: SessionInfo["model"]) {
  if (!model) return undefined
  return `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ""}`
}

function sessionHuman(info: SessionInfo, status?: SessionStatus.Info, state?: string) {
  return [
    `${info.id}  ${info.title}`,
    `State: ${state ?? status?.type ?? "unknown"}`,
    `Agent: ${info.agent ?? "default"}`,
    `Model: ${modelText(info.model) ?? "runtime default"}`,
    `Directory: ${info.directory}`,
    `Updated: ${new Date(info.time.updated).toISOString()}`,
  ].join("\n")
}

function sessionRow(info: SessionInfo, status?: SessionStatus.Info, state?: string) {
  return {
    id: info.id,
    title: info.title,
    projectID: info.projectID,
    directory: info.directory,
    parentID: info.parentID ?? null,
    agent: info.agent ?? null,
    model: info.model
      ? {
          providerID: info.model.providerID,
          modelID: info.model.id,
          variant: info.model.variant ?? null,
        }
      : null,
    status: status ?? { type: "idle" },
    state: state ?? status?.type ?? "idle",
    archived: info.time.archived ?? null,
    created: info.time.created,
    updated: info.time.updated,
  }
}

function lastAssistant(messages: MessageV2.WithParts[]) {
  return messages.findLast((message) => message.info.role === "assistant")
}

function pendingForSession<T extends { sessionID: string }>(items: ReadonlyArray<T>, id: string) {
  return items.filter((item) => item.sessionID === id)
}

export function deriveSessionState(input: {
  sessionID: string
  status: SessionStatus.Info
  messages: MessageV2.WithParts[]
  questions: ReadonlyArray<{ sessionID: string }>
  permissions: ReadonlyArray<{ sessionID: string }>
  planReviews: ReadonlyArray<{ sessionID: string }>
}) {
  if (input.questions.some((item) => item.sessionID === input.sessionID)) return "waiting_for_input"
  if (input.permissions.some((item) => item.sessionID === input.sessionID)) return "waiting_for_approval"
  if (input.planReviews.some((item) => item.sessionID === input.sessionID)) return "waiting_for_approval"
  if (input.status.type === "busy") {
    if (input.status.kind === "mflow-wait") return "waiting_for_lock"
    if (input.status.kind === "subagent-wait") return "waiting_for_subagent"
    return "running"
  }
  if (input.status.type === "retry") return "retrying"

  if (input.messages.at(-1)?.info.role === "user") return "running"

  const assistant = lastAssistant(input.messages)
  if (assistant?.info.role === "assistant" && assistant.info.error) {
    return assistant.info.error.name === "MessageAbortedError" ? "cancelled" : "failed"
  }
  if (assistant?.info.role === "assistant" && assistant.info.time.completed) return "completed"
  return "idle"
}

function terminalState(state: string) {
  return state === "completed" || state === "failed" || state === "cancelled"
}

type SessionSnapshot = {
  session: SessionInfo
  status: SessionStatus.Info
  state: string
  messages: MessageV2.WithParts[]
  children: SessionInfo[]
  subagents: BackgroundTask.Snapshot[]
  loops: LoopWorkflow.Info[]
  pending: {
    questions: unknown[]
    permissions: unknown[]
    planReviews: unknown[]
  }
  events: Array<{
    id: string
    sequence: number
    type: string
    data: Record<string, unknown>
  }>
  diff: unknown[]
}

function inspectSession(sessionIDValue: SessionID, limit = 50) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const tasks = yield* BackgroundTask.Service
    const loops = yield* LoopWorkflow.Service
    const questions = yield* Question.Service
    const permissions = yield* Permission.Service
    const planReviews = yield* PlanReview.Service
    const info = yield* sessions.get(sessionIDValue)
    const messages = yield* sessions.messages({ sessionID: sessionIDValue, ...(limit > 0 ? { limit } : {}) })
    const pendingQuestions = pendingForSession(yield* questions.list(), sessionIDValue)
    const pendingPermissions = pendingForSession(yield* permissions.list(), sessionIDValue)
    const pendingPlanReviews = pendingForSession(yield* planReviews.list(), sessionIDValue)
    const status = yield* statuses.get(sessionIDValue)
    const state = deriveSessionState({
      sessionID: sessionIDValue,
      status,
      messages,
      questions: pendingQuestions,
      permissions: pendingPermissions,
      planReviews: pendingPlanReviews,
    })
    const events = yield* Effect.sync(() =>
      Database.use((db) =>
        db
          .select({ id: EventTable.id, sequence: EventTable.seq, type: EventTable.type, data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionIDValue))
          .orderBy(asc(EventTable.seq))
          .all(),
      ),
    )
    return {
      session: info,
      status,
      state,
      messages,
      children: yield* sessions.children(sessionIDValue),
      subagents: yield* tasks.list(sessionIDValue),
      loops: (yield* loops.list()).filter(
        (item) => item.rootSessionID === sessionIDValue || item.ownerSessionID === sessionIDValue,
      ),
      pending: {
        questions: pendingQuestions,
        permissions: pendingPermissions,
        planReviews: pendingPlanReviews,
      },
      events,
      diff: yield* sessions.diff(sessionIDValue),
    } satisfies SessionSnapshot
  })
}

function waitForSession(sessionIDValue: SessionID, timeoutMs: number, intervalMs: number) {
  return Effect.gen(function* () {
    const started = Date.now()
    let snapshot = yield* inspectSession(sessionIDValue, 50)
    while (!terminalState(snapshot.state)) {
      const remaining = timeoutMs - (Date.now() - started)
      if (remaining <= 0) return { snapshot, timedOut: true }
      yield* Effect.sleep(`${Math.min(intervalMs, remaining)} millis`)
      snapshot = yield* inspectSession(sessionIDValue, 50)
    }
    return { snapshot, timedOut: false }
  })
}

function timeoutValue(value?: number) {
  const result = value ?? DEFAULT_WAIT_TIMEOUT_MS
  if (!Number.isFinite(result) || result <= 0) throw new Error("--timeout-ms must be a positive number")
  return Math.floor(result)
}

function intervalValue(value?: number) {
  const result = value ?? DEFAULT_WAIT_INTERVAL_MS
  if (!Number.isFinite(result) || result <= 0) throw new Error("--interval-ms must be a positive number")
  return Math.floor(result)
}

function extractEventSessionID(properties: unknown) {
  if (!properties || typeof properties !== "object") return undefined
  const record = properties as Record<string, unknown>
  if (typeof record.sessionID === "string") return record.sessionID
  for (const key of ["info", "part", "snapshot", "request"]) {
    const value = record[key]
    if (value && typeof value === "object" && typeof (value as Record<string, unknown>).sessionID === "string") {
      return (value as Record<string, unknown>).sessionID as string
    }
  }
  return undefined
}

class SessionEventDone extends Error {}

function launchAsyncPrompt(input: {
  sessionID: string
  directory: string
  message: string
  model?: string
  agent?: string
  variant?: string
}) {
  const entry = process.argv[1]
  const script = entry && /\.(?:ts|tsx|js|mjs)$/.test(entry) ? entry : undefined
  const command = script ? process.execPath : entry || process.execPath
  const commandArgs = [
    ...(script ? [script] : []),
    "run",
    "--dir",
    input.directory,
    "--session",
    input.sessionID,
    "--format",
    "json",
    ...(input.model ? ["--model", input.model] : []),
    ...(input.agent ? ["--agent", input.agent] : []),
    ...(input.variant ? ["--variant", input.variant] : []),
    input.message,
  ]
  const child = spawn(command, commandArgs, {
    cwd: input.directory,
    detached: true,
    env: { ...process.env },
    stdio: "ignore",
  })
  child.unref()
  return child.pid
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage and automate sessions",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .command(SessionCreateCommand)
      .command(SessionListCommand)
      .command(SessionGetCommand)
      .command(SessionInspectCommand)
      .command(SessionRenameCommand)
      .command(SessionForkCommand)
      .command(SessionArchiveCommand)
      .command(SessionDeleteCommand)
      .command(SessionSendCommand)
      .command(SessionStatusCommand)
      .command(SessionWaitCommand)
      .command(SessionCancelCommand)
      .command(SessionEventsCommand)
      .command(SessionExportCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionCreateCommand = effectCmd({
  command: "create",
  describe: "create a session",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .option("title", { type: "string", describe: "session title" })
      .option("parent", { type: "string", describe: "parent session ID" })
      .option("agent", { type: "string", describe: "agent to use" })
      .option("model", { type: "string", describe: "model as provider/model" })
      .option("variant", { type: "string", describe: "model variant" }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.create")(function* (args) {
    const sessions = yield* Session.Service
    const info = yield* sessions.create({
      title: args.title,
      parentID: args.parent ? sessionID(args.parent) : undefined,
      agent: args.agent,
      model: parseModel(args.model, args.variant),
    })
    writeResult(args, "session.created", sessionRow(info), `Created session ${info.id}: ${info.title}`, info.id)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .option("max-count", { alias: "n", describe: "limit to N sessions", type: "number" })
      .option("all", { describe: "include child sessions", type: "boolean", default: false })
      .option("all-projects", { describe: "include sessions from all projects", type: "boolean", default: false })
      .option("project", { describe: "filter by project ID", type: "string" })
      .option("state", { describe: "filter by derived state", type: "string" })
      .option("active", { describe: "only active sessions", type: "boolean" })
      .option("archived", { describe: "include archived sessions", type: "boolean", default: false })
      .option("agent", { describe: "filter by agent", type: "string" })
      .option("model", { describe: "filter by provider/model", type: "string" })
      .option("since", { describe: "updated since Unix milliseconds", type: "number" })
      .option("search", { describe: "search titles", type: "string" }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const list = args["all-projects"] || args.project
      ? Array.from(
          Session.listGlobal({
            directory: args["all-projects"] ? undefined : sessionDirectory(args),
            roots: !args.all,
            start: args.since,
            search: args.search,
            limit: args["max-count"],
            archived: args.archived,
          }),
        )
      : yield* sessions.list({ roots: !args.all, start: args.since, search: args.search, limit: args["max-count"] })
    const statusMap = yield* statuses.list()
    const rows = list
      .filter((info) => !args.project || info.projectID === args.project)
      .filter((info) => args.agent === undefined || info.agent === args.agent)
      .filter((info) => args.model === undefined || modelText(info.model)?.startsWith(args.model))
      .filter((info) => args.archived || !info.time.archived)
      .map((info) => {
        const status = statusMap.get(info.id) ?? { type: "idle" as const }
        const state = status.type
        return { info, status, state }
      })
      .filter((item) => args.active === undefined || (args.active ? item.state !== "idle" : item.state === "idle"))
      .filter((item) => args.state === undefined || item.state === args.state)
    const data = rows.map((item) => sessionRow(item.info, item.status, item.state))
    const human = data.length
      ? data
          .map((item) => `${item.id}  ${item.state.padEnd(10)}  ${Locale.truncate(item.title, 35)}`)
          .join(EOL)
      : "No sessions"
    writeResult(args, "session.list", data, human)
  }),
})

export const SessionGetCommand = effectCmd({
  command: "get <sessionID>",
  describe: "get session metadata",
  builder: (yargs: Argv) => withSessionOptions(yargs).positional("sessionID", { type: "string", demandOption: true }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.get")(function* (args) {
    const sessions = yield* Session.Service
    const info = yield* sessions.get(sessionID(args.sessionID)).pipe(
      Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)),
    )
    writeResult(args, "session.get", sessionRow(info), sessionHuman(info), info.id)
  }),
})

export const SessionInspectCommand = effectCmd({
  command: "inspect <sessionID>",
  describe: "inspect session progress, subagents, loops, approvals, and result",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .positional("sessionID", { type: "string", demandOption: true })
      .option("limit", { type: "number", default: 50, describe: "maximum messages to include" }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.inspect")(function* (args) {
    const snapshot = yield* inspectSession(sessionID(args.sessionID), args.limit)
    writeResult(
      args,
      "session.inspect",
      snapshot,
      sessionHuman(snapshot.session, snapshot.status, snapshot.state),
      snapshot.session.id,
    )
  }),
})

export const SessionRenameCommand = effectCmd({
  command: "rename <sessionID> <title..>",
  describe: "rename a session",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .positional("sessionID", { type: "string", demandOption: true })
      .positional("title", { type: "string", array: true, demandOption: true }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.rename")(function* (args) {
    const id = sessionID(args.sessionID)
    const title = args.title.join(" ").trim()
    if (!title) return yield* fail("A non-empty title is required")
    const sessions = yield* Session.Service
    yield* sessions.setTitle({ sessionID: id, title })
    const info = yield* sessions.get(id)
    writeResult(args, "session.renamed", sessionRow(info), `Renamed ${id} to ${title}`, id)
  }),
})

export const SessionForkCommand = effectCmd({
  command: "fork <sessionID>",
  describe: "fork a session",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .positional("sessionID", { type: "string", demandOption: true })
      .option("message-id", { type: "string", describe: "fork before this message" }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.fork")(function* (args) {
    const sessions = yield* Session.Service
    const info = yield* sessions.fork({
      sessionID: sessionID(args.sessionID),
      messageID: args["message-id"] ? MessageID.make(args["message-id"]) : undefined,
    })
    writeResult(args, "session.forked", sessionRow(info), `Forked session ${info.id} from ${args.sessionID}`, info.id)
  }),
})

export const SessionArchiveCommand = effectCmd({
  command: "archive <sessionID>",
  describe: "archive or restore a session",
  builder: (yargs: Argv) => withSessionOptions(yargs).positional("sessionID", { type: "string", demandOption: true }).option("restore", { type: "boolean", default: false }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.archive")(function* (args) {
    const id = sessionID(args.sessionID)
    const sessions = yield* Session.Service
    yield* sessions.setArchived({ sessionID: id, time: args.restore ? undefined : Date.now() })
    const info = yield* sessions.get(id)
    writeResult(args, args.restore ? "session.restored" : "session.archived", sessionRow(info), args.restore ? `Restored ${id}` : `Archived ${id}`, id)
  }),
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs: Argv) => withSessionOptions(yargs).positional("sessionID", { type: "string", demandOption: true }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const id = sessionID(args.sessionID)
    const sessions = yield* Session.Service
    yield* sessions.remove(id).pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    writeResult(args, "session.deleted", { id }, `Session ${args.sessionID} deleted`, args.sessionID)
  }),
})

export const SessionSendCommand = effectCmd({
  command: "send <sessionID> [message..]",
  describe: "send work to an existing session",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .positional("sessionID", { type: "string", demandOption: true })
      .positional("message", { type: "string", array: true, default: [] })
      .option("model", { type: "string", describe: "explicit provider/model override" })
      .option("agent", { type: "string", describe: "explicit agent override" })
      .option("variant", { type: "string", describe: "explicit model variant" })
      .option("async", { type: "boolean", default: false, describe: "start a detached runtime and return immediately" })
      .option("wait", { type: "boolean", default: false, describe: "wait for a terminal result" })
      .option("timeout-ms", { type: "number", describe: "wait timeout" })
      .option("interval-ms", { type: "number", describe: "poll interval" }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.send")(function* (args) {
    const message = args.message.join(" ").trim()
    if (!message) return yield* fail("You must provide a message")
    const id = sessionID(args.sessionID)
    const sessions = yield* Session.Service
    const info = yield* sessions.get(id).pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    const resolved = yield* resolveRuntimeModel({
      session: info,
      explicitAgent: args.agent,
      explicitModel: args.model,
      explicitVariant: args.variant,
    })
    const selectedModel = resolved.model ? `${resolved.model.providerID}/${resolved.model.modelID}` : undefined

    if (args.async && !args.wait) {
      const pid = launchAsyncPrompt({
        sessionID: info.id,
        directory: sessionDirectory(args),
        message,
        model: selectedModel,
        agent: resolved.agent,
        variant: resolved.variant,
      })
      writeResult(args, "session.accepted", { sessionID: info.id, pid, resolution: resolved }, `Accepted work for ${info.id} (pid ${pid ?? "unknown"})`, info.id)
      return
    }

    const prompt = yield* SessionPrompt.Service
    const result = yield* prompt.prompt({
      sessionID: id,
      agent: resolved.agent,
      model: resolved.model
        ? { providerID: ProviderID.make(resolved.model.providerID), modelID: ModelID.make(resolved.model.modelID) }
        : undefined,
      variant: resolved.variant,
      parts: [{ type: "text", text: message }],
    })
    const snapshot = yield* inspectSession(id, 20)
    writeResult(
      args,
      "session.completed",
      { resolution: resolved, state: snapshot.state, response: result, session: sessionRow(snapshot.session, snapshot.status, snapshot.state) },
      sessionHuman(snapshot.session, snapshot.status, snapshot.state),
      info.id,
    )
  }),
})

export const SessionStatusCommand = effectCmd({
  command: "status <sessionID>",
  describe: "read current session status without blocking",
  builder: (yargs: Argv) => withSessionOptions(yargs).positional("sessionID", { type: "string", demandOption: true }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.status")(function* (args) {
    const snapshot = yield* inspectSession(sessionID(args.sessionID), 20)
    writeResult(args, "session.status", snapshot, sessionHuman(snapshot.session, snapshot.status, snapshot.state), snapshot.session.id)
  }),
})

export const SessionWaitCommand = effectCmd({
  command: "wait <sessionID>",
  describe: "wait until a session completes, fails, or is cancelled",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .positional("sessionID", { type: "string", demandOption: true })
      .option("timeout-ms", { type: "number", describe: "maximum wait time" })
      .option("interval-ms", { type: "number", describe: "poll interval" }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.wait")(function* (args) {
    const id = sessionID(args.sessionID)
    const result = yield* waitForSession(id, timeoutValue(args["timeout-ms"]), intervalValue(args["interval-ms"]))
    writeResult(
      args,
      result.timedOut ? "session.timeout" : "session.terminal",
      { timedOut: result.timedOut, ...result.snapshot },
      sessionHuman(result.snapshot.session, result.snapshot.status, result.snapshot.state),
      id,
    )
    if (result.timedOut) return yield* fail(`Timed out waiting for session ${id}`)
  }),
})

export const SessionCancelCommand = effectCmd({
  command: "cancel <sessionID>",
  describe: "cancel active work in a session",
  builder: (yargs: Argv) => withSessionOptions(yargs).positional("sessionID", { type: "string", demandOption: true }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.cancel")(function* (args) {
    const id = sessionID(args.sessionID)
    const prompt = yield* SessionPrompt.Service
    yield* prompt.cancel(id)
    const snapshot = yield* inspectSession(id, 20)
    writeResult(args, "session.cancelled", snapshot, `Cancelled ${id}`, id)
  }),
})

export const SessionEventsCommand = effectCmd({
  command: "events <sessionID>",
  describe: "stream ordered session events",
  builder: (yargs: Argv) =>
    withSessionOptions(yargs)
      .positional("sessionID", { type: "string", demandOption: true })
      .option("follow", { type: "boolean", default: false, describe: "follow live events" })
      .option("keep-open", { type: "boolean", default: false, describe: "do not stop when the session becomes idle" })
      .option("limit", { type: "number", describe: "stop after N matching events" }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.events")(function* (args) {
    const id = sessionID(args.sessionID)
    if (!args.follow) {
      const snapshot = yield* inspectSession(id, 0)
      const events = snapshot.events.map((event) => ({
        ...automationEnvelope({
          kind: "event" as const,
          event: event.type,
          eventID: event.id,
          timestamp: typeof event.data.time === "number" ? event.data.time : 0,
          sessionID: id,
          data: event.data,
        }),
        sequence: event.sequence,
      }))
      if (wantsJSON(args)) {
        for (const event of events) process.stdout.write(JSON.stringify(event) + EOL)
      } else {
        console.log(events.map((event) => `${event.sequence}  ${event.event}`).join(EOL) || "No events")
      }
      return
    }

    const bus = yield* Bus.Service
    let count = 0
    yield* Stream.runForEach(bus.subscribeAll(), (event) =>
      Effect.gen(function* () {
        if (extractEventSessionID(event.properties) !== id) return
        count += 1
        if (wantsJSON(args)) {
          writeAutomationEnvelope({ kind: "event", event: event.type, eventID: event.id, sessionID: id, data: event.properties })
        } else {
          console.log(`${new Date().toISOString()}  ${event.type}`)
        }
        const isIdle = event.type === SessionStatus.Event.Status.type && (event.properties as { status?: { type?: string } }).status?.type === "idle"
        if ((args.limit && count >= args.limit) || (isIdle && !args["keep-open"])) return yield* Effect.fail(new SessionEventDone())
      }),
    ).pipe(Effect.catchIf((error) => error instanceof SessionEventDone, () => Effect.void))
  }),
})

export const SessionExportCommand = effectCmd({
  command: "export <sessionID>",
  describe: "export session metadata, messages, events, subagents, loops, and diff",
  builder: (yargs: Argv) => withSessionOptions(yargs).positional("sessionID", { type: "string", demandOption: true }),
  directory: sessionDirectory,
  handler: Effect.fn("Cli.session.export")(function* (args) {
    const snapshot = yield* inspectSession(sessionID(args.sessionID), 0)
    writeResult(args, "session.export", snapshot, sessionHuman(snapshot.session, snapshot.status, snapshot.state), snapshot.session.id)
  }),
})

export function formatSessionTable(sessions: Session.Info[]) {
  const maxIdWidth = Math.max(20, ...sessions.map((session) => session.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((session) => session.title.length))
  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  return [
    header,
    "─".repeat(header.length),
    ...sessions.map((session) => `${session.id.padEnd(maxIdWidth)}  ${Locale.truncate(session.title, maxTitleWidth).padEnd(maxTitleWidth)}  ${new Date(session.time.updated).toISOString()}`),
  ].join(EOL)
}

export * as SessionCommandModule from "./session"
