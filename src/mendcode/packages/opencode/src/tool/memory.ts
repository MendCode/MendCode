import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { DEFAULT_MEMORY_CATEGORIES, normalizeMemoryCategoryIDs } from "@/mend/memory/categories"
import { appendMemoryEntry, deleteMemoryEntry, memoryStatus, readMemoryEntries, updateMemoryEntry } from "@/mend/memory/store"
import { retrieveMemory } from "@/mend/memory/retrieve"
import type { MessageV2 } from "@/session/message-v2"
import type { MemoryScope } from "@/mend/memory/config"

type MemoryToolAction = "status" | "categories" | "list" | "search" | "context" | "add" | "update" | "delete"

const Action = Schema.Literals(["status", "categories", "list", "search", "context", "add", "update", "delete"])
const Scope = Schema.Literals(["global", "project"])
const Sensitivity = Schema.optional(Schema.Literals(["low", "medium", "high"]))

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description: "Memory action. Use add/update/delete only for durable user/project rules or explicit memory management.",
  }),
  scope: Schema.optional(Scope).annotate({
    description: "Memory scope. Use global for cross-project user/agent preferences; project for repo-specific facts.",
  }),
  id: Schema.optional(Schema.String).annotate({ description: "Memory entry id for update/delete." }),
  query: Schema.optional(Schema.String).annotate({ description: "Search or context query." }),
  text: Schema.optional(Schema.String).annotate({ description: "Memory text for add/update." }),
  tags: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: "Optional tags." }),
  categoryIDs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional memory category ids. Call categories to inspect valid ids.",
  }),
  evidence: Schema.optional(Schema.String).annotate({ description: "Short provenance, such as a user correction or session note." }),
  confidence: Schema.optional(Schema.Number).annotate({ description: "0-1 confidence. Default 0.8 for direct memory tool writes." }),
  sensitivity: Sensitivity.annotate({ description: "Sensitivity label. Use high for secrets or private personal data." }),
  maxEntries: Schema.optional(Schema.Number).annotate({ description: "Maximum entries for list/search/context." }),
})

type Metadata = {
  mendMemoryTool: {
    action: MemoryToolAction
    scope?: MemoryScope
    id?: string
    writes: boolean
  }
}

function latestPath(messages: MessageV2.WithParts[]) {
  for (const message of [...messages].reverse()) {
    if (message.info.role !== "assistant") continue
    return message.info.path
  }
  return { root: process.cwd(), cwd: process.cwd() }
}

function selectedScope(scope: unknown): MemoryScope {
  return scope === "global" ? "global" : "project"
}

function requireText(value: string | undefined, field: string) {
  const text = value?.trim()
  if (!text) throw new Error(`${field} is required`)
  return text
}

function formatEntries(entries: Awaited<ReturnType<typeof readMemoryEntries>>) {
  if (!entries.length) return "No memory entries found."
  return entries.map((entry) => [
    `${entry.id} [${entry.scope}] ${entry.categoryIDs.join(", ") || "uncategorized"}`,
    `  ${entry.text}`,
    entry.evidence ? `  evidence: ${entry.evidence}` : undefined,
  ].filter(Boolean).join("\n")).join("\n")
}

function formatStatus(status: Awaited<ReturnType<typeof memoryStatus>>) {
  return [
    `enabled: ${status.enabled}`,
    `input/use: ${status.use}`,
    `output/generate: ${status.generate}`,
    `global entries: ${status.entries.global?.count ?? 0}`,
    `project entries: ${status.entries.project?.count ?? 0}`,
    `pending proposals: ${status.proposals.pending}`,
    `categories: ${DEFAULT_MEMORY_CATEGORIES.length}`,
  ].join("\n")
}

function formatSaved(entry: Awaited<ReturnType<typeof appendMemoryEntry>>, verb: string) {
  return [
    `${verb}: ${entry.id}`,
    `scope: ${entry.scope}`,
    `categories: ${entry.categoryIDs.join(", ") || "uncategorized"}`,
    `text: ${entry.text}`,
  ].join("\n")
}

