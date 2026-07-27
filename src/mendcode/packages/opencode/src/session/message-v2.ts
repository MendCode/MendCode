import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
import { NamedError } from "@mendcode/core/util/error"
import {
  APICallError,
  convertToModelMessages,
  LoadAPIKeyError,
  type AssistantModelMessage,
  type FilePart as ModelFilePart,
  type ModelMessage,
  type UIMessage,
  type UserModelMessage,
} from "ai"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "../sync"
import { Database } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { and } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lt } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { or } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { gte } from "drizzle-orm"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import * as ProviderError from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import { isMedia, sniffAttachmentMime } from "@/util/media"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect, Schema, Types } from "effect"
import { zod, ZodOverride } from "@/util/effect-zod"
import { NonNegativeInt, withStatics } from "@/util/schema"
import { namedSchemaError } from "@/util/named-schema-error"
import * as EffectLogger from "@mendcode/core/effect/logger"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTCONN",
  "ENOTFOUND",
  "EPIPE",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_REQUEST_ABORTED",
  "UND_ERR_SOCKET",
])

function normalizedNetworkErrorCode(code: unknown) {
  if (typeof code !== "string") return undefined
  const normalized = code.toUpperCase()
  if (RETRYABLE_NETWORK_ERROR_CODES.has(normalized)) return normalized

  // The AI SDK wraps some fetch transport failures with descriptive codes
  // instead of the Node errno used by the retry policy.
  switch (normalized) {
    case "CONNECTIONREFUSED":
      return "ECONNREFUSED"
    case "CONNECTIONRESET":
      return "ECONNRESET"
    case "CONNECTIONABORTED":
      return "ECONNABORTED"
    case "NETWORKUNREACHABLE":
      return "ENETUNREACH"
    case "HOSTUNREACHABLE":
      return "EHOSTUNREACH"
    default:
      return undefined
  }
}

type RetryableNetworkError = {
  message: string
  metadata: Record<string, string>
}

type EmbeddedDataUrlDownloadError = {
  mediaType: string
}

export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached image(s) from tool result:"
export const COMPACTION_CONTEXT_MARKER =
  "<compaction_context>Use the following compaction summary as cumulative state. This is not a new user request. Do not repeat completed work; continue from the summary's next required action.</compaction_context>"
export { isMedia }

