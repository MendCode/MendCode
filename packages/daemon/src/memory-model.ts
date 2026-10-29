import { MEMORY_CATEGORY_IDS, MemoryAssistantAction, MemoryModelInput, redactSecrets } from "@mendcode/protocol"
import type { MemoryAssistantSettings, MemoryCategoryId, MemoryDetails, MemoryEntry, MemoryId, MemoryModelInput as ModelInput, MemoryPolicyValue, MemoryScope } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { memoryGraph } from "./memory-graph"

/** What an approved policy/category/Dream draft may change; the daemon owns each effect (settings, schedule, Dream run). */
export type MemoryAssistantControl = {
  /** `undefined` resets the category to its built-in policy. */
  categoryPolicy(category: MemoryCategoryId, policy: MemoryPolicyValue | undefined): void
  settings(patch: MemoryAssistantSettings): void
  dreamAt(at: string): void
  /** One Dream pass whose proposals all wait in Pending. */
  dryRun(directory: string): { runId: number } | { error: string }
}

const CONTROL_KINDS = new Set(["propose-policy", "edit-category", "delete-category", "create-category", "dream-dry-run", "dream-service-start"])
const FIXED_CATEGORIES = "v2 keeps a fixed category list; change a category's policy with edit-category instead"

/** The first local time in free text as `HH:MM` (a window such as 18:00-23:00 gives its start). */
export function firstClockTime(text: string) {
  const match = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/.exec(text)
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : undefined
}

