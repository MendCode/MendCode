import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { MemoryConfigPatch, redactSecrets, type ExtractionJob, type MemoryControlInput, type MemoryEntry, type MemoryId } from "@mendcode/protocol"
import { createMemorySelector } from "@mendcode/engine-native"
import type { Store } from "@mendcode/store"
import type { ExtractedMemory } from "./memory-extraction"
import { memorySettings } from "./memory-config"

const fingerprint = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()

async function readText(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 256_000) throw new Error("Memory input must be a regular file of at most 256 KB")
    return redactSecrets((await handle.readFile("utf8")).trim()).text
  } finally { await handle.close() }
}

async function codexCandidates(root: string, limit: number) {
  const candidates: Array<{ file: string; text: string }> = []
  let visited = 0
  async function walk(directory: string, depth: number) {
    if (depth > 16 || visited >= 2_000 || candidates.length >= limit) return
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 2_000 || candidates.length >= limit) break
      const file = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name !== "rollout_summaries") await walk(file, depth + 1)
      else if (entry.isFile() && /\.(md|txt|json|jsonl)$/i.test(entry.name)) {
        const text = await readText(file).catch(() => "")
        if (text) candidates.push({ file: path.relative(root, file), text: text.slice(0, 12_000) })
      }
    }
  }
  const info = await lstat(root).catch(() => undefined)
  if (!info) return { exists: false, candidates }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Codex input must be a directory, not a symlink")
  await walk(root, 0)
  return { exists: true, candidates }
}

/** The header of a MendCode v1 sharing snapshot (`<!-- mendcode-memory {...} -->`, then a blank line, then the memory's text). */
const V1_HEADER = /^<!-- mendcode-memory (\{.*\}) -->$/
const V1_MAX_BYTES = 32_768

/**
 * The memories of a v1 sharing folder (`memory.sharing` export: one `<id>.md` per memory). Each file is one memory already, so no
 * model reads them. Links, other kinds of file, oversized files, files without a valid v1 header and text with detected
 * credentials are skipped with a reason. Nothing in the folder is written.
 */
async function v1Candidates(root: string, limit: number) {
  const candidates: Array<{ file: string; id: string; scope: "user" | "project"; text: string }> = []
  const skipped: Array<{ file: string; reason: string }> = []
  const info = await lstat(root).catch(() => undefined)
  if (!info) return { exists: false, candidates, skipped }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The v1 sharing folder must be a directory, not a symlink")
  for (const entry of (await readdir(root, { withFileTypes: true })).filter((item) => item.name.endsWith(".md") && item.name !== "README.md").sort((a, b) => a.name.localeCompare(b.name))) {
    if (candidates.length >= limit) { skipped.push({ file: entry.name, reason: `over the limit of ${limit}` }); continue }
    if (!entry.isFile()) { skipped.push({ file: entry.name, reason: "not a regular file" }); continue }
    const file = path.join(root, entry.name)
    if ((await lstat(file)).size > V1_MAX_BYTES) { skipped.push({ file: entry.name, reason: "larger than 32 KB" }); continue }
    const raw = await Bun.file(file).text()
    const [first = "", ...rest] = raw.split("\n")
    const header = (() => { try { return JSON.parse(V1_HEADER.exec(first.trim())?.[1] ?? "null") as { version?: unknown; id?: unknown; scope?: unknown } | null } catch { return null } })()
    if (!header || header.version !== 1 || typeof header.id !== "string" || (header.scope !== "global" && header.scope !== "project")) { skipped.push({ file: entry.name, reason: "no MendCode v1 memory header" }); continue }
    const text = rest.join("\n").trim()
    if (!text) { skipped.push({ file: entry.name, reason: "empty" }); continue }
    if (redactSecrets(text).count) { skipped.push({ file: entry.name, reason: "contains a credential" }); continue }
    candidates.push({ file: entry.name, id: header.id, scope: header.scope === "global" ? "user" : "project", text: text.slice(0, 2_000) })
  }
  return { exists: true, candidates, skipped }
}