export const OutputLengthError = namedSchemaError("MessageOutputLengthError", {})
export const AbortedError = namedSchemaError("MessageAbortedError", { message: Schema.String })
export const StructuredOutputError = namedSchemaError("StructuredOutputError", {
  message: Schema.String,
  retries: NonNegativeInt,
})
export const AuthError = namedSchemaError("ProviderAuthError", {
  providerID: Schema.String,
  message: Schema.String,
})
export const APIError = namedSchemaError("APIError", {
  message: Schema.String,
  statusCode: Schema.optional(NonNegativeInt),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  responseBody: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type APIError = z.infer<typeof APIError.Schema>
export const ContextOverflowError = namedSchemaError("ContextOverflowError", {
  message: Schema.String,
  responseBody: Schema.optional(Schema.String),
})

export class OutputFormatText extends Schema.Class<OutputFormatText>("OutputFormatText")({
  type: Schema.Literal("text"),
}) {
  static readonly zod = zod(this)
}

export class OutputFormatJsonSchema extends Schema.Class<OutputFormatJsonSchema>("OutputFormatJsonSchema")({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}) {
  static readonly zod = zod(this)
}

const _Format = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export const Format = Object.assign(_Format, { zod: zod(_Format) })
export type OutputFormat = Schema.Schema.Type<typeof _Format>

const partBase = {
  id: PartID,
  sessionID: SessionID,
  messageID: MessageID,
}

export const SnapshotPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("snapshot"),
  snapshot: Schema.String,
})
  .annotate({ identifier: "SnapshotPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SnapshotPart = Types.DeepMutable<Schema.Schema.Type<typeof SnapshotPart>>

export const PatchPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("patch"),
  hash: Schema.String,
  files: Schema.Array(Schema.String),
})
  .annotate({ identifier: "PatchPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type PatchPart = Types.DeepMutable<Schema.Schema.Type<typeof PatchPart>>

export const TextPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "TextPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TextPart = Types.DeepMutable<Schema.Schema.Type<typeof TextPart>>

export const ReasoningPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: Schema.optional(NonNegativeInt),
  }),
})
  .annotate({ identifier: "ReasoningPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReasoningPart = Types.DeepMutable<Schema.Schema.Type<typeof ReasoningPart>>

const filePartSourceBase = {
  text: Schema.Struct({
    value: Schema.String,
    start: NonNegativeInt,
    end: NonNegativeInt,
  }).annotate({ identifier: "FilePartSourceText" }),
}

export const FileSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("file"),
  path: Schema.String,
})
  .annotate({ identifier: "FileSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export const SymbolSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: LSP.Range,
  name: Schema.String,
  kind: NonNegativeInt,
})
  .annotate({ identifier: "SymbolSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export const ResourceSource = Schema.Struct({
  ...filePartSourceBase,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
})
  .annotate({ identifier: "ResourceSource" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

const _FilePartSource = Schema.Union([FileSource, SymbolSource, ResourceSource]).annotate({
  discriminator: "type",
  identifier: "FilePartSource",
})
export const FilePartSource = Object.assign(_FilePartSource, { zod: zod(_FilePartSource) })

export const FilePart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(_FilePartSource),
})
  .annotate({ identifier: "FilePart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FilePart = Types.DeepMutable<Schema.Schema.Type<typeof FilePart>>

export const AgentPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
})
  .annotate({ identifier: "AgentPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AgentPart = Types.DeepMutable<Schema.Schema.Type<typeof AgentPart>>

export const CompactionPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("compaction"),
  auto: Schema.Boolean,
  overflow: Schema.optional(Schema.Boolean),
  resume: Schema.optional(Schema.Boolean),
  discard_tail: Schema.optional(Schema.Boolean),
  rescue_attempt: Schema.optional(NonNegativeInt),
  post_prompt: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  tail_start_id: Schema.optional(MessageID),
})
  .annotate({ identifier: "CompactionPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type CompactionPart = Types.DeepMutable<Schema.Schema.Type<typeof CompactionPart>>

export const SubtaskPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
})
  .annotate({ identifier: "SubtaskPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SubtaskPart = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPart>>

export const RetryPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("retry"),
  attempt: NonNegativeInt,
  error: APIError.EffectSchema,
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
})
  .annotate({ identifier: "RetryPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type RetryPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof RetryPart>>, "error"> & {
  error: APIError
}

export const StepStartPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-start"),
  snapshot: Schema.optional(Schema.String),
})
  .annotate({ identifier: "StepStartPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type StepStartPart = Types.DeepMutable<Schema.Schema.Type<typeof StepStartPart>>

export const StepFinishPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("step-finish"),
  reason: Schema.String,
  snapshot: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(NonNegativeInt),
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cache: Schema.Struct({
      read: NonNegativeInt,
      write: NonNegativeInt,
    }),
  }),
})
  .annotate({ identifier: "StepFinishPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type StepFinishPart = Types.DeepMutable<Schema.Schema.Type<typeof StepFinishPart>>

export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.Record(Schema.String, Schema.Any),
  raw: Schema.String,
})
  .annotate({ identifier: "ToolStatePending" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStatePending = Types.DeepMutable<Schema.Schema.Type<typeof ToolStatePending>>

export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Any),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
  }),
})
  .annotate({ identifier: "ToolStateRunning" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateRunning = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateRunning>>

export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Any),
  output: Schema.String,
  title: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Any),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
    compacted: Schema.optional(NonNegativeInt),
  }),
  attachments: Schema.optional(Schema.Array(FilePart)),
})
  .annotate({ identifier: "ToolStateCompleted" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateCompleted = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateCompleted>>

function truncateToolOutput(text: string, maxChars?: number) {
  if (!maxChars || text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
}

export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Any),
  error: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  time: Schema.Struct({
    start: NonNegativeInt,
    end: NonNegativeInt,
  }),
})
  .annotate({ identifier: "ToolStateError" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolStateError = Types.DeepMutable<Schema.Schema.Type<typeof ToolStateError>>

const _ToolState = Schema.Union([ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError]).annotate({
  discriminator: "status",
  identifier: "ToolState",
})
// Cast the derived zod so downstream z.infer sees the same mutable shape that
// our exported TS types expose (the pre-migration Zod inferences were mutable).
export const ToolState = Object.assign(_ToolState, {
  zod: zod(_ToolState) as unknown as z.ZodType<
    ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError
  >,
})
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export const ToolPart = Schema.Struct({
  ...partBase,
  type: Schema.Literal("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: _ToolState,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "ToolPart" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ToolPart = Omit<Types.DeepMutable<Schema.Schema.Type<typeof ToolPart>>, "state"> & {
  state: ToolState
}

const messageBase = {
  id: MessageID,
  sessionID: SessionID,
}

export const User = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: NonNegativeInt,
  }),
  format: Schema.optional(_Format),
  summary: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      diffs: Schema.Array(Snapshot.FileDiff),
    }),
  ),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    variant: Schema.optional(Schema.String),
  }),
  system: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})
  .annotate({ identifier: "UserMessage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type User = Types.DeepMutable<Schema.Schema.Type<typeof User>>

const _Part = Schema.Union([
  TextPart,
  SubtaskPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
]).annotate({ discriminator: "type", identifier: "Part" })
export const Part = Object.assign(_Part, {
  zod: zod(_Part) as unknown as z.ZodType<
    | TextPart
    | SubtaskPart
    | ReasoningPart
    | FilePart
    | ToolPart
    | StepStartPart
    | StepFinishPart
    | SnapshotPart
    | PatchPart
    | AgentPart
    | RetryPart
    | CompactionPart
  >,
})
export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

// Zod discriminated union kept for the legacy Hono OpenAPI path.
const AssistantErrorZod = z.discriminatedUnion("name", [
  AuthError.Schema,
  NamedError.Unknown.Schema,
  OutputLengthError.Schema,
  AbortedError.Schema,
  StructuredOutputError.Schema,
  ContextOverflowError.Schema,
  APIError.Schema,
])
type AssistantError = z.infer<typeof AssistantErrorZod>

// Effect Schema for the same union — used by HttpApi OpenAPI generation.
const AssistantErrorSchema = Schema.Union([
  AuthError.EffectSchema,
  Schema.Struct({ name: Schema.Literal("UnknownError"), data: Schema.Struct({ message: Schema.String }) }).annotate({
    identifier: "UnknownError",
  }),
  OutputLengthError.EffectSchema,
  AbortedError.EffectSchema,
  StructuredOutputError.EffectSchema,
  ContextOverflowError.EffectSchema,
  APIError.EffectSchema,
]).annotate({ discriminator: "name" })

// ── Prompt input schemas ─────────────────────────────────────────────────────
//
// Consumers of `SessionPrompt.PromptInput.parts` send part drafts without the
// ambient IDs (`messageID`, `sessionID`) that live on stored parts, and may
// omit `id` to let the server allocate one.  These Schema-Struct variants
// carry that shape, and `SessionPrompt.PromptInput` just references the
// derived `.zod` (no omit/partial gymnastics needed at the call site).

export const TextPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(
    Schema.Struct({
      start: NonNegativeInt,
      end: Schema.optional(NonNegativeInt),
    }),
  ),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})
  .annotate({ identifier: "TextPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type TextPartInput = Types.DeepMutable<Schema.Schema.Type<typeof TextPartInput>>

export const FilePartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(_FilePartSource),
})
  .annotate({ identifier: "FilePartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type FilePartInput = Types.DeepMutable<Schema.Schema.Type<typeof FilePartInput>>

export const AgentPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(
    Schema.Struct({
      value: Schema.String,
      start: NonNegativeInt,
      end: NonNegativeInt,
    }),
  ),
})
  .annotate({ identifier: "AgentPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AgentPartInput = Types.DeepMutable<Schema.Schema.Type<typeof AgentPartInput>>

export const SubtaskPartInput = Schema.Struct({
  id: Schema.optional(PartID),
  type: Schema.Literal("subtask"),
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Schema.optional(
    Schema.Struct({
      providerID: ProviderID,
      modelID: ModelID,
    }),
  ),
  command: Schema.optional(Schema.String),
})
  .annotate({ identifier: "SubtaskPartInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type SubtaskPartInput = Types.DeepMutable<Schema.Schema.Type<typeof SubtaskPartInput>>

export const Assistant = Schema.Struct({
  ...messageBase,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: NonNegativeInt,
    completed: Schema.optional(NonNegativeInt),
  }),
  error: Schema.optional(AssistantErrorSchema),
  parentID: MessageID,
  modelID: ModelID,
  providerID: ProviderID,
  /**
   * @deprecated
   */
  mode: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    total: Schema.optional(NonNegativeInt),
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cache: Schema.Struct({
      read: NonNegativeInt,
      write: NonNegativeInt,
    }),
  }),
  liveUsage: Schema.optional(
    Schema.Struct({
      source: Schema.Union([Schema.Literal("provider"), Schema.Literal("tokenizer"), Schema.Literal("estimate")]),
      phase: Schema.Union([Schema.Literal("input"), Schema.Literal("output")]),
      input: NonNegativeInt,
      output: NonNegativeInt,
      reasoning: NonNegativeInt,
      cache: Schema.Struct({
        read: NonNegativeInt,
        write: NonNegativeInt,
      }),
    }),
  ),
  structured: Schema.optional(Schema.Any),
  variant: Schema.optional(Schema.String),
  finish: Schema.optional(Schema.String),
})
  .annotate({ identifier: "AssistantMessage" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Assistant = Omit<Types.DeepMutable<Schema.Schema.Type<typeof Assistant>>, "error"> & {
  error?: AssistantError
}

const _Info = Schema.Union([User, Assistant]).annotate({ discriminator: "role", identifier: "Message" })
export const Info = Object.assign(_Info, {
  zod: zod(_Info) as unknown as z.ZodType<User | Assistant>,
})
export type Info = User | Assistant

const UpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  info: _Info,
})

const RemovedEventSchema = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  reason: Schema.optional(Schema.Literal("revert")),
})

const PartUpdatedEventSchema = Schema.Struct({
  sessionID: SessionID,
  part: _Part,
  time: NonNegativeInt,
})

const PartRemovedEventSchema = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: PartID,
})

