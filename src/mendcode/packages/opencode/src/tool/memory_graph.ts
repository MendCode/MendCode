import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { DEFAULT_MEMORY_CATEGORIES, normalizeMemoryCategoryIDs } from "@/mend/memory/categories"
import {
  computeMemoryGraphHealth,
  readMemoryFacts,
  readMemoryGraph,
  upsertMemoryFact,
  upsertMemoryFactLink,
  validateMemoryGraph,
  type MemoryFact,
  type MemoryFactLink,
  type MemoryGraphHealth,
} from "@/mend/memory/graph"
import type { MessageV2 } from "@/session/message-v2"
import type { MemoryFactScope } from "@/mend/memory/categories"

type MemoryGraphAction = "overview" | "search" | "upsert_fact" | "link" | "validate"
type MemoryGraphLinkKind = "related" | "conflicts" | "supersedes" | "supports"

const DEFAULT_SCOPE = "project" satisfies MemoryFactScope
const DEFAULT_LINK_KIND = "related" satisfies MemoryGraphLinkKind

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
  graphSnapshot?: MemoryGraphSnapshot
}

type MemoryGraphSnapshot = {
  action: MemoryGraphAction
  query?: string
  health: MemoryGraphHealth
  facts: Array<Pick<MemoryFact, "id" | "text" | "scope" | "categoryIDs" | "retrievalPriority"> & { materialized: boolean }>
  links: Array<Pick<MemoryFactLink, "from" | "to" | "kind">>
  categories: Array<{ id: string; label: string; count: number }>
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
  health: MemoryGraphHealth
  categories: Array<{ id: string; count: number }>
}) {
  const active = input.categories.filter((category) => category.count > 0).slice(0, 8)
  return [
    `graph health: ${input.health.graphHealth}`,
    `facts: ${input.facts}`,
    `materialized facts: ${input.health.materializedFacts}`,
    `legacy facts: ${input.health.legacyFacts}`,
    `links: ${input.health.links}`,
    `connected facts: ${input.health.connectedFacts}`,
    `isolated facts: ${input.health.isolatedFacts}`,
    `orphan links: ${input.health.orphanLinks}`,
    active.length ? `active categories: ${active.map((item) => `${item.id}:${item.count}`).join(", ")}` : "active categories: none",
  ].join("\n")
}

function formatGraphHealth(health: MemoryGraphHealth) {
  return [
    `graph health: ${health.graphHealth}`,
    `materialized facts: ${health.materializedFacts}`,
    `legacy facts: ${health.legacyFacts}`,
    `links: ${health.links}`,
    `connected facts: ${health.connectedFacts}`,
    `isolated facts: ${health.isolatedFacts}`,
    `orphan links: ${health.orphanLinks}`,
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

function categoryCounts(facts: MemoryFact[]) {
  const counts = new Map<string, number>()
  for (const fact of facts) {
    for (const categoryID of fact.categoryIDs.length ? fact.categoryIDs : ["uncategorized"]) {
      counts.set(categoryID, (counts.get(categoryID) ?? 0) + 1)
    }
  }
  return counts
}

function graphSnapshot(input: {
  action: MemoryGraphAction
  query?: string
  facts: MemoryFact[]
  links: MemoryFactLink[]
  health: MemoryGraphHealth
}): MemoryGraphSnapshot {
  const visibleFacts = input.facts.slice(0, 64)
  const visibleFactIDs = new Set(visibleFacts.map((fact) => fact.id))
  const counts = categoryCounts(visibleFacts)
  return {
    action: input.action,
    query: input.query,
    health: input.health,
    facts: visibleFacts.map((fact) => ({
      id: fact.id,
      text: fact.text,
      scope: fact.scope,
      categoryIDs: fact.categoryIDs,
      retrievalPriority: fact.retrievalPriority,
      materialized: true,
    })),
    links: input.links
      .filter((link) => visibleFactIDs.has(link.from) && visibleFactIDs.has(link.to))
      .slice(0, 96)
      .map((link) => ({ from: link.from, to: link.to, kind: link.kind })),
    categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({
      id: category.id,
      label: category.label,
      count: counts.get(category.id) ?? 0,
    })),
  }
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
          const byCategory = categoryCounts(facts)
          const overview = {
            facts: facts.length,
            health: computeMemoryGraphHealth({ graph, facts }),
            categories: DEFAULT_MEMORY_CATEGORIES.map((category) => ({
              id: category.id,
              count: byCategory.get(category.id) ?? 0,
            })),
          }
          return {
            title: "Memory graph overview",
            output: formatGraphOverview(overview),
            metadata: {
              mendMemoryTool: { action: params.action, graph: true, writes },
              graphSnapshot: graphSnapshot({ action: params.action, facts, links: graph.links, health: overview.health }),
            },
          }
        }

        if (params.action === "validate") {
          const [result, graph, facts] = yield* Effect.promise(() => Promise.all([validateMemoryGraph(root), readMemoryGraph(root), readMemoryFacts(root)]))
          return {
            title: result.ok && result.health.graphHealth === "connected" ? "Memory graph valid" : result.ok ? `Memory graph valid but ${result.health.graphHealth}` : "Memory graph issues",
            output: result.ok
              ? [`ok: true`, `issues: 0`, formatGraphHealth(result.health)].join("\n")
              : [`ok: false`, `issues: ${result.issues.length}`, formatGraphHealth(result.health), ...result.issues.slice(0, 8).map((issue) => `- ${issue.code}: ${issue.message}`)].join("\n"),
            metadata: {
              mendMemoryTool: { action: params.action, graph: true, writes },
              graphSnapshot: graphSnapshot({ action: params.action, facts, links: graph.links, health: result.health }),
            },
          }
        }

        if (params.action === "search") {
          const queryTerms = (params.query ?? "").toLowerCase().split(/[^a-z0-9_.@/-]+/).filter((item) => item.length > 1)
          const [graph, facts] = yield* Effect.promise(() => Promise.all([readMemoryGraph(root), readMemoryFacts(root)]))
          const matches = facts
            .map((fact) => ({ fact, score: score(`${fact.text} ${fact.normalizedSummary} ${fact.categoryIDs.join(" ")}`, queryTerms) }))
            .filter((item) => !queryTerms.length || item.score > 0)
            .sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt))
            .slice(0, params.maxFacts ?? 12)
          const matchFacts = matches.map(({ fact }) => fact)
          return {
            title: "Memory graph search",
            output: matches.length
              ? matches.map(({ fact }) => `- ${fact.id} [${fact.scope}] ${fact.categoryIDs.join(", ")}\n  ${fact.text}`).join("\n")
              : "No graph memory facts found.",
            metadata: {
              mendMemoryTool: { action: params.action, graph: true, writes },
              graphSnapshot: graphSnapshot({
                action: params.action,
                query: params.query,
                facts: matchFacts,
                links: graph.links,
                health: computeMemoryGraphHealth({ graph, facts }),
              }),
            },
          }
        }

        if (params.action === "upsert_fact") {
          const text = requireText(params.text, "text")
          const fact = yield* Effect.promise(() => upsertMemoryFact({
            id: params.id,
            text,
            scope: params.scope ?? DEFAULT_SCOPE,
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
          kind: params.kind ?? DEFAULT_LINK_KIND,
        }, root))
        return {
          title: "Saved graph memory link",
          output: `link: ${link.id}\n${link.from} --${link.kind}--> ${link.to}`,
          metadata: { mendMemoryTool: { action: params.action, graph: true, writes, id: link.id } },
        }
      }),
  }),
)