function updatePatch(params: Schema.Schema.Type<typeof Parameters>) {
  const patch: Parameters<typeof updateMemoryEntry>[2] = {}
  if (params.text !== undefined) patch.text = params.text
  if (params.tags !== undefined) patch.tags = [...params.tags]
  if (params.categoryIDs !== undefined) patch.categoryIDs = normalizeMemoryCategoryIDs(params.categoryIDs)
  if (params.evidence !== undefined) patch.evidence = params.evidence
  if (params.confidence !== undefined) patch.confidence = params.confidence
  if (params.sensitivity === "medium" || params.sensitivity === "high" || params.sensitivity === "low") {
    patch.sensitivity = params.sensitivity
  }
  return patch
}

export const MemoryTool = Tool.define<typeof Parameters, Metadata, never>(
  "memory",
  Effect.succeed({
    description: [
      "Inspect and update MendCode persistent memory with one compact tool.",
      "Use this instead of shell commands when the user gives a durable correction, preference, project rule, or asks to manage memory.",
      "Do not save transient task status, one-off debugging facts, secrets, raw logs, or facts you have not understood.",
      "Call search/list before update/delete unless the exact id was just returned by this tool.",
      "If you use this tool in a turn, MendCode skips the automatic memory extractor for that turn.",
    ].join("\n"),
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const location = latestPath(ctx.messages)
        const root = location.root
        const cwd = location.cwd
        const scope = selectedScope(params.scope)
        const writes = params.action === "add" || params.action === "update" || params.action === "delete"

        if (params.action === "status") {
          const status = yield* Effect.promise(() => memoryStatus(root))
          return {
            title: "Memory status",
            output: formatStatus(status),
            metadata: { mendMemoryTool: { action: params.action, writes } },
          }
        }

        if (params.action === "categories") {
          return {
            title: "Memory categories",
            output: DEFAULT_MEMORY_CATEGORIES.map((category) =>
              `- ${category.id} [default:${category.defaultScope}] ${category.description}`,
            ).join("\n"),
            metadata: { mendMemoryTool: { action: params.action, writes } },
          }
        }

        if (params.action === "list") {
          const entries = yield* Effect.promise(() => readMemoryEntries(scope, root))
          return {
            title: `${scope} memory`,
            output: formatEntries(entries.slice(0, params.maxEntries ?? 20)),
            metadata: { mendMemoryTool: { action: params.action, scope, writes } },
          }
        }

        if (params.action === "search" || params.action === "context") {
          const result = yield* Effect.promise(() => retrieveMemory({
            root,
            cwd,
            query: params.query ?? "",
            scopes: params.scope ? [scope] : undefined,
            maxEntries: params.maxEntries,
            mode: params.action === "context" ? "request" : "manual",
          }))
          return {
            title: params.action === "context" ? "Memory context" : "Memory search",
            output: result.lines?.length
              ? result.lines.join("\n")
              : formatEntries(result.entries.slice(0, params.maxEntries ?? 20)),
            metadata: { mendMemoryTool: { action: params.action, scope: params.scope ? scope : undefined, writes } },
          }
        }

        if (params.action === "add") {
          const text = requireText(params.text, "text")
          const entry = yield* Effect.promise(() => appendMemoryEntry({
            scope,
            text,
            tags: params.tags ? [...params.tags] : [],
            categoryIDs: params.categoryIDs ? normalizeMemoryCategoryIDs(params.categoryIDs) : undefined,
            cwd: scope === "project" ? cwd : undefined,
            source: "memory-tool",
            evidence: params.evidence ?? `session:${ctx.sessionID}:message:${ctx.messageID}`,
            confidence: params.confidence ?? 0.8,
            sensitivity: params.sensitivity === "medium" || params.sensitivity === "high" ? params.sensitivity : "low",
          }, root))
          return {
            title: `Saved ${scope} memory`,
            output: formatSaved(entry, "saved"),
            metadata: { mendMemoryTool: { action: params.action, scope, id: entry.id, writes } },
          }
        }

        if (params.action === "update") {
          const id = requireText(params.id, "id")
          const entry = yield* Effect.promise(() => updateMemoryEntry(scope, id, updatePatch(params), root))
          return {
            title: `Updated ${scope} memory`,
            output: formatSaved(entry, "updated"),
            metadata: { mendMemoryTool: { action: params.action, scope, id, writes } },
          }
        }

        const id = requireText(params.id, "id")
        const result = yield* Effect.promise(() => deleteMemoryEntry(scope, id, root))
        return {
          title: `Deleted ${scope} memory`,
          output: `deleted: ${result.id}\nscope: ${result.scope}`,
          metadata: { mendMemoryTool: { action: params.action, scope, id, writes } },
        }
      }),
  }),
)