export const Event = {
  Updated: SyncEvent.define({
    type: "message.updated",
    version: 1,
    aggregate: "sessionID",
    schema: UpdatedEventSchema,
  }),
  Removed: SyncEvent.define({
    type: "message.removed",
    version: 1,
    aggregate: "sessionID",
    schema: RemovedEventSchema,
  }),
  PartUpdated: SyncEvent.define({
    type: "message.part.updated",
    version: 1,
    aggregate: "sessionID",
    schema: PartUpdatedEventSchema,
  }),
  PartDelta: BusEvent.define(
    "message.part.delta",
    Schema.Struct({
      sessionID: SessionID,
      messageID: MessageID,
      partID: PartID,
      field: Schema.String,
      delta: Schema.String,
    }),
  ),
  PartRemoved: SyncEvent.define({
    type: "message.part.removed",
    version: 1,
    aggregate: "sessionID",
    schema: PartRemovedEventSchema,
  }),
}

export const WithParts = Schema.Struct({
  info: _Info,
  parts: Schema.Array(_Part),
  partsMore: Schema.optional(Schema.Boolean),
  partsCursor: Schema.optional(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type WithParts = {
  info: Info
  parts: Part[]
  partsMore?: boolean
  partsCursor?: string
}

const Cursor = Schema.Struct({
  id: MessageID,
  time: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
type Cursor = typeof Cursor.Type

const decodeCursor = Schema.decodeUnknownSync(Cursor)

export const cursor = {
  encode(input: Cursor) {
    return Buffer.from(JSON.stringify(input)).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

const info = (row: typeof MessageTable.$inferSelect) =>
  ({
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  }) as Info

export type PageView = "full" | "tui" | "tui-all"

function previewInfoForTui(message: Info): Info {
  if (message.role !== "user" || !message.summary) return message
  return {
    ...message,
    summary: {
      ...message.summary,
      title: message.summary.title
        ? previewString(message.summary.title, TUI_FIELD_PREVIEW_CHARS, "summary title")
        : message.summary.title,
      body: message.summary.body
        ? previewString(message.summary.body, TUI_METADATA_PREVIEW_CHARS, "summary body")
        : message.summary.body,
      diffs: message.summary.diffs.slice(0, TUI_SUMMARY_DIFF_LIMIT).map((diff) => ({
        ...diff,
        file: previewString(diff.file, TUI_FIELD_PREVIEW_CHARS, "summary diff file"),
        patch: previewDiff(diff.patch),
      })),
    },
  }
}

const TUI_TEXT_PREVIEW_CHARS = 128 * 1024
const TUI_TOOL_OUTPUT_PREVIEW_CHARS = 16 * 1024
const TUI_METADATA_PREVIEW_CHARS = 4 * 1024
const TUI_DIFF_PREVIEW_CHARS = 512 * 1024
const TUI_CONTENT_PREVIEW_CHARS = 512 * 1024
const TUI_FIELD_PREVIEW_CHARS = 2 * 1024
const TUI_PATCH_FILE_LIMIT = 256
const TUI_PREVIEW_ARRAY_LIMIT = 8
const TUI_SUMMARY_DIFF_LIMIT = 64
const TUI_PARTS_PAGE_LIMIT = 96

function previewString(input: string, maxChars: number, _label: string) {
  if (input.length <= maxChars) return input
  return input.slice(0, maxChars)
}

function previewContent(input: string, label: string) {
  if (input.length <= TUI_CONTENT_PREVIEW_CHARS) return input
  const marker = `\n[${label} preview truncated: omitted ${input.length - TUI_CONTENT_PREVIEW_CHARS} chars; showing the beginning.]\n`
  const budget = Math.max(0, TUI_CONTENT_PREVIEW_CHARS - marker.length)
  return `${input.slice(0, budget)}${marker}`
}

function previewDiff(input: string) {
  if (input.length <= TUI_DIFF_PREVIEW_CHARS) return input
  const marker = "\n[Diff preview truncated: too large to render safely. Show more to inspect the full diff.]\n"
  const budget = Math.max(0, TUI_DIFF_PREVIEW_CHARS - marker.length)
  if (budget <= 0) return marker.slice(0, TUI_DIFF_PREVIEW_CHARS)
  const head = Math.floor(budget / 3)
  return `${input.slice(0, head)}${marker}${input.slice(input.length - (budget - head))}`
}

function previewUnknown(input: unknown, maxChars: number, label: string, depth = 0): unknown {
  if (typeof input === "string") return previewString(input, maxChars, label)
  if (!input || typeof input !== "object") return input
  if (depth >= 5) return "[nested value omitted]"
  if (Array.isArray(input)) {
    const itemLimit = Math.min(TUI_PREVIEW_ARRAY_LIMIT, Math.max(1, Math.floor(maxChars / 1024)))
    const itemMaxChars = Math.max(256, Math.floor(maxChars / itemLimit))
    return input
      .slice(0, itemLimit)
      .map((item) => previewUnknown(item, itemMaxChars, label, depth + 1))
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const diffLike = key === "diff" || key === "patch"
    const nextMax = diffLike
      ? TUI_DIFF_PREVIEW_CHARS
      : key === "content"
        ? TUI_CONTENT_PREVIEW_CHARS
        : key === "output"
          ? maxChars
          : Math.min(maxChars, TUI_FIELD_PREVIEW_CHARS)
    result[key] =
      diffLike && typeof value === "string"
        ? previewDiff(value)
        : key === "content" && typeof value === "string"
          ? previewContent(value, `${label}.${key}`)
        : previewUnknown(value, nextMax, `${label}.${key}`, depth + 1)
  }
  return result
}

function previewFilePartForTui(part: FilePart): FilePart {
  const dataUrl = part.url.startsWith("data:")
  return {
    ...part,
    url: dataUrl ? previewString(part.url, TUI_FIELD_PREVIEW_CHARS, "file url") : part.url,
    source: previewUnknown(part.source, TUI_FIELD_PREVIEW_CHARS, "file source") as FilePart["source"],
  }
}

export function previewPartForTui(part: Part): Part {
  switch (part.type) {
    case "text":
      return { ...part, text: previewString(part.text, TUI_TEXT_PREVIEW_CHARS, "text part") }
    case "reasoning":
      return { ...part, text: previewString(part.text, TUI_TEXT_PREVIEW_CHARS, "reasoning part") }
    case "file":
      return previewFilePartForTui(part)
    case "patch":
      return { ...part, files: part.files.slice(0, TUI_PATCH_FILE_LIMIT) }
    case "snapshot":
      return { ...part, snapshot: previewString(part.snapshot, TUI_FIELD_PREVIEW_CHARS, "snapshot") }
    case "step-start":
      return part.snapshot
        ? { ...part, snapshot: previewString(part.snapshot, TUI_FIELD_PREVIEW_CHARS, "snapshot") }
        : part
    case "step-finish":
      return {
        ...part,
        metadata: previewUnknown(part.metadata, TUI_METADATA_PREVIEW_CHARS, "step metadata") as typeof part.metadata,
      }
    case "tool": {
      const state =
        part.state.status === "pending"
          ? {
              ...part.state,
              raw: previewString(part.state.raw, TUI_FIELD_PREVIEW_CHARS, "tool raw input"),
              input: previewUnknown(part.state.input, TUI_FIELD_PREVIEW_CHARS, "tool input") as typeof part.state.input,
            }
          : part.state.status === "running"
            ? {
                ...part.state,
                input: previewUnknown(
                  part.state.input,
                  TUI_FIELD_PREVIEW_CHARS,
                  "tool input",
                ) as typeof part.state.input,
                metadata: previewUnknown(
                  part.state.metadata,
                  TUI_METADATA_PREVIEW_CHARS,
                  "tool metadata",
                ) as typeof part.state.metadata,
              }
            : part.state.status === "completed"
              ? {
                  ...part.state,
                  input: previewUnknown(
                    part.state.input,
                    TUI_FIELD_PREVIEW_CHARS,
                    "tool input",
                  ) as typeof part.state.input,
                  output: previewString(part.state.output, TUI_TOOL_OUTPUT_PREVIEW_CHARS, "tool output"),
                  metadata: previewUnknown(
                    part.state.metadata,
                    TUI_METADATA_PREVIEW_CHARS,
                    "tool metadata",
                  ) as typeof part.state.metadata,
                  attachments: part.state.attachments?.map(previewFilePartForTui),
                }
              : {
                  ...part.state,
                  input: previewUnknown(
                    part.state.input,
                    TUI_FIELD_PREVIEW_CHARS,
                    "tool input",
                  ) as typeof part.state.input,
                  error: previewString(part.state.error, TUI_TOOL_OUTPUT_PREVIEW_CHARS, "tool error"),
                  metadata: previewUnknown(
                    part.state.metadata,
                    TUI_METADATA_PREVIEW_CHARS,
                    "tool metadata",
                  ) as typeof part.state.metadata,
                }
      return {
        ...part,
        state,
        metadata: previewUnknown(
          part.metadata,
          TUI_METADATA_PREVIEW_CHARS,
          "tool part metadata",
        ) as typeof part.metadata,
      }
    }
    default:
      return part
  }
}

const part = (row: typeof PartTable.$inferSelect, view: PageView = "full") => {
  const hydrated = {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
  } as Part
  return view === "tui" || view === "tui-all" ? previewPartForTui(hydrated) : hydrated
}

const older = (row: Cursor) =>
  or(lt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)))

const newer = (row: Cursor) =>
  or(gt(MessageTable.time_created, row.time), and(eq(MessageTable.time_created, row.time), gt(MessageTable.id, row.id)))

function encodePartCursor(id: string) {
  return Buffer.from(JSON.stringify({ id })).toString("base64url")
}

function decodePartCursor(input: string) {
  const value = JSON.parse(Buffer.from(input, "base64url").toString("utf8"))
  if (!value || typeof value.id !== "string") throw new Error("Invalid part cursor")
  return value.id
}

function hydrate(
  rows: (typeof MessageTable.$inferSelect)[],
  options: {
    view?: PageView
    partsLimit?: number
    partsAfter?: string
    partFilter?: (row: typeof PartTable.$inferSelect) => boolean
  } = {},
) {
  const ids = rows.map((row) => row.id)
  const partByMessage = new Map<string, { parts: Part[]; more?: boolean; cursor?: string }>()
  if (ids.length > 0) {
    if (options.partsLimit === undefined) {
      const partRows = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(inArray(PartTable.message_id, ids))
          .orderBy(PartTable.message_id, PartTable.id)
          .all(),
      )
      for (const row of partRows) {
        if (options.partFilter && !options.partFilter(row)) continue
        const next = part(row, options.view)
        const current = partByMessage.get(row.message_id)
        if (current) current.parts.push(next)
        else partByMessage.set(row.message_id, { parts: [next] })
      }
    } else {
      const limit = Math.max(1, Math.floor(options.partsLimit))
      const after = options.partsAfter ? decodePartCursor(options.partsAfter) : undefined
      for (const messageID of ids) {
        const partRows = Database.use((db) =>
          db
            .select()
            .from(PartTable)
            .where(
              after
                ? and(eq(PartTable.message_id, messageID), gt(PartTable.id, after))
                : eq(PartTable.message_id, messageID),
            )
            .orderBy(PartTable.id)
            .limit(limit + 1)
            .all(),
        )
        const more = partRows.length > limit
        const selected = (options.partFilter ? partRows.filter(options.partFilter) : partRows).slice(0, limit)
        const parts = selected.map((row) => part(row, options.view))
        const last = selected.at(-1) ?? (more ? partRows.at(-1) : undefined)
        partByMessage.set(messageID, {
          parts,
          more,
          cursor: more && last ? encodePartCursor(last.id) : undefined,
        })
      }
    }
  }

  return rows.map((row) => {
    const hydrated = partByMessage.get(row.id)
    const message = info(row)
    const renderedInfo = options.view === "tui" || options.view === "tui-all" ? previewInfoForTui(message) : message
    if (!hydrated) return { info: renderedInfo, parts: [] }
    return {
      info: renderedInfo,
      parts: hydrated.parts,
      ...(options.partsLimit !== undefined ? { partsMore: hydrated.more === true, partsCursor: hydrated.cursor } : {}),
    }
  })
}

function providerMeta(metadata: Record<string, any> | undefined) {
  if (!metadata) return undefined
  const { providerExecuted: _, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

function dataUrlBytes(url: string) {
  if (!url.startsWith("data:")) return undefined
  const commaIndex = url.indexOf(",")
  if (commaIndex === -1) return undefined
  const metadata = url.slice("data:".length, commaIndex)
  const body = url.slice(commaIndex + 1)
  if (metadata.includes(";base64")) return new Uint8Array(Buffer.from(body, "base64"))
  try {
    return new Uint8Array(Buffer.from(decodeURIComponent(body), "utf8"))
  } catch {
    return undefined
  }
}

function dataUrlBase64(url: string) {
  if (!url.startsWith("data:")) return undefined
  const commaIndex = url.indexOf(",")
  if (commaIndex === -1) return undefined
  const metadata = url.slice("data:".length, commaIndex)
  const body = url.slice(commaIndex + 1)
  if (metadata.includes(";base64")) return body
  try {
    return Buffer.from(decodeURIComponent(body), "utf8").toString("base64")
  } catch {
    return undefined
  }
}

function bytesEndWith(bytes: Uint8Array, suffix: number[]) {
  if (bytes.length < suffix.length) return false
  return suffix.every((value, index) => bytes[bytes.length - suffix.length + index] === value)
}

function hasCompleteImageBytes(bytes: Uint8Array, mediaType: string) {
  if (mediaType === "image/png")
    return bytesEndWith(bytes, [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  return true
}

function isValidEmbeddedImage(bytes: Uint8Array, mediaType: string) {
  if (!mediaType.startsWith("image/")) return true
  if (mediaType === "image/svg+xml") {
    const text = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 512))).trimStart()
    return text.startsWith("<svg") || text.startsWith("<?xml")
  }
  return sniffAttachmentMime(bytes, "") === mediaType && hasCompleteImageBytes(bytes, mediaType)
}

function invalidEmbeddedImageText(mediaType: string, filename?: string) {
  return `ERROR: Attached ${mediaType} file${filename ? ` (${filename})` : ""} is empty or corrupted. Ask the user to re-attach it.`
}

function normalizeEmbeddedDataUrlFilePart(part: ModelFilePart): ModelFilePart | { type: "text"; text: string } {
  if (typeof part.data !== "string") return part
  const data = dataUrlBytes(part.data)
  if (!data) return part
  if (!isValidEmbeddedImage(data, part.mediaType)) {
    return {
      type: "text",
      text: invalidEmbeddedImageText(part.mediaType, part.filename),
    }
  }
  return { ...part, data }
}

function embeddedDataUrlMediaContent(attachment: { mime: string; url: string }) {
  const data = dataUrlBytes(attachment.url)
  if (data && !isValidEmbeddedImage(data, attachment.mime)) {
    return { type: "text" as const, text: invalidEmbeddedImageText(attachment.mime) }
  }
  const commaIndex = attachment.url.indexOf(",")
  return {
    type: "media" as const,
    mediaType: attachment.mime,
    data: dataUrlBase64(attachment.url) ?? (commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)),
  }
}

function normalizeEmbeddedDataUrlContent(message: UserModelMessage): UserModelMessage
function normalizeEmbeddedDataUrlContent(message: AssistantModelMessage): AssistantModelMessage
function normalizeEmbeddedDataUrlContent(message: UserModelMessage | AssistantModelMessage) {
  if (typeof message.content === "string") return message
  return {
    ...message,
    content: message.content.map((part) => (part.type === "file" ? normalizeEmbeddedDataUrlFilePart(part) : part)),
  }
}

function normalizeEmbeddedDataUrlFiles(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "user") return normalizeEmbeddedDataUrlContent(message)
    if (message.role === "assistant") return normalizeEmbeddedDataUrlContent(message)
    return message
  })
}

function dataUrlMediaType(url: string) {
  if (!url.startsWith("data:")) return undefined
  const metadata = url.slice("data:".length, url.indexOf(",") === -1 ? undefined : url.indexOf(","))
  return metadata.split(";", 1)[0] || "file"
}

export const toModelMessagesEffect = Effect.fnUntraced(function* (
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
) {
  const result: UIMessage[] = []
  const toolNames = new Set<string>()
  // Track media from tool results that need to be injected as user messages
  // for providers that don't support media in tool results.
  //
  // OpenAI-compatible APIs only support string content in tool results, so we need
  // to extract media and inject as user messages. Other SDKs (anthropic, google,
  // bedrock) handle type: "content" with media parts natively.
  //
  // Only apply this workaround if the model actually supports image input -
  // otherwise there's no point extracting images.
  const supportsMediaInToolResults = (() => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  })()

  const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
    const output = options.output
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          ...(outputObject.text ? [{ type: "text", text: outputObject.text }] : []),
          ...attachments.map(embeddedDataUrlMediaContent),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage: UIMessage = {
        id: msg.info.id,
        role: "user",
        parts: [],
      }
      result.push(userMessage)
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored)
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        // text/plain and directory files are converted into text parts, ignore them
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: COMPACTION_CONTEXT_MARKER,
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string }> = []

      if (
        msg.info.error &&
        !(
          AbortedError.isInstance(msg.info.error) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage: UIMessage = {
        id: msg.info.id,
        role: "assistant",
        parts: [],
      }
      for (const part of msg.parts) {
        if (part.type === "text")
          assistantMessage.parts.push({
            type: "text",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted
              ? "[Old tool result content cleared]"
              : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            // For providers that don't support media in tool results, extract media files
            // (images, PDFs) to be sent as a separate user message
            const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
            const nonMediaAttachments = attachments.filter((a) => !isMedia(a.mime))
            if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
              media.push(...mediaAttachments)
            }
            const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

            const output =
              finalAttachments.length > 0
                ? {
                    text: outputText,
                    attachments: finalAttachments,
                  }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
          }
          if (part.state.status === "error") {
            const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
            if (typeof output === "string") {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            } else {
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
          }
          // Handle pending/running tool calls to prevent dangling tool_use blocks
          // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
              ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
            })
        }
        if (part.type === "reasoning") {
          if (differentModel) {
            if (part.text.trim().length > 0)
              assistantMessage.parts.push({
                type: "text",
                text: part.text,
              })
            continue
          }
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            providerMetadata: part.metadata,
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        // Inject pending media as a user message for providers that don't support
        // media (images, PDFs) in tool results
        if (media.length > 0) {
          result.push({
            id: MessageID.ascending(),
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: SYNTHETIC_ATTACHMENT_PROMPT,
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return yield* Effect.promise(async () =>
    normalizeEmbeddedDataUrlFiles(
      await convertToModelMessages(
        result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
        {
          //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
          tools,
        },
      ),
    ),
  )
})

export function toModelMessages(
  input: WithParts[],
  model: Provider.Model,
  options?: { stripMedia?: boolean; toolOutputMaxChars?: number },
): Promise<ModelMessage[]> {
  return Effect.runPromise(toModelMessagesEffect(input, model, options).pipe(Effect.provide(EffectLogger.layer)))
}

function compactedHistoryBoundary(sessionID: SessionID) {
  return Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, sessionID),
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
          sql`json_extract(${MessageTable.data}, '$.summary') = 1`,
          sql`json_extract(${MessageTable.data}, '$.time.completed') IS NOT NULL`,
        ),
      )
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(1)
      .get(),
  )
}

