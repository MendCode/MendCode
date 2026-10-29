import { z } from "zod"
import { ClientId, CommandId, ItemId, QueueId, SessionId } from "./ids"
import { PermissionRule } from "./permissions"
import { lazySchema } from "./lazy"

const base = { id: CommandId, clientId: ClientId }
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000)
export const RestModel = lazySchema(() => z.strictObject({ providerID: z.string().min(1).max(100), modelID: z.string().min(1).max(200), variant: z.string().max(100).optional() }))
/** Rules for this session only, evaluated after settings and agent rules (last match wins); `[]` clears them. */
export const RestSessionPermission = lazySchema(() => z.array(PermissionRule).max(500))
export const RestSessionUpdate = lazySchema(() => z.strictObject({ title: z.string().min(1).max(200).optional(), permission: RestSessionPermission.optional(), time: z.strictObject({ archived: timestamp.nullable().optional() }).optional() }))
export const RestSessionCreate = lazySchema(() => z.strictObject({ title: z.string().max(200).optional(), parentID: SessionId.optional(), agent: z.string().min(1).max(100).optional(), model: RestModel.optional(), permission: RestSessionPermission.optional() }))
const partId = z.string().min(1).max(200).optional()
const partMetadata = { id: partId, metadata: z.record(z.string(), z.unknown()).optional() }
/** A file part is a `data:` URL (images, PDFs, small text): the daemon never reads a local path or URL for a REST client. */
export const RestFilePart = lazySchema(() => z.strictObject({ ...partMetadata, type: z.literal("file"), mime: z.string().min(1).max(100), filename: z.string().min(1).max(255).optional(), url: z.string().min(6).max(262_144), source: z.unknown().optional() }))
export const RestPromptPart = lazySchema(() => z.discriminatedUnion("type", [
  z.strictObject({ ...partMetadata, type: z.literal("text"), text: z.string().max(32_000), synthetic: z.boolean().optional(), ignored: z.boolean().optional(), time: z.unknown().optional() }),
  RestFilePart,
  z.strictObject({ ...partMetadata, type: z.literal("agent"), name: z.string().min(1).max(100), source: z.unknown().optional() }),
  z.strictObject({ ...partMetadata, type: z.literal("subtask"), prompt: z.string().min(1).max(32_000), description: z.string().max(1_000).optional(), agent: z.string().min(1).max(100), model: RestModel.optional(), command: z.string().max(100).optional() }),
]))
export const RestPrompt = lazySchema(() => z.strictObject({
  parts: z.array(RestPromptPart).min(1).max(32),
  messageID: ItemId.optional(), model: RestModel.optional(), agent: z.string().min(1).max(100).optional(), variant: z.string().min(1).max(100).optional(),
  system: z.string().min(1).max(32_000).optional(),
  /** `noReply` records the message without a model call; `tools` maps tool names (wildcards allowed) to false to remove them for this prompt (true never adds one); `format` requires the answer as an object matching a JSON Schema. Native engine only. */
  noReply: z.boolean().optional(), tools: z.record(z.string().min(1).max(100), z.boolean()).optional(),
  format: z.discriminatedUnion("type", [
    z.looseObject({ type: z.literal("text") }),
    z.looseObject({ type: z.literal("json_schema"), schema: z.record(z.string(), z.unknown()), retryCount: z.number().int().min(0).max(10).optional() }),
  ]).optional(),
}))
export const RestV2Prompt = lazySchema(() => z.strictObject({
  prompt: z.strictObject({
    text: z.string().min(1).max(32_000),
    files: z.array(z.strictObject({ uri: z.string().min(6).max(262_144), mime: z.string().min(1).max(100), name: z.string().min(1).max(255).optional(), description: z.string().max(1_000).optional(), source: z.unknown().optional() })).max(16).optional(),
    agents: z.array(z.strictObject({ name: z.string().min(1).max(100), source: z.unknown().optional() })).max(16).optional(),
  }),
  delivery: z.enum(["immediate", "deferred"]).optional(),
}))
export const RestCommand = lazySchema(() => z.strictObject({
  command: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/).max(100), arguments: z.string().max(8_000),
  agent: z.string().min(1).max(100).optional(), model: z.string().min(1).max(300).optional(),
  messageID: ItemId.optional(), variant: z.string().min(1).max(100).optional(), parts: z.array(RestFilePart).max(16).optional(),
}))
export const RestInit = lazySchema(() => z.strictObject({ providerID: z.string().min(1).max(100), modelID: z.string().min(1).max(200), messageID: ItemId }))
export const RestSummarize = lazySchema(() => z.strictObject({ providerID: z.string().min(1).max(100), modelID: z.string().min(1).max(200), auto: z.boolean().optional(), instructions: z.string().max(8_000).optional() }))
export const RestShell = lazySchema(() => z.strictObject({ agent: z.string().min(1).max(100), command: z.string().min(1).max(8_000), model: RestModel.optional(), messageID: ItemId.optional() }))
/** v1 part update body: a text part with the new text (identity fields are checked against the route). */
export const RestPartUpdate = lazySchema(() => z.looseObject({ id: z.string().min(1).max(200), sessionID: SessionId.optional(), messageID: ItemId.optional(), type: z.string().max(50), text: z.string().max(65_536).optional() }))
/** Project-relative directory (forward slashes, no `..`); an empty path means no path filter, as in the donor API. */
export const RestProjectPath = z.string().max(1_024).refine((value) => !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && !value.includes("\0") && !value.replaceAll("\\", "/").split("/").includes(".."), "path must stay inside the project")
export const RestReadInput = lazySchema(() => z.strictObject({
  operation: z.enum(["list", "status", "agent-view", "get", "children", "todo", "diff", "messages", "message", "context", "usage"]),
  sessionId: SessionId.optional(), messageId: ItemId.optional(), queueId: QueueId.optional(),
  roots: z.boolean().optional(), start: timestamp.optional(), updatedBefore: timestamp.optional(), search: z.string().max(200).optional(), archived: z.boolean().optional(),
  scope: z.literal("project").optional(), path: RestProjectPath.optional(),
  limit: z.number().int().min(0).max(1_000).optional(), messageLimit: z.number().int().min(1).max(500).optional(), order: z.enum(["asc", "desc"]).optional(),
  before: z.string().min(1).max(8_000).optional(), after: z.string().min(1).max(8_000).optional(), cursor: z.string().min(1).max(8_000).optional(),
  view: z.enum(["full", "tui", "tui-all", "history"]).optional(), unit: z.enum(["message", "turn"]).optional(),
  partsLimit: z.number().int().min(1).max(200).optional(), partsAfter: z.string().min(1).max(8_000).optional(),
  global: z.boolean().optional(), v2: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (!["list", "status", "agent-view", "usage"].includes(value.operation) && !value.sessionId) ctx.addIssue({ code: "custom", message: "sessionId required" })
  if (value.operation === "message" && !value.messageId) ctx.addIssue({ code: "custom", message: "messageId required" })
  if ([value.before, value.after, value.cursor].filter(Boolean).length > 1) ctx.addIssue({ code: "custom", message: "one cursor only" })
  if ((value.before || value.after) && !value.limit) ctx.addIssue({ code: "custom", message: "cursor requires limit" })
  if (value.cursor && [value.order, value.roots, value.start, value.search, value.archived, value.scope, value.path].some((entry) => entry !== undefined)) ctx.addIssue({ code: "custom", message: "cursor excludes filters" })
  if ((value.scope !== undefined || value.path !== undefined) && !["list", "agent-view"].includes(value.operation)) ctx.addIssue({ code: "custom", message: "scope and path apply to session lists" })
}))
export type RestReadInput = z.infer<typeof RestReadInput>
export const SessionRestRead = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.rest.read"), directory: z.string().min(1).max(4096), input: RestReadInput }))
export const SessionRestUpdate = lazySchema(() => z.strictObject({ ...base, type: z.literal("session.rest.update"), sessionId: SessionId, patch: RestSessionUpdate }))
export type SessionRestUpdate = z.infer<typeof SessionRestUpdate>
export const SessionRestControl = lazySchema(() => z.strictObject({
  ...base, type: z.literal("session.rest.control"), sessionId: SessionId,
  operation: z.enum(["abort", "cancel-turn", "interrupt", "wait"]), targetMessageId: ItemId.optional(), queueId: QueueId.optional(),
  timeoutMs: z.number().int().min(1).max(55_000).optional(),
}).refine((value) => value.operation !== "cancel-turn" || !!value.targetMessageId, { message: "targetMessageId required" }))
/**
 * Deletes a REST message or part, or replaces a text part's text, through the native message revisions (`allowMessageEdits`
 * must be on, the session idle with an empty queue). REST ids are resolved to the native items and their current revisions
 * here, so a v1 client needs no If-Match. Ack: `{ value: true }` or, for update-part, `{ value: { id, type, text } }`.
 */