export function createMemoryModel(input: {
  store: Store
  profile(directory: string): string
  id(): MemoryId
  categories(): unknown
  /** `entry` is the memory as it was, for a deletion (the store no longer has it). */
  changed(memoryId: MemoryId, change: "added" | "updated" | "deleted" | "linked", entry?: MemoryEntry): void
  propose(entry: { scope: MemoryScope; directory: string; text: string; category: string }): { memoryId?: string; outcome: string }
  control?: MemoryAssistantControl
}) {
  const { store } = input
  const scopeOf = (scope?: string) => scope === "user" || scope === "global" ? "user" as const : "project" as const
  const entries = (directory: string) => store.memories.list({ directory, profile: input.profile(directory) })
  function target(directory: string, id: MemoryId | undefined) {
    const found = entries(directory).find((entry) => entry.memoryId === id && !entry.details?.action)
    if (!found) throw new Error("Unknown memory in this project/profile")
    return found
  }
  function details(args: ModelInput, current?: MemoryDetails): MemoryDetails {
    const patch = Object.fromEntries(["tags", "categoryIDs", "evidence", "confidence", "sensitivity"].flatMap((key) => {
      const value = args[key as keyof ModelInput]
      return value === undefined ? [] : [[key, value]]
    }))
    return JSON.parse(redactSecrets(JSON.stringify({ ...current, ...patch, ...(args.scope === "workspace" || args.scope === "group-view" ? { graphScope: args.scope } : {}) })).text) as MemoryDetails
  }
  function add(directory: string, args: ModelInput, pending = false, action?: MemoryAssistantAction) {
    if (!args.text?.trim()) throw new Error("text is required")
    const memoryId = args.id ?? input.id()
    if (store.memories.get(memoryId)) throw new Error("Memory id already exists")
    const scope = scopeOf(args.scope)
    store.memories.add({ memoryId, scope, ...(scope === "user" ? { profile: input.profile(directory) } : { directory }), text: redactSecrets(args.text).text, category: args.category ?? args.categoryIDs?.[0] ?? "", details: { confidence: .8, sensitivity: "low", ...details(args), ...(action ? { action, originDirectory: directory } : {}) }, source: "agent", status: pending ? "pending" : "saved" })
    input.changed(memoryId, "added")
    return store.memories.get(memoryId)!
  }
  function graph(directory: string) {
    const saved = entries(directory).filter((entry) => entry.status === "saved" && !entry.details?.action)
    return memoryGraph(saved, store.memories.links(saved.map((entry) => entry.memoryId)))
  }
  function request(directory: string, value: ModelInput): Record<string, unknown> {
    const args = MemoryModelInput.parse(value)
    const visible = entries(directory).filter((entry) => !entry.details?.action)
    const saved = visible.filter((entry) => entry.status === "saved")
    const scoped = args.scope ? saved.filter((entry) => entry.scope === scopeOf(args.scope)) : saved
    const limit = args.maxEntries ?? args.maxFacts ?? 20
    if (args.action === "status") {
      const settings = store.settings.get()
      return { enabled: settings.memoryEnabled !== false, use: settings.memoryUse === true, generate: settings.memoryGenerate === true, user: saved.filter((entry) => entry.scope === "user").length, project: saved.filter((entry) => entry.scope === "project").length, pending: visible.filter((entry) => entry.status === "pending").length }
    }
    if (args.action === "categories") return { categories: input.categories() }
    if (args.action === "list") return { memories: (args.scope ? scoped : saved.filter((entry) => entry.scope === "project")).slice(0, limit) }
    if (args.action === "search" || args.action === "context") {
      const query = args.query?.trim()
      const words = query?.toLowerCase().split(/[^\p{L}\p{N}_.@/-]+/u).filter(Boolean) ?? []
      const ranked = query ? store.memories.related({ text: query, directory, profile: input.profile(directory), limit: 100 }).map((hit) => hit.memory) : scoped
      const seen = new Set(ranked.map((entry) => entry.memoryId))
      const metadata = saved.filter((entry) => !seen.has(entry.memoryId) && words.some((word) => `${entry.details?.tags?.join(" ") ?? ""} ${entry.details?.categoryIDs?.join(" ") ?? ""}`.toLowerCase().includes(word)))
      const hits = [...ranked, ...metadata]
      return { memories: hits.filter((entry) => !entry.details?.action && (!args.scope || entry.scope === scopeOf(args.scope))).slice(0, limit) }
    }
    if (args.action === "overview" || args.action === "validate") {
      const report = graph(directory)
      const issues = report.links.filter((link) => !report.nodes.some((entry) => entry.memoryId === link.from) || !report.nodes.some((entry) => entry.memoryId === link.to))
      return { ...report, ...(args.action === "validate" ? { ok: issues.length === 0, issues } : {}) }
    }
    if (args.action === "propose") {
      if (!args.text) throw new Error("text is required")
      const proposed = input.propose({ scope: scopeOf(args.scope), directory, text: args.text, category: args.category ?? args.categoryIDs?.[0] ?? "" })
      if (proposed.memoryId) {
        store.memories.update(proposed.memoryId as MemoryId, { details: details(args) })
        input.changed(proposed.memoryId as MemoryId, "updated")
      }
      return proposed
    }
    if (args.action === "add" || args.action === "upsert_fact" && (!args.id || !store.memories.get(args.id))) {
      const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
      const existing = visible.find((entry) => entry.scope === scopeOf(args.scope) && entry.status === "saved" && normalize(entry.text) === normalize(redactSecrets(args.text ?? "").text))
      if (existing) return { memory: existing, written: false }
      return { memory: add(directory, args), written: true, change: "added" }
    }
    if (args.action === "update" || args.action === "upsert_fact") {
      const current = target(directory, args.id)
      if (args.text === current.text && (args.category === undefined || args.category === current.category) && (args.scope === undefined || scopeOf(args.scope) === current.scope) && JSON.stringify(details(args, current.details)) === JSON.stringify(current.details)) return { memory: current, written: false }
      if (args.action === "upsert_fact" && !args.text) throw new Error("text is required")
      if (args.action === "upsert_fact" && args.scope) {
        const scope = scopeOf(args.scope)
        const place = { scope, ...(scope === "user" ? { profile: input.profile(directory) } : { directory }) }
        if (current.pinned && store.memories.pinnedIn(place, current.memoryId) >= 20) throw new Error("The destination already has 20 pinned memories")
        store.memories.move(current.memoryId, place)
      }
      store.memories.update(current.memoryId, { ...(args.text ? { text: redactSecrets(args.text).text } : {}), ...(args.category !== undefined || args.categoryIDs !== undefined ? { category: args.category ?? args.categoryIDs?.[0] ?? "" } : {}), details: details(args, current.details) })
      input.changed(current.memoryId, "updated")
      return { memory: store.memories.get(current.memoryId), written: true, change: "updated" }
    }
    if (args.action === "delete") {
      const current = target(directory, args.id)
      store.memories.delete(current.memoryId)
      input.changed(current.memoryId, "deleted", current)
      return { deleted: current.memoryId, memory: current, change: "deleted" }
    }
    if (args.action === "link") {
      const from = target(directory, args.from)
      const to = target(directory, args.to)
      if (from.status !== "saved" || to.status !== "saved") throw new Error("Both memories must be saved")
      const link = store.memories.link({ from: from.memoryId, to: to.memoryId, kind: args.kind ?? "related" })
      if (!link) throw new Error("Link refused: different saved memories with fewer than 16 links required")
      input.changed(from.memoryId, "linked")
      return { link }
    }
    throw new Error("Unknown memory action")
  }
  function draft(directory: string, value: MemoryAssistantAction): MemoryId | undefined {
    const action = MemoryAssistantAction.parse(JSON.parse(redactSecrets(JSON.stringify(value)).text))
    if (action.kind === "explain-state") return undefined
    if (action.kind === "create-category") throw new Error(FIXED_CATEGORIES)
    if (action.targetID) target(directory, action.targetID)
    if (action.kind === "graph-link") {
      target(directory, action.fromFactID)
      target(directory, action.toFactID)
    }
    return add(directory, { action: "add", text: action.text, ...(action.scope ? { scope: action.scope } : {}), ...(action.categoryIDs ? { categoryIDs: action.categoryIDs } : {}) }, true, action).memoryId
  }
  /** Applies an approved policy/category/Dream draft. Everything is checked before anything changes; a draft that cannot be applied stays pending with the reason. */
  function control(directory: string, action: MemoryAssistantAction): Record<string, unknown> {
    const owner = input.control
    if (!owner) throw new Error("Control draft: apply this change in Policies, Extraction or Dream")
    const category = (id: string | undefined) => {
      const key = (id ?? "").trim().toLowerCase().replace(/^(?:project|user)\./, "")
      const found = MEMORY_CATEGORY_IDS.find((known) => known === key)
      if (!found) throw new Error(`Unknown category "${redactSecrets(id ?? "").text.slice(0, 40)}"; use one of ${MEMORY_CATEGORY_IDS.join(", ")}`)
      return found
    }
    if (action.kind === "create-category") throw new Error(FIXED_CATEGORIES)
    if (action.kind === "edit-category") {
      if (!action.policy) throw new Error("edit-category needs a policy (auto, review or never); category labels are fixed")
      const id = category(action.categoryID ?? action.categoryIDs?.[0])
      owner.categoryPolicy(id, action.policy)
      return { category: id, policy: action.policy }
    }
    if (action.kind === "delete-category") {
      const id = category(action.categoryID ?? action.categoryIDs?.[0])
      owner.categoryPolicy(id, undefined)
      return { category: id, policy: "default" }
    }
    if (action.kind === "propose-policy") {
      const settings = action.settings && Object.keys(action.settings).length ? action.settings : undefined
      if (!settings && !(action.categoryID && action.policy)) throw new Error("propose-policy needs categoryID with policy, or settings; edit the draft or reject it")
      const id = action.categoryID && action.policy ? category(action.categoryID) : undefined
      if (id && action.policy) owner.categoryPolicy(id, action.policy)
      if (settings) owner.settings(settings)
      return { ...(id ? { category: id, policy: action.policy } : {}), ...(settings ? { settings: Object.keys(settings) } : {}) }
    }
    if (action.kind === "dream-dry-run") {
      if (!directory) throw new Error("dream-dry-run needs a project")
      const started = owner.dryRun(directory)
      if ("error" in started) throw new Error(started.error.replace(/^\[DAEMON\]: /, ""))
      return { runId: started.runId, dryRun: true }
    }
    const at = action.dreamAt ?? firstClockTime(action.text)
    if (!at) throw new Error("dream-service-start needs dreamAt as HH:MM; edit the draft or reject it")
    owner.dreamAt(at)
    return { dreamAt: at }
  }
  function resolve(memory: MemoryEntry, accept: boolean) {
    const action = memory.details?.action
    if (!action || memory.status !== "pending") return undefined
    const directory = memory.details?.originDirectory ?? memory.directory ?? ""
    if (!accept) {
      store.memories.delete(memory.memoryId)
      input.changed(memory.memoryId, "deleted", memory)
      return { action: "rejected" }
    }
    const scope = scopeOf(action.scope)
    if (CONTROL_KINDS.has(action.kind)) {
      const effect = control(directory, action)
      store.memories.delete(memory.memoryId)
      input.changed(memory.memoryId, "deleted")
      return { action: "applied", ...effect }
    }
    const args = { text: action.text, scope, ...(action.categoryIDs ? { categoryIDs: action.categoryIDs } : {}), ...(action.targetID ? { id: action.targetID } : {}) }
    if (action.kind === "graph-link") request(directory, { action: "link", from: action.fromFactID, to: action.toFactID, kind: action.linkKind ?? "related" })
    else if (action.kind === "delete-memory") request(directory, { action: "delete", id: action.targetID })
    else if (action.kind === "move-memory") {
      const current = target(directory, action.targetID)
      const place = { scope: scopeOf(action.targetScope ?? action.scope), ...(scopeOf(action.targetScope ?? action.scope) === "user" ? { profile: memory.profile ?? input.profile(directory) } : { directory }) }
      if (current.pinned && store.memories.pinnedIn(place, current.memoryId) >= 20) throw new Error("The destination already has 20 pinned memories")
      store.memories.move(current.memoryId, place)
      if (action.categoryID) store.memories.update(current.memoryId, { category: action.categoryID })
      input.changed(current.memoryId, "updated")
    } else request(directory, { ...args, action: action.kind === "edit-memory" ? "update" : action.kind === "graph-upsert" ? "upsert_fact" : "add" })
    store.memories.delete(memory.memoryId)
    input.changed(memory.memoryId, "deleted")
    return { action: "applied" }
  }
  return { request, draft, resolve }
}