function compactionTailByMessage(rows: Array<typeof MessageTable.$inferSelect>) {
  const result = new Map<MessageID, MessageID | null>()
  if (rows.length === 0) return result
  const parts = Database.use((db) =>
    db
      .select({
        messageID: PartTable.message_id,
        tailStartID: sql<MessageID | null>`json_extract(${PartTable.data}, '$.tail_start_id')`,
      })
      .from(PartTable)
      .where(
        and(
          inArray(
            PartTable.message_id,
            rows.map((row) => row.id),
          ),
          sql`json_extract(${PartTable.data}, '$.type') = 'compaction'`,
        ),
      )
      .orderBy(PartTable.message_id, PartTable.id)
      .all(),
  )
  for (const part of parts) {
    if (!result.has(part.messageID)) result.set(part.messageID, part.tailStartID)
  }
  return result
}

function compactedHistory(sessionID: SessionID) {
  if (!compactedHistoryBoundary(sessionID)) return filterCompacted(stream(sessionID))

  const result: WithParts[] = []
  const completed = new Set<string>()
  let retain: MessageID | undefined
  let before: Cursor | undefined
  const size = 50

  while (true) {
    const where = before
      ? and(eq(MessageTable.session_id, sessionID), older(before))
      : eq(MessageTable.session_id, sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(where)
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .limit(size)
        .all(),
    )
    if (rows.length === 0) {
      const session = Database.use((db) =>
        db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
      )
      if (!session) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      break
    }

    const compactionTail = compactionTailByMessage(rows)
    const retainedRows: Array<typeof MessageTable.$inferSelect> = []
    let exhausted = false
    for (const row of rows) {
      retainedRows.push(row)
      const message = info(row)
      if (retain) {
        if (row.id === retain) exhausted = true
        if (exhausted) break
        continue
      }
      if (message.role === "user" && completed.has(message.id)) {
        if (!compactionTail.has(message.id)) continue
        const tailStartID = compactionTail.get(message.id)
        if (!tailStartID) {
          exhausted = true
          break
        }
        retain = tailStartID
        if (row.id === retain) exhausted = true
        if (exhausted) break
        continue
      }
      if (message.role === "assistant" && message.summary && message.finish && !message.error) {
        completed.add(message.parentID)
      }
    }

    result.push(...hydrate(retainedRows))
    if (exhausted || rows.length < size) break
    const tail = rows.at(-1)
    if (!tail) break
    before = { id: tail.id, time: tail.time_created }
  }

  return filterCompacted(result)
}