export const SessionRestMutate = lazySchema(() => z.strictObject({
  ...base, type: z.literal("session.rest.mutate"), sessionId: SessionId,
  operation: z.enum(["delete-message", "delete-part", "update-part"]), messageId: ItemId, partId: z.string().min(1).max(200).optional(), text: z.string().max(65_536).optional(),
}).refine((value) => value.operation === "delete-message" || !!value.partId, { message: "partId required" })
  .refine((value) => value.operation !== "update-part" || value.text !== undefined, { message: "text required" }))

export type RestSession = { id: SessionId; slug: string; projectID: string; directory: string; path?: string; parentID?: SessionId; title: string; version: string; agent: string; model?: z.infer<typeof RestModel>; time: { created: number; updated: number; archived?: number }; summary?: { additions: number; deletions: number; files: number }; revert?: { messageID: string; partID?: string }; permission?: PermissionRule[] }
export type RestMessage = { info: { id: ItemId; sessionID: SessionId; role: "user" | "assistant"; time: { created: number; completed?: number }; [key: string]: unknown }; parts: Array<{ id: string; sessionID: SessionId; messageID: ItemId; type: string; [key: string]: unknown }>; partsMore?: boolean; partsCursor?: string }
export type RestPage = { items: unknown[]; cursor: { previous?: string; next?: string }; truncated?: boolean }