export function createMemoryControl(input: {
  store: Store
  profile(directory: string): string
  id(): MemoryId
  now(): number
  extract?: ((job: ExtractionJob, signal: AbortSignal) => Promise<ExtractedMemory[]>) | undefined
  resolve(memory: MemoryEntry, accept: boolean): Record<string, unknown> | undefined
  /** `entry` is the memory as it was, for a deletion. */
  changed(memoryId: MemoryId, change: "added" | "updated" | "deleted", entry?: MemoryEntry): void
  settingsChanged(): void
}) {
  const { store } = input
  const active = new Set<AbortController>()
  let stopped = false
  const entries = (directory: string) => store.memories.list({ directory, profile: input.profile(directory) })
  function target(directory: string, args: MemoryControlInput) {
    const memory = entries(directory).find((entry) => entry.memoryId === args.memoryId && (!args.scope || entry.scope === args.scope))
    if (!memory) throw new Error("Memory not found in this project/profile/scope")
    return memory
  }
  function propose(directory: string, text: string, args: MemoryControlInput, source: "user" | "agent" = "user") {
    const memoryId = input.id()
    const scope = args.scope ?? "project"
    store.memories.add({ memoryId, scope, ...(scope === "user" ? { profile: input.profile(directory) } : { directory }), text: redactSecrets(text).text, category: args.category ?? "other", source, status: "pending", ...(args.tags?.length ? { details: { tags: args.tags } } : {}) })
    input.changed(memoryId, "added")
    return store.memories.get(memoryId)!
  }
  async function extract(directory: string, text: string, args: MemoryControlInput) {
    if (stopped) throw new Error("Memory control stopped")
    if (!input.extract) return { proposals: [], skipped: true, reason: "Memory extractor is not configured", callsProviders: false, writesMemory: false }
    const controller = new AbortController()
    active.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error(String(controller.signal.reason))), { once: true })
      timer = setTimeout(() => controller.abort("Memory extraction timed out"), 45_000)
    })
    const at = input.now()
    try {
      const extracted = await Promise.race([input.extract({ jobId: "manual-import", sessionId: "" as ExtractionJob["sessionId"], turnId: "" as ExtractionJob["turnId"], directory, text: redactSecrets(text).text.slice(0, 64_000), state: "running", attempts: 1, nextAttemptAt: at, reason: "", proposed: 0, createdAt: at, updatedAt: at }, controller.signal), timeout])
      const known = new Set(entries(directory).filter((entry) => entry.status !== "archived").map((entry) => `${entry.scope}:${fingerprint(entry.text)}`))
      const proposals: MemoryEntry[] = []
      for (const candidate of extracted.slice(0, args.maxProposals ?? 20)) {
        if (!candidate.text?.trim() || candidate.text.length > 2_000 || !["project", "user"].includes(candidate.scope)) continue
        const scope = args.scope ?? candidate.scope
        const safe = redactSecrets(candidate.text).text
        const key = `${scope}:${fingerprint(safe)}`
        if (known.has(key)) continue
        known.add(key)
        proposals.push(propose(directory, safe, { ...args, scope, category: candidate.category.slice(0, 64) }, "agent"))
      }
      return { proposals, skipped: false, callsProviders: true, writesMemory: false }
    } finally { clearTimeout(timer); active.delete(controller) }
  }
  async function run(directory: string, args: MemoryControlInput): Promise<Record<string, unknown>> {
    if (stopped) throw new Error("Memory control stopped")
    const settings = memorySettings(store.settings.get(), directory)
    const safeFlags = { callsProviders: false, readsSecrets: false }
    if (args.operation === "status" || args.operation === "config") {
      if (args.operation === "config" && args.patch && Object.keys(args.patch).length) {
        const patch = MemoryConfigPatch.parse(args.patch)
        store.settings.set(args.project ? { memoryProjects: { ...store.settings.get().memoryProjects, [directory]: { ...store.settings.get().memoryProjects?.[directory], ...patch } } } : patch)
        input.settingsChanged()
      }
      const config = args.operation === "config" && !args.project ? store.settings.get() : memorySettings(store.settings.get(), directory)
      const visible = entries(directory)
      return { ...safeFlags, configScope: args.project || args.operation === "status" && store.settings.get().memoryProjects?.[directory] ? "project" : "global", config: { enabled: config.memoryEnabled !== false, use: config.memoryUse === true, generate: config.memoryGenerate === true, maxPromptTokens: config.memoryMaxPromptTokens ?? 10_000, maxEntries: config.memoryMaxEntries ?? 50, projectMaxEntries: config.memoryProjectMaxEntries ?? 3, globalCompactionMaxEntries: config.memoryGlobalCompactionMaxEntries ?? 50, dreamConsolidationPolicy: config.dreamConsolidationPolicy ?? "auto-consolidate" }, counts: Object.fromEntries(["saved", "pending", "archived"].map((status) => [status, visible.filter((entry) => entry.status === status).length])) }
    }
    if (args.operation === "preview") {
      const mode = args.mode ?? "request"
      const cap = mode === "after-compaction" ? settings.memoryGlobalCompactionMaxEntries ?? 50 : settings.memoryMaxEntries ?? 50
      const visible = entries(directory).filter((entry) => entry.status === "saved" && !entry.details?.action)
      const selector = createMemorySelector({ visible: () => { let count = 0; return visible.filter((entry) => entry.scope !== "user" || ++count <= cap) }, related: ({ prompt, limit }) => store.memories.related({ text: prompt, directory, profile: input.profile(directory), limit }), links: (ids) => store.memories.links(ids) }, { now: input.now, settings: () => ({ ...settings, ...(mode === "manual" ? { memoryProjectMaxEntries: settings.memoryMaxEntries ?? 50 } : {}) }) })
      const request = { directory, prompt: args.query ?? "" }
      return { ...safeFlags, query: request.prompt, mode, providerID: args.provider ?? "generic", modelID: args.model ?? "memory-preview", enabled: settings.memoryEnabled !== false, use: settings.memoryUse === true, entries: selector.select(request).memories.map((entry) => ({ ...entry, text: redactSecrets(entry.text).text })), promptBlock: redactSecrets(selector.block(request)).text }
    }
    if (args.operation === "index") return { ...safeFlags, indexed: store.memories.reindex() }
    if (args.operation === "import-codex") {
      const root = path.resolve(directory, args.from ?? path.join(homedir(), ".codex", "memories"))
      const scanned = await codexCandidates(root, args.maxProposals ?? 20)
      const extracted = args.apply && scanned.candidates.length ? await extract(directory, scanned.candidates.map((item) => `<file path=${JSON.stringify(item.file)}>\n${item.text}\n</file>`).join("\n\n"), { ...args, scope: "user", tags: ["codex-import"] }) : { proposals: [], skipped: true, reason: scanned.exists ? "preview only" : "directory not found", callsProviders: false, writesMemory: false }
      return { ...safeFlags, codexMemoryDir: root, ...scanned, apply: args.apply === true, ...extracted }
    }
    if (args.operation === "import-v1") {
      const root = path.resolve(directory, args.from!)
      const scanned = await v1Candidates(root, args.maxProposals ?? 50)
      // A memory already here (saved, pending or archived, same text up to case and spacing) is not proposed again.
      const known = new Set(entries(directory).map((entry) => `${entry.scope}\0${fingerprint(entry.text)}`))
      const fresh = scanned.candidates.filter((item) => !known.has(`${item.scope}\0${fingerprint(item.text)}`))
      const duplicates = scanned.candidates.filter((item) => !fresh.includes(item)).map((item) => ({ file: item.file, reason: "already in memory" }))
      const proposals = args.apply ? fresh.map((item) => propose(directory, item.text, { ...args, scope: item.scope, tags: ["v1-import"] })) : []
      return { ...safeFlags, v1MemoryDir: root, exists: scanned.exists, candidates: fresh.map(({ text, ...item }) => ({ ...item, preview: text.slice(0, 160) })), skipped: [...scanned.skipped, ...duplicates], apply: args.apply === true, proposals, callsProviders: false, writesMemory: false }
    }
    if (args.operation === "propose") {
      if (args.fromFile) return { ...safeFlags, ...await extract(directory, await readText(path.resolve(directory, args.fromFile)), args) }
      return { ...safeFlags, proposal: propose(directory, args.text!, args), writesMemory: false }
    }
    const memory = target(directory, args)
    if (args.operation === "edit") {
      const text = redactSecrets(args.text!).text
      store.memories.update(memory.memoryId, { text, ...(memory.details?.action ? { details: { ...memory.details, action: { ...memory.details.action, text } } } : {}) })
      input.changed(memory.memoryId, "updated")
      return { ...safeFlags, entry: store.memories.get(memory.memoryId) }
    }
    if (args.operation === "delete") {
      store.memories.delete(memory.memoryId)
      input.changed(memory.memoryId, "deleted", memory)
      return { ...safeFlags, deleted: memory.memoryId }
    }
    if (memory.status !== "pending") throw new Error("Only pending proposals can be applied or rejected")
    const accept = args.operation === "apply"
    const action = input.resolve(memory, accept)
    if (action) return { ...safeFlags, ...action }
    const revision = store.memories.resolveRevision(memory.memoryId, accept)
    if (revision.result !== "not_a_revision") {
      input.changed(memory.memoryId, "deleted")
      if (revision.result === "stale") throw new Error("The memory changed since this proposal; it was dropped")
      if (revision.result === "applied") input.changed(revision.targetId, "updated")
      return { ...safeFlags, revision: revision.result, targetId: revision.targetId }
    }
    store.memories.update(memory.memoryId, { status: accept ? "saved" : "archived" })
    input.changed(memory.memoryId, "updated")
    return { ...safeFlags, proposal: store.memories.get(memory.memoryId), writesMemory: accept }
  }
  return { run, stop() { stopped = true; for (const controller of active) controller.abort("Memory control stopped") } }
}