function compactedHistoryPageRows(
  rows: Array<typeof MessageTable.$inferSelect>,
  boundary: typeof MessageTable.$inferSelect,
) {
  const compacted = rows.filter(
    (row) =>
      row.time_created < boundary.time_created || (row.time_created === boundary.time_created && row.id <= boundary.id),
  )
  const parts =
    compacted.length === 0
      ? []
      : Database.use((db) =>
          db
            .select({
              messageID: PartTable.message_id,
              type: sql<string>`json_extract(${PartTable.data}, '$.type')`,
              synthetic: sql<number | null>`json_extract(${PartTable.data}, '$.synthetic')`,
            })
            .from(PartTable)
            .where(
              and(
                inArray(
                  PartTable.message_id,
                  compacted.map((row) => row.id),
                ),
                sql`(
                json_extract(${PartTable.data}, '$.type') = 'compaction'
                OR (
                  json_extract(${PartTable.data}, '$.type') = 'text'
                  AND length(trim(coalesce(json_extract(${PartTable.data}, '$.text'), ''))) > 0
                )
              )`,
              ),
            )
            .all(),
        )
  const assistantText = new Set(parts.filter((part) => part.type === "text").map((part) => part.messageID))
  const userContent = new Set(
    parts
      .filter((part) => part.type === "compaction" || (part.type === "text" && part.synthetic !== 1))
      .map((part) => part.messageID),
  )
  const visible = new Set<string>()
  const support = new Set<string>()
  rows.forEach((row) => {
    const message = info(row)
    if (message.role === "assistant" && message.summary === true) {
      support.add(row.id)
      return
    }
    if (row.time_created > boundary.time_created) {
      visible.add(row.id)
      return
    }
    if (row.time_created === boundary.time_created && row.id > boundary.id) {
      visible.add(row.id)
      return
    }
    if (message.role === "user" ? userContent.has(row.id) : assistantText.has(row.id)) visible.add(row.id)
  })
  return {
    rows: rows.filter((row) => visible.has(row.id) || support.has(row.id)),
    visible,
  }
}

