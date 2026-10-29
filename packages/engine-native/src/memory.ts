import { MemoryModelInput } from "@mendcode/protocol"
import type { MemoryModelInput as ModelInput } from "@mendcode/protocol"
import { memoryCategoryId, type MemoryEntry, type MemoryId, type MemoryLink, type MemoryLinkKind, type MemoryGraphReport, type SessionId } from "@mendcode/protocol"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"
import { memoryNoticeMeta, memoryNoticeText, type MemoryNoticeAction } from "./memory-notice"

export const MEMORY_BLOCK_CHARS = 6_000

function escape(text: string) {
  return text.replaceAll("<", "‹").replaceAll(">", "›")
}

/** One entry as the block shows it. */
const memoryLine = (entry: MemoryEntry) => `- [${entry.scope}${entry.category ? `/${entry.category}` : ""}] ${escape(entry.text.replace(/\s+/g, " ").trim())}`

/**
 * Memories as a bounded `<mendcode_memory>` block for the system prompt, cut at `maxChars` whole entries. Empty when
 * there is nothing. By default: session entries first, then project, then user, newest first (the caller's order within
 * each). With `ordered` the caller's order is kept as given (relevance order) and `total` says how many were saved,
 * so the block can tell how many it left out.
 */
export function memoryBlock(entries: MemoryEntry[], maxChars = MEMORY_BLOCK_CHARS, options: { ordered?: boolean; total?: number } = {}) {
  const ordered = options.ordered ? entries : [...entries.filter((e) => e.scope === "session"), ...entries.filter((e) => e.scope === "project"), ...entries.filter((e) => e.scope === "user")]
  const lines: string[] = []
  let used = 0
  for (const entry of ordered) {
    const line = memoryLine(entry)
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ""
  const omitted = (options.total ?? ordered.length) - lines.length
  return [
    "<mendcode_memory>",
    "Facts and preferences the user saved for you. Follow them unless the user says otherwise now.",
    ...lines,
    ...(omitted > 0 ? [options.ordered ? `(${omitted} more saved memories not shown; search them with memory_graph)` : `(${omitted} older entries not shown)`] : []),
    "</mendcode_memory>",
  ].join("\n")
}

/** What relevance retrieval reads: the saved memories a session may see, and which of them match its prompt. */
export type MemoryRetrievalPort = {
  /** Saved memories visible to the session: its profile's user memories, its project's and its own session's. */
  visible(input: { directory: string; sessionId?: SessionId }): MemoryEntry[]
  /** Those matching any distinctive word of `prompt`, best first (`rank` is bm25: lower is better). */
  related(input: { directory: string; sessionId?: SessionId; prompt: string; limit: number }): Array<{ memory: MemoryEntry; rank: number }>
  links(memoryIds: MemoryId[]): MemoryLink[]
}

/** Categories that state standing rules: they get a small lift so they are not crowded out by recency alone. */
const STANDING_CATEGORIES = new Set(["preferences", "constraints", "security"])
const DAY_MS = 86_400_000
/** Entries of a session that were already in its prompt stay there unless clearly outranked, so the prompt prefix (and its cache) stays stable. */
const STICKY_BOOST = 0.6
const MAX_HITS = 50
const SESSIONS_REMEMBERED = 200

type Scored = { memory: MemoryEntry; score: number; relevant: boolean }

/**
 * Orders saved memories for one prompt. Pinned ones come first and are always in (up to 3× the budget in all). Then the
 * ones the prompt matches or that link to a match (or were shown earlier in the session), best score first, within
 * `maxChars`. Last, at most a quarter of the budget (1 500 characters) of unmatched memories by score, so standing rules and
 * fresh notes still surface. Score = full-text relevance + recency (30-day half-life) + links to matches
 * + a lift for standing categories and for the session's own memories − a penalty when another memory supersedes it.
 */
export function selectMemories(input: {
  entries: MemoryEntry[]
  hits: Array<{ memory: MemoryEntry; rank: number }>
  links: MemoryLink[]
  now: number
  previous?: ReadonlySet<string>
  maxChars?: number
}): MemoryEntry[] {
  const maxChars = input.maxChars ?? MEMORY_BLOCK_CHARS
  const position = new Map(input.hits.map((hit, index) => [hit.memory.memoryId as string, index]))
  const matched = new Set(position.keys())
  const neighbours = new Map<string, number>()
  const superseded = new Set<string>()
  for (const link of input.links) {
    if (link.kind === "supersedes") superseded.add(link.to)
    if (link.kind !== "related" && link.kind !== "supports") continue
    if (matched.has(link.from)) neighbours.set(link.to, (neighbours.get(link.to) ?? 0) + 1)
    if (matched.has(link.to)) neighbours.set(link.from, (neighbours.get(link.from) ?? 0) + 1)
  }
  const scored: Scored[] = input.entries
    .filter((memory) => memory.status === "saved")
    .map((memory) => {
      const id = memory.memoryId as string
      const place = position.get(id)
      const relevance = place === undefined ? 0 : 1 + 0.5 * (1 - place / Math.max(1, input.hits.length))
      const recency = 0.3 * 0.5 ** (Math.max(0, input.now - memory.updatedAt) / DAY_MS / 30)
      const linked = Math.min(0.4, 0.2 * (neighbours.get(id) ?? 0))
      const sticky = input.previous?.has(id) ? STICKY_BOOST : 0
      const standing = STANDING_CATEGORIES.has(memoryCategoryId(memory.category)) ? 0.2 : 0
      const own = memory.scope === "session" ? 0.1 : 0
      const penalty = superseded.has(id) ? 0.5 : 0
      return { memory, score: relevance + recency + linked + sticky + standing + own - penalty, relevant: relevance > 0 || linked > 0 || sticky > 0 }
    })
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
  const chosen: MemoryEntry[] = []
  let used = 0
  const take = (memory: MemoryEntry, limit: number) => {
    const size = memoryLine(memory).length + 1
    if (used + size > limit) return false
    chosen.push(memory)
    used += size
    return true
  }
  for (const item of scored.filter((entry) => entry.memory.pinned).sort((a, b) => b.memory.updatedAt - a.memory.updatedAt)) take(item.memory, maxChars * 3)
  for (const item of scored) if (!item.memory.pinned && item.relevant) take(item.memory, maxChars)
  const ambientEnd = Math.min(maxChars, used + Math.min(1_500, Math.floor(maxChars / 4)))
  for (const item of scored) if (!item.memory.pinned && !item.relevant) take(item.memory, ambientEnd)
  return chosen
}

/**
 * Relevance retrieval for the system prompt: `select` ranks a session's visible memories for its latest prompt (full-text
 * matches first) and remembers what it chose, so the next turn's prompt only changes when the ranking clearly does.
 */
export function createMemorySelector(port: MemoryRetrievalPort, options: { now?: () => number; maxChars?: number; settings?: (directory?: string) => { memoryEnabled?: boolean | undefined; memoryUse?: boolean | undefined; memoryMaxPromptTokens?: number | undefined; memoryMaxEntries?: number | undefined; memoryProjectMaxEntries?: number | undefined } } = {}) {
  const now = options.now ?? Date.now
  const shown = new Map<string, Set<string>>()
  const selector = {
    /** The `<mendcode_memory>` block for the prompt (empty when nothing is visible). Pinned entries may use up to 3× the budget, so the block's own cut is 3× too. */
    block(input: { directory: string; sessionId?: SessionId; prompt: string }): string {
      const { memories, total } = selector.select(input)
      const cap = options.settings?.(input.directory).memoryMaxPromptTokens ?? 10_000
      const block = memoryBlock(memories, Math.min((options.maxChars ?? MEMORY_BLOCK_CHARS) * 3, cap === undefined ? Infinity : Math.max(0, cap * 4 - 256)), { ordered: true, total })
      return cap !== undefined && block.length > cap * 4 ? "" : block
    },
    select(input: { directory: string; sessionId?: SessionId; prompt: string }): { memories: MemoryEntry[]; total: number } {
      const settings = options.settings?.(input.directory) ?? {}
      if (settings.memoryEnabled === false || (options.settings ? settings.memoryUse !== true : settings.memoryUse === false)) return { memories: [], total: 0 }
      let projectCount = 0
      const entries = port.visible({ directory: input.directory, ...(input.sessionId ? { sessionId: input.sessionId } : {}) }).filter((memory) => memory.scope !== "project" || ++projectCount <= (settings.memoryProjectMaxEntries ?? 3)).slice(0, settings.memoryMaxEntries ?? 50)
      if (entries.length === 0) return { memories: [], total: 0 }
      const hits = input.prompt.trim() ? port.related({ directory: input.directory, ...(input.sessionId ? { sessionId: input.sessionId } : {}), prompt: input.prompt, limit: MAX_HITS }) : []
      const ids = new Set(entries.map((entry) => entry.memoryId as string))
      const previous = input.sessionId ? shown.get(input.sessionId) : undefined
      const ranked = selectMemories({
        entries,
        hits: hits.filter((hit) => ids.has(hit.memory.memoryId)),
        links: entries.length > 1 ? port.links(entries.map((entry) => entry.memoryId)) : [],
        now: now(),
        ...(previous ? { previous } : {}),
        maxChars: Math.min(options.maxChars ?? MEMORY_BLOCK_CHARS, (settings.memoryMaxPromptTokens ?? 32_000) * 4),
      })
      // The block sits in the system prompt, ahead of the whole conversation: a different text re-reads every message after it
      // from scratch. Ranking decides which memories are in; the order stays the one they first appeared in, so a prompt that
      // only reshuffles scores leaves the text, and the provider's cached prefix, as it was. New memories join at the end.
      const memories = previous ? [...[...previous].flatMap((id) => ranked.filter((memory) => memory.memoryId === id)), ...ranked.filter((memory) => !previous.has(memory.memoryId as string))] : ranked
      if (input.sessionId) {
        // Least recently used sessions are forgotten; a forgotten session simply ranks from scratch.
        shown.delete(input.sessionId)
        shown.set(input.sessionId, new Set(memories.map((memory) => memory.memoryId as string)))
        if (shown.size > SESSIONS_REMEMBERED) shown.delete(shown.keys().next().value!)
      }
      return { memories, total: entries.length }
    },
  }
  return selector
}

/** What the daemon did with a proposal: `pending` waits in /memory, `saved` went straight in (its category policy is auto), `dropped` was not kept (policy never). */
export type ProposeResult = string | { memoryId?: string; outcome: "pending" | "saved" | "dropped" }

/**
 * `remember`: the agent proposes a durable fact. What happens next follows the category's policy (Memory Center):
 * by default it is stored as pending and only reaches future turns after the user approves it in /memory.
 */
export function createRememberTool(propose: (entry: { scope: "user" | "project"; directory?: string; text: string; category: string }) => ProposeResult, port?: MemoryModelPort) {
  return defineTool({
    name: "remember",
    description:
      "Save a durable fact for later: what the user asked you to remember, a standing preference they stated (always, from now on, I prefer), a correction for later work, or a project fact the repo lacks. Never save this request's content or format, task status, or one-conversation details. When unsure, don't.",
    permission: "write",
    args: z.object({
      text: z.string().min(1).max(2_000).describe("The fact, stated on its own, specific and verbatim where it matters"),
      scope: z.enum(["project", "user"]).describe("project: this repository only; user: all projects"),
      category: z.string().max(64).optional().describe("Short label, e.g. commands, conventions, preferences, architecture, stack, security"),
    }),
    async execute(args, context) {
      if (port) return memoryResult(port.request(context.cwd, { ...args, action: "add" }), "remember")
      const result = propose({ scope: args.scope, directory: context.cwd, text: args.text, category: args.category ?? "" })
      const outcome = typeof result === "string" ? "pending" : result.outcome
      const output = outcome === "saved" ? "Saved: this category is set to save automatically." : outcome === "dropped" ? "Not kept: the user's policy for this category drops proposals." : "Proposed; the user will review it in /memory."
      return { output, truncated: false, title: `remember: ${args.text.slice(0, 60)}`, isError: false }
    },
  })
}

export type MemoryModelPort = { request(directory: string, input: ModelInput): Record<string, unknown> }

function memoryResult(result: Record<string, unknown>, title: string) {
  const memory = result.memory as MemoryEntry | undefined
  const change = result.change as "added" | "updated" | "deleted" | undefined
  const action: MemoryNoticeAction = change === "deleted" ? "removed" : change === "updated" ? "updated" : "saved"
  const noticed = memory !== undefined && (change === "deleted" || result.written === true && memory.status === "saved")
  const notice = noticed ? { action, memoryId: memory.memoryId, scope: memory.scope, text: memory.text } : undefined
  return { output: JSON.stringify(result, null, 2), title, truncated: false, isError: false, meta: { memorySaved: noticed, memoryWrites: result.written === true, ...(notice ? { ...memoryNoticeMeta(notice), memorySavedText: memoryNoticeText(notice) } : {}) } }
}

export function createMemoryTool(port: MemoryModelPort) {
  return defineTool({
    name: "memory",
    description: "Inspect and manage persistent memory: status, categories, list, search, context, add, update, delete, propose. Save only durable facts and standing preferences (remember, always, from now on), corrections for later work or project facts the repo lacks; never secrets, this request's content or format, or task status; when unsure, don't. Search/list before updating or deleting an id. global is user scope; workspace/group-view use this project. Writes require approval; propose follows the category policy.",
    permission: "write",
    permissionFor: (args) => ["add", "update", "delete", "propose"].includes(args.action) ? "write" : "read",
    args: MemoryModelInput.extend({ action: z.enum(["status", "categories", "list", "search", "context", "add", "update", "delete", "propose"]) }),
    async execute(args, context) {
      try {
        const result = port.request(context.cwd, args.action === "propose" ? { ...args, action: "add" } : args)
        return memoryResult(result, `memory ${args.action}`)
      } catch (error) {
        return { output: error instanceof Error ? error.message : String(error), title: `memory ${args.action}`, truncated: false, isError: true }
      }
    },
  })
}

export type MemoryGraphPort = {
  request?(directory: string, input: ModelInput): Record<string, unknown>
  graph(directory: string): MemoryGraphReport
  link(input: { from: MemoryId; to: MemoryId; kind: MemoryLinkKind }): MemoryLink | undefined
}

const GRAPH_LIST = 12

function nodeLine(node: MemoryEntry, degree: number) {
  return `- ${node.memoryId} [${node.scope}${node.category ? `/${node.category}` : ""}] ${escape(node.text.replace(/\s+/g, " ").trim()).slice(0, 160)}${degree ? ` (${degree} links)` : ""}`
}

/**
 * `memory_graph`: the saved memories as a graph. overview = health and the most linked memories; search = matching
 * memories with their links; link = connect two saved memories; upsert_fact = create/update a fact; validate = check graph integrity.
 */
export function createMemoryGraphTool(port: MemoryGraphPort) {
  return defineTool({
    name: "memory_graph",
    description:
      "Saved memories as a graph of links (related, supports, conflicts, supersedes). upsert_fact creates or updates a durable fact, validate checks integrity. overview: health and the most linked memories. search: memories matching a query and what they link to. link: connect two saved memories by id, e.g. mark that one supersedes or conflicts with another.",
    permission: "write",
    permissionFor: (args) => ["upsert_fact", "link"].includes(args.action) ? "write" : "read",
    args: MemoryModelInput.extend({
      action: z.enum(["overview", "search", "link", "upsert_fact", "validate"]),
      query: z.string().max(200).optional().describe("search: words to find"),
      from: z.string().optional().describe("link: memory id"),
      to: z.string().optional().describe("link: memory id"),
      kind: z.enum(["related", "supports", "conflicts", "supersedes"]).optional().describe("link: how from relates to to"),
    }),
    async execute(args, context) {
      if (args.action === "upsert_fact" || args.action === "validate" || args.action === "link" && port.request) {
        try {
          if (!port.request) throw new Error("Memory model API unavailable")
          const result = port.request(context.cwd, MemoryModelInput.parse(args))
          const link = result.link as MemoryLink | undefined
          const output = memoryResult(result, `memory_graph ${args.action}`)
          return { ...output, ...(link ? { output: `linked ${link.from} ${link.kind} ${link.to}` } : {}), meta: { ...output.meta, graphSnapshot: JSON.stringify(result), memoryAction: args.action } }
        } catch (error) { return { output: error instanceof Error ? error.message : String(error), title: `memory_graph ${args.action}`, truncated: false, isError: true } }
      }
      const report = port.graph(context.cwd)
      const degree = new Map<string, number>()
      for (const link of report.links) for (const id of [link.from, link.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
      const edges = (id: string) =>
        report.links
          .filter((link) => link.from === id || link.to === id)
          .map((link) => (link.from === id ? `  ${link.kind} → ${link.to}` : `  ${link.kind} ← ${link.from}`))
      if (args.action === "link") {
        if (!args.from || !args.to || !args.kind) return { output: "link needs from, to and kind", truncated: false, title: "memory_graph link", isError: true }
        const link = port.link({ from: args.from as MemoryId, to: args.to as MemoryId, kind: args.kind })
        if (!link) return { output: "not linked: both must be saved memories, different, each with fewer than 16 links", truncated: false, title: "memory_graph link", isError: true }
        return { output: `linked ${link.from} ${link.kind} ${link.to}`, truncated: false, title: `memory link · ${link.kind}`, isError: false }
      }
      if (args.action === "search") {
        const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
        const score = (node: MemoryEntry) => words.reduce((sum, word) => sum + (`${node.text} ${node.category} ${node.details?.categoryIDs?.join(" ") ?? ""}`.toLowerCase().includes(word) ? 1 : 0), 0)
        const hits = report.nodes.filter((node) => !words.length || score(node) > 0).sort((a, b) => score(b) - score(a) || b.updatedAt - a.updatedAt).slice(0, args.maxFacts ?? GRAPH_LIST)
        const output = hits.length ? hits.flatMap((node) => [nodeLine(node, degree.get(node.memoryId) ?? 0), ...edges(node.memoryId)]).join("\n") : "no saved memory matches"
        return { output, truncated: false, title: `memory search: ${args.query}`, isError: false }
      }
      const { health } = report
      const top = report.nodes.slice(0, args.maxFacts ?? GRAPH_LIST)
      const output = [
        `graph ${health.state} · ${health.nodes} memories · ${health.links} links · ${health.isolated} isolated · ${health.conflicts} conflicts`,
        ...top.map((node) => nodeLine(node, degree.get(node.memoryId) ?? 0)),
        ...(report.nodes.length > top.length ? [`(${report.nodes.length - top.length} more; search to find them)`] : []),
      ].join("\n")
      return { output, truncated: false, title: "memory graph", isError: false, meta: { nodes: health.nodes, links: health.links } }
    },
  })
}
