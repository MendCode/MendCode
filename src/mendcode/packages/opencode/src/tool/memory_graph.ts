import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { DEFAULT_MEMORY_CATEGORIES, normalizeMemoryCategoryIDs } from "@/mend/memory/categories"
import {
  readMemoryFacts,
  readMemoryGraph,
  upsertMemoryFact,
  upsertMemoryFactLink,
  validateMemoryGraph,
} from "@/mend/memory/graph"
import type { MessageV2 } from "@/session/message-v2"
import type { MemoryFactScope } from "@/mend/memory/categories"

type MemoryGraphAction = "overview" | "search" | "upsert_fact" | "link" | "validate"
type MemoryGraphLinkKind = "related" | "conflicts" | "supersedes" | "supports"

const Action = Schema.Literals(["overview", "search", "upsert_fact", "link", "validate"])
const Scope = Schema.Literals(["global", "project", "workspace", "group-view"])
const LinkKind = Schema.Literals(["related", "conflicts", "supersedes", "supports"])

export const Parameters = Schema.Struct({
  action: Action.annotate({ description: "Graph memory action." }),
  query: Schema.optional(Schema.String).annotate({ description: "Search query for facts." }),
  id: Schema.optional(Schema.String).annotate({ description: "Fact id for upsert_fact." }),
  text: Schema.optional(Schema.String).annotate({ description: "Fact text for upsert_fact." }),
  scope: Schema.optional(Scope).annotate({ description: "Fact scope. Prefer project unless the fact is cross-project user policy." }),
  categoryIDs: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: "Optional category ids." }),
  from: Schema.optional(Schema.String).annotate({ description: "Source fact id for link." }),
  to: Schema.optional(Schema.String).annotate({ description: "Target fact id for link." }),
  kind: Schema.optional(LinkKind).annotate({ description: "Link kind." }),
  maxFacts: Schema.optional(Schema.Number).annotate({ description: "Maximum facts to return." }),
  confidence: Schema.optional(Schema.Number).annotate({ description: "0-1 confidence for upsert_fact." }),
})

type Metadata = {
  mendMemoryTool: {
    action: MemoryGraphAction
    graph: true
    writes: boolean
    id?: string
  }
}

function latestPath(messages: MessageV2.WithParts[]) {
  for (const message of [...messages].reverse()) {
    if (message.info.role !== "assistant") continue
    return message.info.path
  }
  return { root: process.cwd(), cwd: process.cwd() }
}

function requireText(value: string | undefined, field: string) {
  const text = value?.trim()
  if (!text) throw new Error(`${field} is required`)
  return text
}

function score(text: string, terms: string[]) {
  const lower = text.toLowerCase()
  return terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0)
}

function formatGraphOverview(input: {
  facts: number
  graphFacts: number
  legacyFacts: number
  links: number
  categories: Array<{ id: string; count: number }>
}) {
  const active = input.categories.filter((category) => category.count > 0).slice(0, 8)
  return [
    `facts: ${input.facts}`,
    `graph facts: ${input.graphFacts}`,
    `legacy facts: ${input.legacyFacts}`,
    `links: ${input.links}`,
    active.length ? `active categories: ${active.map((item) => `${item.id}:${item.count}`).join(", ")}` : "active categories: none",
  ].join("\n")
}

function formatFact(fact: Awaited<ReturnType<typeof upsertMemoryFact>>) {
  return [
    `fact: ${fact.id}`,
    `scope: ${fact.scope}`,
    `categories: ${fact.categoryIDs.join(", ") || "uncategorized"}`,
    `text: ${fact.text}`,
  ].join("\n")
}