export interface PageResult {
  items: WithParts[]
  more: boolean
  cursor?: string
  sparse?: boolean
}

function latestTuiUserMessage(sessionID: SessionID) {
  const rows = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.session_id, sessionID), sql`json_extract(${MessageTable.data}, '$.role') = 'user'`))
      .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
      .limit(25)
      .all(),
  )
  return hydrate(rows, { view: "tui", partsLimit: TUI_PARTS_PAGE_LIMIT }).find(
    (message) =>
      message.info.role === "user" &&
      message.parts.some(
        (part) => (part.type === "text" && !part.synthetic && part.text.trim().length > 0) || part.type === "file",
      ),
  )
}

function compactedPage(input: {
  sessionID: SessionID
  limit: number
  before?: Cursor
  after?: Cursor
  partsLimit?: number
}): PageResult | undefined {
  const boundary = compactedHistoryBoundary(input.sessionID)
  if (!boundary) return

  const chunkSize = Math.max(50, input.limit + 1)
  const selected: Array<{ row: typeof MessageTable.$inferSelect; visible: boolean }> = []
  const ascending = input.after !== undefined
  let position = input.before ?? input.after
  let exhausted = false
  let visibleCount = 0

  while (visibleCount <= input.limit && !exhausted) {
    const where = position
      ? and(eq(MessageTable.session_id, input.sessionID), ascending ? newer(position) : older(position))
      : eq(MessageTable.session_id, input.sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(where)
        .orderBy(
          ascending ? asc(MessageTable.time_created) : desc(MessageTable.time_created),
          ascending ? asc(MessageTable.id) : desc(MessageTable.id),
        )
        .limit(chunkSize)
        .all(),
    )
    if (rows.length === 0) {
      exhausted = true
      break
    }

    const pageRows = compactedHistoryPageRows(rows, boundary)
    pageRows.rows.forEach((row) => {
      const visible = pageRows.visible.has(row.id)
      if (visible) visibleCount++
      selected.push({ row, visible })
    })
    const tail = rows.at(-1)
    if (!tail || rows.length < chunkSize) {
      exhausted = true
      break
    }
    position = { id: tail.id, time: tail.time_created }
  }

  const more = visibleCount > input.limit || !exhausted
  let included = 0
  const cutoff = selected.findIndex((entry) => entry.visible && ++included > input.limit)
  const slice = cutoff === -1 ? selected : selected.slice(0, cutoff)
  const visibleIDs = new Set(slice.filter((entry) => entry.visible).map((entry) => entry.row.id))
  const pageSlice = slice.filter((entry) => {
    if (entry.visible) return true
    const message = info(entry.row)
    return (
      message.role === "assistant" &&
      message.summary === true &&
      message.parentID !== undefined &&
      visibleIDs.has(message.parentID)
    )
  })
  const simpleHistoryMessageIDs = new Set(
    pageSlice
      .filter(
        (entry) =>
          entry.row.time_created < boundary.time_created ||
          (entry.row.time_created === boundary.time_created && entry.row.id < boundary.id),
      )
      .map((entry) => entry.row.id),
  )
  const items = hydrate(
    pageSlice.map((entry) => entry.row),
    {
      view: "tui",
      partsLimit: input.partsLimit ?? TUI_PARTS_PAGE_LIMIT,
      partFilter: (row) =>
        !simpleHistoryMessageIDs.has(row.message_id) || row.data.type === "text" || row.data.type === "compaction",
    },
  )
  if (!ascending) items.reverse()
  const latestUser = !input.before && !input.after ? latestTuiUserMessage(input.sessionID) : undefined
  if (latestUser && !items.some((item) => item.info.id === latestUser.info.id)) {
    items.push(latestUser)
    items.sort((a, b) => a.info.id.localeCompare(b.info.id))
  }
  const tail = slice.findLast((entry) => entry.visible)?.row
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
    sparse: true,
  }
}

export function page(input: {
  sessionID: SessionID
  limit: number
  before?: string
  after?: string
  view?: PageView
  partsLimit?: number
}): PageResult {
  const before = input.before ? cursor.decode(input.before) : undefined
  const after = input.after ? cursor.decode(input.after) : undefined
  const partsLimit =
    input.view === "tui" || input.view === "tui-all" ? (input.partsLimit ?? TUI_PARTS_PAGE_LIMIT) : input.partsLimit
  if (input.view === "tui") {
    const compacted = compactedPage({ sessionID: input.sessionID, limit: input.limit, before, after, partsLimit })
    if (compacted) return compacted
  }
  const where = before
    ? and(eq(MessageTable.session_id, input.sessionID), older(before))
    : after
      ? and(eq(MessageTable.session_id, input.sessionID), newer(after))
      : eq(MessageTable.session_id, input.sessionID)
  const rows = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(where)
      .orderBy(
        after ? asc(MessageTable.time_created) : desc(MessageTable.time_created),
        after ? asc(MessageTable.id) : desc(MessageTable.id),
      )
      .limit(input.limit + 1)
      .all(),
  )
  if (rows.length === 0) {
    const row = Database.use((db) =>
      db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    return {
      items: [] as WithParts[],
      more: false,
    }
  }

  const more = rows.length > input.limit
  const slice = more ? rows.slice(0, input.limit) : rows
  const items = hydrate(slice, { view: input.view, partsLimit })
  if (!after) items.reverse()
  const tail = slice.at(-1)
  return {
    items,
    more,
    cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
  }
}

export function* stream(sessionID: SessionID, options: { view?: PageView } = {}) {
  const size = 50
  let before: string | undefined
  while (true) {
    const next = page({ sessionID, limit: size, before, view: options.view })
    if (next.items.length === 0) break
    for (let i = next.items.length - 1; i >= 0; i--) {
      yield next.items[i]
    }
    if (!next.more || !next.cursor) break
    before = next.cursor
  }
}