export const RestSessionDto = lazySchema(() => z.object({
  id: SessionId, slug: z.string(), projectID: z.string(), directory: z.string(), path: z.string().optional(), title: z.string(), version: z.string(),
  parentID: SessionId.optional(), agent: z.string(), model: RestModel.optional(),
  time: z.object({ created: timestamp, updated: timestamp, archived: timestamp.optional() }),
  /** Persisted change totals (single-session reads only). */
  summary: z.object({ additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), files: z.number().int().nonnegative() }).optional(),
  /** Where the newest waiting undo cut; present while an unrevert can restore it. */
  revert: z.object({ messageID: z.string(), partID: z.string().optional() }).optional(),
  /** Rules set through REST on this session itself. */
  permission: RestSessionPermission.optional(),
}).catchall(z.unknown()))
const count = z.number().int().nonnegative()
const bag = lazySchema(() => z.record(z.string(), z.unknown()))
const Tokens = lazySchema(() => z.object({ total: count.optional(), input: count, output: count, reasoning: count, cache: z.object({ read: count, write: count }) }))
const UserInfoDto = lazySchema(() => z.object({ id: ItemId, sessionID: SessionId, role: z.literal("user"), time: z.object({ created: timestamp }), agent: z.string(), model: RestModel.optional() }).catchall(z.unknown()))
const AssistantInfoDto = lazySchema(() => z.object({
  id: ItemId, sessionID: SessionId, role: z.literal("assistant"), time: z.object({ created: timestamp, completed: timestamp.optional() }),
  parentID: ItemId.optional(), modelID: z.string().optional(), providerID: z.string().optional(), mode: z.string(), agent: z.string(),
  path: z.object({ cwd: z.string(), root: z.string() }).optional(), cost: z.number().finite().nonnegative(), tokens: Tokens, finish: z.string().optional(),
  error: z.object({ name: z.string(), data: z.object({ message: z.string() }).catchall(z.unknown()) }).optional(),
}).catchall(z.unknown()))
const partBase = { id: z.string(), sessionID: SessionId, messageID: ItemId }
const span = lazySchema(() => z.object({ start: timestamp, end: timestamp.optional() }))
const ToolStateDto = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), input: bag, raw: z.string() }).catchall(z.unknown()),
  z.object({ status: z.literal("running"), input: bag, title: z.string().optional(), time: z.object({ start: timestamp }) }).catchall(z.unknown()),
  z.object({ status: z.literal("completed"), input: bag, output: z.string(), title: z.string(), metadata: bag, time: z.object({ start: timestamp, end: timestamp }) }).catchall(z.unknown()),
  z.object({ status: z.literal("error"), input: bag, error: z.string(), metadata: bag.optional(), time: z.object({ start: timestamp, end: timestamp }) }).catchall(z.unknown()),
]))
const PartDto = lazySchema(() => z.union([
  z.object({ ...partBase, type: z.literal("text"), text: z.string(), time: span.optional(), synthetic: z.boolean().optional(), ignored: z.boolean().optional() }).catchall(z.unknown()),
  z.object({ ...partBase, type: z.literal("reasoning"), text: z.string(), time: span }).catchall(z.unknown()),
  z.object({ ...partBase, type: z.literal("tool"), callID: z.string(), tool: z.string(), state: ToolStateDto }).catchall(z.unknown()),
  z.object({ ...partBase, type: z.literal("file"), mime: z.string(), url: z.string(), filename: z.string().optional() }).catchall(z.unknown()),
  z.object({ ...partBase, type: z.literal("compaction"), auto: z.boolean() }).catchall(z.unknown()),
  z.object({ ...partBase, type: z.literal("step-start") }).catchall(z.unknown()),
  z.object({ ...partBase, type: z.literal("step-finish"), reason: z.string(), cost: z.number().finite().nonnegative(), tokens: Tokens }).catchall(z.unknown()),
]))
export const RestMessageDto = lazySchema(() => z.object({
  info: z.discriminatedUnion("role", [UserInfoDto, AssistantInfoDto]),
  parts: z.array(PartDto),
  partsMore: z.boolean().optional(), partsCursor: z.string().optional(),
}))
export const RestAgentViewDto = lazySchema(() => z.object({
  sessionID: SessionId, state: z.enum(["queued", "working", "needs_input", "completed", "failed", "stopped"]), summary: z.string().optional(), error: z.string().optional(), pinned: z.boolean(),
  process: z.object({ pid: count, started: timestamp }).optional(), writer: z.object({ clientID: z.string(), acquired: timestamp, expires: timestamp }).optional(),
  time: z.object({ created: timestamp, updated: timestamp }), session: RestSessionDto.optional(),
  metadata: z.object({ sessionID: SessionId, title: z.string().optional(), tags: z.array(z.string()), group: z.string().optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), notes: z.string().optional(), pinned: z.boolean(), archived: z.boolean(), time: z.object({ created: timestamp, updated: timestamp }) }).optional(),
  status: z.object({ type: z.enum(["idle", "busy"]) }),
}).catchall(z.unknown()))