export const MemoryGraphTool = Tool.define<typeof Parameters, Metadata, never>(
  "memory_graph",
  Effect.succeed({
    description: [
      "Inspect and update MendCode graph memory facts and relationships.",
      "Use this for relationship-aware context: conflicts, supersedes, supports, related facts, category distribution, and graph validation.",
      "Keep writes sparse: only store durable facts or links that will help future sessions reason across memories.",
      "If you use this tool in a turn, MendCode skips the automatic memory extractor for that turn.",
    ].join("\n"),
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const { root } = latestPath(ctx.messages)
        const writes = params.action === "upsert_fact" || params.action === "link"

        if (params.action === "overview") {
          const [graph, facts] = yield* Effect.promise(() => Promise.all([readMemoryGraph(root), readMemoryFacts(root)]))
          const byCategory = new Map<string, number>()
          for (const fact of facts) {
            for (const categoryID of fact.categoryIDs.length ? fact.categoryIDs : ["uncategorized"]) {
              byCategory.set(categoryID, (byCategory.get(categoryID) ?? 0) + 1)
            }
          }
          const overview = {
            facts: facts.length,
            graphFacts: graph.facts.length,
            legacyFacts: facts.length - graph.facts.length,
            links: graph.links.length,
            categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({
              id: category.id,
              count: byCategory.get(category.id) ?? 0,
            })),
          }
          return {
            title: "Memory graph overview",
            output: formatGraphOverview(overview),
            metadata: { mendMemoryTool: { action: params.action, graph: true, writes } },
          }
        }

        if (params.action === "validate") {
          const result = yield* Effect.promise(() => validateMemoryGraph(root))
          return {
            title: result.ok ? "Memory graph valid" : "Memory graph issues",
            output: result.ok
              ? "ok: true\nissues: 0"
              : [`ok: false`, `issues: ${result.issues.length}`, ...result.issues.slice(0, 8).map((issue) => `- ${issue.code}: ${issue.message}`)].join("\n"),
            metadata: { mendMemoryTool: { action: params.action, graph: true, writes } },
          }
        }

        if (params.action === "search") {
          const queryTerms = (params.query ?? "").toLowerCase().split(/[^a-z0-9_.@/-]+/).filter((item) => item.length > 1)
          const facts = yield* Effect.promise(() => readMemoryFacts(root))
          const matches = facts
            .map((fact) => ({ fact, score: score(`${fact.text} ${fact.normalizedSummary} ${fact.categoryIDs.join(" ")}`, queryTerms) }))
            .filter((item) => !queryTerms.length || item.score > 0)
            .sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt))
            .slice(0, params.maxFacts ?? 12)
          return {
            title: "Memory graph search",
            output: matches.length
              ? matches.map(({ fact }) => `- ${fact.id} [${fact.scope}] ${fact.categoryIDs.join(", ")}\n  ${fact.text}`).join("\n")
              : "No graph memory facts found.",
            metadata: { mendMemoryTool: { action: params.action, graph: true, writes } },
          }
        }

        if (params.action === "upsert_fact") {
          const text = requireText(params.text, "text")
          const fact = yield* Effect.promise(() => upsertMemoryFact({
            id: params.id,
            text,
            scope: (params.scope ?? "project") as MemoryFactScope,
            categoryIDs: params.categoryIDs ? normalizeMemoryCategoryIDs(params.categoryIDs) : undefined,
            provenance: [`session:${ctx.sessionID}:message:${ctx.messageID}`],
            confidence: params.confidence ?? 0.8,
          }, root))
          return {
            title: "Saved graph memory fact",
            output: formatFact(fact),
            metadata: { mendMemoryTool: { action: params.action, graph: true, writes, id: fact.id } },
          }
        }

        const from = requireText(params.from, "from")
        const to = requireText(params.to, "to")
        const facts = yield* Effect.promise(() => readMemoryFacts(root))
        const factIDs = new Set(facts.map((fact) => fact.id))
        const missing = [from, to].filter((id) => !factIDs.has(id))
        if (missing.length) throw new Error(`Unknown memory graph fact id: ${missing.join(", ")}`)
        const link = yield* Effect.promise(() => upsertMemoryFactLink({
          from,
          to,
          kind: (params.kind ?? "related") as MemoryGraphLinkKind,
        }, root))
        return {
          title: "Saved graph memory link",
          output: `link: ${link.id}\n${link.from} --${link.kind}--> ${link.to}`,
          metadata: { mendMemoryTool: { action: params.action, graph: true, writes, id: link.id } },
        }
      }),
  }),
)