export function parts(message_id: MessageID) {
  const rows = Database.use((db) =>
    db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
  )
  return rows.map(
    (row) =>
      ({
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      }) as Part,
  )
}

export function get(input: {
  sessionID: SessionID
  messageID: MessageID
  view?: PageView
  partsLimit?: number
  partsAfter?: string
}): WithParts {
  const row = Database.use((db) =>
    db
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get(),
  )
  if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
  const partsLimit =
    input.view === "tui" || input.view === "tui-all" ? (input.partsLimit ?? TUI_PARTS_PAGE_LIMIT) : input.partsLimit
  return hydrate([row], {
    view: input.view,
    partsLimit,
    partsAfter: input.partsAfter,
  })[0]
}

type RevertTimelineRow = {
  id: MessageID
  time: number
  role: string
}

function revertTimeline(sessionID: SessionID) {
  return Database.use((db) =>
    db
      .select({
        id: MessageTable.id,
        time: MessageTable.time_created,
        role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
      })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      .all(),
  ) as RevertTimelineRow[]
}

export type RevertScan = {
  messageID: MessageID
  partID?: PartID
  patches: Snapshot.Patch[]
  range: Array<Pick<WithParts, "parts">>
}

/**
 * Loads only the message metadata and snapshot/patch parts needed by revert.
 * Full message payloads can contain large tool outputs and summaries, so the
 * normal transcript hydration path is intentionally not used here.
 */
export function revertScan(input: { sessionID: SessionID; messageID: MessageID; partID?: PartID }): RevertScan | undefined {
  const timeline = revertTimeline(input.sessionID)
  const partID = input.partID
  const targetMessageID = partID
    ? Database.use((db) =>
        db
          .select({ messageID: PartTable.message_id })
          .from(PartTable)
          .where(and(eq(PartTable.session_id, input.sessionID), eq(PartTable.id, partID)))
          .get(),
      )?.messageID
    : input.messageID
  if (!targetMessageID) return

  const targetIndex = timeline.findIndex((item) => item.id === targetMessageID)
  if (targetIndex < 0) return

  const lastUser = timeline.slice(0, targetIndex + 1).findLast((item) => item.role === "user")
  const hasPriorTextOrTool = partID
    ? Database.use((db) =>
        db
          .select({ type: sql<string>`json_extract(${PartTable.data}, '$.type')` })
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, input.sessionID),
              eq(PartTable.message_id, targetMessageID),
              lt(PartTable.id, partID),
            ),
          )
          .all()
          .some((item) => item.type === "text" || item.type === "tool"),
      )
    : false
  const messageID = !hasPriorTextOrTool && lastUser ? lastUser.id : targetMessageID
  const rangeIndex = timeline.findIndex((item) => item.id === messageID)
  if (rangeIndex < 0) return

  const sourceIDs = timeline.slice(rangeIndex).map((item) => item.id)
  const positions = new Map(timeline.map((item, index) => [item.id, index]))
  const rows =
    sourceIDs.length === 0
      ? []
      : Database.use((db) =>
          db
            .select()
            .from(PartTable)
            .where(
              and(
                eq(PartTable.session_id, input.sessionID),
                inArray(PartTable.message_id, sourceIDs),
                sql`json_extract(${PartTable.data}, '$.type') IN ('patch', 'step-start', 'step-finish')`,
              ),
            )
            .orderBy(PartTable.message_id, PartTable.id)
            .all(),
        )
  const patches: Snapshot.Patch[] = []
  const rangeParts = new Map<MessageID, Part[]>()
  for (const row of rows) {
    const hydrated = part(row)
    const position = positions.get(row.message_id)
    if (position === undefined) continue
    if (position >= targetIndex && hydrated.type === "patch") {
      patches.push({ hash: hydrated.hash, files: hydrated.files })
    }
    if (position >= rangeIndex && (hydrated.type === "step-start" || hydrated.type === "step-finish")) {
      const current = rangeParts.get(row.message_id)
      if (current) current.push(hydrated)
      else rangeParts.set(row.message_id, [hydrated])
    }
  }

  return {
    messageID,
    partID: hasPriorTextOrTool ? partID : undefined,
    patches,
    range: timeline.slice(rangeIndex).flatMap((item) => {
      const parts = rangeParts.get(item.id)
      return parts ? [{ parts }] : []
    }),
  }
}

export type RevertCleanup = {
  messageIDs: MessageID[]
  partIDs: PartID[]
}

/** Returns IDs for cleanup without hydrating message or tool payloads. */
export function revertCleanup(input: { sessionID: SessionID; messageID: MessageID; partID?: PartID }): RevertCleanup {
  const partID = input.partID
  const messages = Database.use((db) =>
    db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, input.sessionID))
      .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      .all(),
  )
  const messageIDs = messages
    .filter((item) => item.id > input.messageID || (!partID && item.id === input.messageID))
    .map((item) => item.id)
  const partIDs = partID
    ? Database.use((db) =>
        db
          .select({ id: PartTable.id })
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, input.sessionID),
              eq(PartTable.message_id, input.messageID),
              gte(PartTable.id, partID),
            ),
          )
          .orderBy(asc(PartTable.id))
          .all()
          .map((item) => item.id),
      )
    : []
  return { messageIDs, partIDs }
}

export function filterCompacted(msgs: Iterable<WithParts>) {
  const result = [] as WithParts[]
  const completed = new Set<string>()
  let retain: MessageID | undefined
  for (const msg of msgs) {
    result.push(msg)
    if (retain) {
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id)) {
      const part = msg.parts.find((item): item is CompactionPart => item.type === "compaction")
      if (!part) continue
      if (!part.tail_start_id) break
      retain = part.tail_start_id
      if (msg.info.id === retain) break
      continue
    }
    if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((part) => part.type === "compaction"))
      break
    if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
      completed.add(msg.info.parentID)
  }
  result.reverse()
  const compactionIndex = result.findLastIndex(
    (msg) =>
      msg.info.role === "user" &&
      msg.parts.some((item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined),
  )
  const compaction = result[compactionIndex]
  const part = compaction?.parts.find(
    (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
  )
  const summaryIndex = compaction
    ? result.findIndex(
        (msg, index) =>
          index > compactionIndex &&
          msg.info.role === "assistant" &&
          msg.info.summary &&
          msg.info.parentID === compaction.info.id,
      )
    : -1
  const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
  if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
    return [
      ...result.slice(compactionIndex, summaryIndex + 1),
      ...result.slice(tailIndex, compactionIndex),
      ...result.slice(summaryIndex + 1),
    ]
  }
  return result
}

export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
  return compactedHistory(sessionID)
})

export function fromError(
  e: unknown,
  ctx: { providerID: ProviderID; aborted?: boolean },
): NonNullable<Assistant["error"]> {
  const abortedMessage = ctx.aborted ? explicitAbortMessage(e) : undefined
  if (abortedMessage) {
    return new AbortedError(
      { message: abortedMessage },
      {
        cause: e,
      },
    ).toObject()
  }

  const embeddedDataUrlDownloadError = findEmbeddedDataUrlDownloadError(e)
  if (embeddedDataUrlDownloadError) {
    return new APIError(
      {
        message: `Embedded ${embeddedDataUrlDownloadError.mediaType} attachment could not be prepared for the provider. Re-attach the file or remove the attachment before retrying.`,
        isRetryable: false,
        metadata: {
          name: "AI_DownloadError",
          mediaType: embeddedDataUrlDownloadError.mediaType,
          urlScheme: "data",
        },
      },
      { cause: e },
    ).toObject()
  }

  const networkError = retryableNetworkError(e)
  if (networkError) {
    return new APIError(
      {
        message: networkError.message,
        isRetryable: true,
        metadata: networkError.metadata,
      },
      { cause: e },
    ).toObject()
  }

  switch (true) {
    case e instanceof DOMException && e.name === "AbortError":
      if (ctx.aborted) {
        return new AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      }
      return new APIError(
        {
          message: e.message || "Request aborted by transport",
          isRetryable: true,
          metadata: {
            name: e.name,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case OutputLengthError.isInstance(e):
      return e
    case LoadAPIKeyError.isInstance(e):
      return new AuthError(
        {
          providerID: ctx.providerID,
          message: e.message,
        },
        { cause: e },
      ).toObject()
    case (e as SystemError)?.code === "ECONNRESET":
      return new APIError(
        {
          message: "Connection reset by server",
          isRetryable: true,
          metadata: {
            code: (e as SystemError).code ?? "",
            syscall: (e as SystemError).syscall ?? "",
            message: (e as SystemError).message ?? "",
          },
        },
        { cause: e },
      ).toObject()
    case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
      return new APIError(
        {
          message: "Response decompression failed",
          isRetryable: true,
          metadata: {
            code: (e as FetchDecompressionError).code,
            message: e.message,
          },
        },
        { cause: e },
      ).toObject()
    case APICallError.isInstance(e):
      const parsed = ProviderError.parseAPICallError({
        providerID: ctx.providerID,
        error: e,
      })
      if (parsed.type === "context_overflow") {
        return new ContextOverflowError(
          {
            message: parsed.message,
            responseBody: parsed.responseBody,
          },
          { cause: e },
        ).toObject()
      }

      return new APIError(
        {
          message: parsed.message,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          responseHeaders: parsed.responseHeaders,
          responseBody: parsed.responseBody,
          metadata: parsed.metadata,
        },
        { cause: e },
      ).toObject()
    case e instanceof Error:
      return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
    default:
      try {
        const parsed = ProviderError.parseStreamError(e)
        if (parsed) {
          if (parsed.type === "context_overflow") {
            return new ContextOverflowError(
              {
                message: parsed.message,
                responseBody: parsed.responseBody,
              },
              { cause: e },
            ).toObject()
          }
          return new APIError(
            {
              message: parsed.message,
              isRetryable: parsed.isRetryable,
              responseBody: parsed.responseBody,
            },
            {
              cause: e,
            },
          ).toObject()
        }
      } catch {}
      return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
  }
}

function explicitAbortMessage(e: unknown): string | undefined {
  if (e instanceof DOMException && e.name === "AbortError") {
    return e.message || "Aborted"
  }

  if (typeof e !== "object" || e === null) return undefined

  const err = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
  if (err.code === "UND_ERR_REQUEST_ABORTED") {
    return typeof err.message === "string" && err.message ? err.message : "Aborted"
  }

  if (Array.isArray(err.errors)) {
    for (const nested of err.errors) {
      const match = explicitAbortMessage(nested)
      if (match) return match
    }
  }

  return explicitAbortMessage(err.cause)
}

function findEmbeddedDataUrlDownloadError(e: unknown): EmbeddedDataUrlDownloadError | undefined {
  if (typeof e !== "object" || e === null) return undefined

  const err = e as { name?: unknown; url?: unknown; cause?: unknown; errors?: unknown }
  const url = typeof err.url === "string" ? err.url : err.url instanceof URL ? err.url.toString() : undefined
  if (err.name === "AI_DownloadError" && url?.startsWith("data:")) {
    return { mediaType: dataUrlMediaType(url) ?? "file" }
  }

  if (Array.isArray(err.errors)) {
    for (const nested of err.errors) {
      const match = findEmbeddedDataUrlDownloadError(nested)
      if (match) return match
    }
  }

  return findEmbeddedDataUrlDownloadError(err.cause)
}

function retryableNetworkError(e: unknown): RetryableNetworkError | undefined {
  if (typeof e !== "object" || e === null) return undefined

  const err = e as SystemError & { cause?: unknown; errors?: unknown }
  const code = normalizedNetworkErrorCode(err.code)
  const syscall = typeof err.syscall === "string" ? err.syscall : undefined
  const message = errorMessage(e)
  const lower = message.toLowerCase()
  const cause: RetryableNetworkError | undefined = retryableNetworkError(err.cause)
  const nested: RetryableNetworkError | undefined = Array.isArray(err.errors)
    ? err.errors.map((item) => retryableNetworkError(item)).find((item): item is RetryableNetworkError => Boolean(item))
    : undefined

  if (nested) return nested

  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
    return {
      message: networkRetryMessage(code),
      metadata: {
        code,
        syscall: syscall ?? "",
        message,
      },
    }
  }

  if (
    lower.includes("fetch failed") ||
    lower.includes("cannot connect to api") ||
    lower.includes("unable to connect") ||
    lower.includes("network error") ||
    lower.includes("networkerror") ||
    lower.includes("network connection") ||
    lower.includes("network unavailable") ||
    lower.includes("network changed") ||
    lower.includes("offline") ||
    lower.includes("connection closed") ||
    lower.includes("connection reset") ||
    lower.includes("connection aborted") ||
    lower.includes("connection refused") ||
    lower.includes("connection terminated") ||
    lower.includes("connection timed out") ||
    lower.includes("headers timeout") ||
    lower.includes("body timeout") ||
    lower.includes("network is unreachable") ||
    lower.includes("host is unreachable") ||
    lower.includes("no route to host") ||
    lower.includes("socket hang up") ||
    lower.includes("premature close") ||
    lower.includes("operation was aborted") ||
    lower.includes("request aborted") ||
    lower.includes("stream aborted") ||
    lower.includes("read timed out") ||
    lower.includes("stream timed out") ||
    lower.includes("sse read timed out") ||
    lower.includes("failed to fetch")
  ) {
    return {
      message: cause?.message ?? "Network connection lost",
      metadata: {
        code: code ?? cause?.metadata.code ?? "",
        syscall: syscall ?? cause?.metadata.syscall ?? "",
        message,
      },
    }
  }

  return cause
}

export function isNetworkError(error: unknown) {
  if (!APIError.isInstance(error)) return false
  const metadata = error.data.metadata
  const code = normalizedNetworkErrorCode(metadata?.code)
  if (code) return true

  const message = error.data.message.toLowerCase()
  return [
    "fetch failed",
    "network",
    "connection",
    "cannot connect to api",
    "unable to connect",
    "socket",
    "timed out",
    "timeout",
    "unreachable",
    "no route to host",
    "offline",
    "disconnected",
    "request aborted",
    "operation was aborted",
    "stream aborted",
    "premature close",
    "terminated",
  ].some((marker) => message.includes(marker))
}

function networkRetryMessage(code: string) {
  if (code === "ECONNRESET" || code === "ENETRESET") return "Connection reset by server"
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ENETDOWN" ||
    code === "ENETUNREACH" ||
    code === "EHOSTDOWN" ||
    code === "EHOSTUNREACH"
  )
    return "Network unavailable"
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    code === "ERR_SOCKET_CONNECTION_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  )
    return "Network connection timed out"
  if (code === "ECONNREFUSED") return "Provider connection refused"
  return "Network connection lost"
}

export * as MessageV2 from "./message-v2"
