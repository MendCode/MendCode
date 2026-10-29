import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { redactSecrets, type MemoryEntry, type MemoryId, type SharingResult, type SharingScope, type SharingStatusReport } from "@mendcode/protocol"
import { sharedMemoryRevision, type Store } from "@mendcode/store"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const safeId = z.string().regex(/^[a-zA-Z0-9_-]+$/)
const Header = z.strictObject({ version: z.literal(2), id: safeId, scope: z.enum(["project", "user"]), identity: revision, revision })
const State = z.strictObject({ version: z.literal(2), enabled: z.boolean(), entries: z.record(safeId, z.strictObject({ revision, hash: revision })), indexHash: revision.optional() })
const MAX_BYTES = 32_768
const MAX_ENTRIES = 200

async function read(file: string, max = MAX_BYTES) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new Error("Cannot read a shared regular file without following links")
  })
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) throw new Error("Shared file must be a bounded regular file")
    const buffer = Buffer.alloc(max + 1)
    let size = 0
    while (size < buffer.length) {
      const chunk = await handle.read(buffer, size, buffer.length - size, size)
      if (!chunk.bytesRead) break
      size += chunk.bytesRead
    }
    if (size > max) throw new Error("Shared file exceeds the size limit")
    return buffer.subarray(0, size).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function write(file: string, text: string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

const shareable = (entry: MemoryEntry) => entry.status === "saved" && entry.scope !== "session" && entry.details?.sensitivity !== "high" && !entry.details?.action && !/(?:^|\.)security$/i.test(entry.category) && redactSecrets(entry.text).count === 0 && !/\[redacted:|‹secret:/.test(entry.text)
const markdown = (header: z.infer<typeof Header>, text: string) => `<!-- mendcode-memory ${JSON.stringify(header)} -->\n\n${text}\n`

/** One store owns this directory. Serialize its filesystem operations as well as the SQLite review transaction. */
export function createMemorySharing(input: { dir: string; store: Store; profile(directory?: string): string; id(): MemoryId; changed(id: MemoryId): void }) {
  const tails = new Map<string, Promise<unknown>>()
  async function location(scope: SharingScope, directory?: string, create = false) {
    if (scope === "project" && !directory) throw new Error("Project sharing needs a directory")
    const root = await realpath(input.dir)
    const context = scope === "user" ? input.profile(directory) : path.resolve(directory!)
    const identity = hash(JSON.stringify(["mendcode-v2", root, scope, context]))
    const parent = path.join(root, "memory-sharing")
    const dir = path.join(parent, `${scope}-${identity}`)
    for (const child of [parent, dir]) {
      if (create) await mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
      const info = await lstat(child).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error("Sharing directory must not be a link")
      if (!info && !create) break
    }
    return { dir, identity, context }
  }
  async function stateAt(dir: string) {
    const text = await read(path.join(dir, "state.json"), 256_000)
    const state = State.parse(text === undefined ? { version: 2, enabled: false, entries: {} } : JSON.parse(text))
    if (Object.keys(state.entries).length > MAX_ENTRIES) throw new Error("Sharing inventory exceeds 200 entries")
    return state
  }
  const report = (scope: SharingScope, dir: string, state: z.infer<typeof State>): SharingStatusReport => ({ scope, directory: dir, enabled: state.enabled, format: "mendcode-v2", entries: Object.keys(state.entries).length })
  const entriesFor = (scope: SharingScope, directory?: string) => input.store.memories.list({ ...(directory ? { directory } : {}), profile: input.profile(directory) }).filter((entry) => entry.scope === scope && entry.status === "saved")

  async function status(scope: SharingScope, directory?: string) {
    const { dir } = await location(scope, directory)
    return report(scope, dir, await stateAt(dir))
  }
  async function serial<T>(scope: SharingScope, directory: string | undefined, operation: (place: Awaited<ReturnType<typeof location>>, state: z.infer<typeof State>) => Promise<T>) {
    const key = JSON.stringify([scope, scope === "user" ? input.profile(directory) : directory ? path.resolve(directory) : ""])
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      const place = await location(scope, directory, true)
      const state = await stateAt(place.dir)
      const result = await operation(place, state)
      await write(path.join(place.dir, "state.json"), JSON.stringify(state, null, 2) + "\n")
      return result
    })
    tails.set(key, run)
    try { return await run }
    finally { if (tails.get(key) === run) tails.delete(key) }
  }
  async function configure(scope: SharingScope, directory: string | undefined, enabled: boolean, confirmation?: string) {
    if (enabled && confirmation !== `ENABLE ${scope.toUpperCase()}`) throw new Error(`Type ENABLE ${scope.toUpperCase()} to enable sharing`)
    return serial(scope, directory, async ({ dir }, state) => {
      state.enabled = enabled
      return report(scope, dir, state)
    })
  }
  async function run(scope: SharingScope, directory: string | undefined, action: "export" | "import") {
    return serial(scope, directory, async ({ dir, identity }, state): Promise<SharingResult> => {
      if (!state.enabled) throw new Error(`Sharing is disabled for ${scope}`)
      const entries = entriesFor(scope, directory)
      if (entries.length > MAX_ENTRIES) throw new Error("Sharing exceeds 200 saved entries")
      const result: SharingResult = { ...report(scope, dir, state), action, exported: [], proposals: [], conflicts: [], skipped: [] }
      if (action === "export") {
        if (new Set([...Object.keys(state.entries), ...entries.map((entry) => entry.memoryId)]).size > MAX_ENTRIES) throw new Error("Sharing inventory exceeds 200 entries")
        for (const entry of entries) {
          if (!safeId.safeParse(entry.memoryId).success || !shareable(entry)) { result.skipped.push({ id: entry.memoryId, reason: "Not eligible for sharing" }); continue }
          const header = { version: 2 as const, id: entry.memoryId, scope, identity, revision: sharedMemoryRevision(entry) }
          const text = markdown(header, entry.text)
          if (Buffer.byteLength(text) > MAX_BYTES) { result.skipped.push({ id: entry.memoryId, reason: "File exceeds 32 KiB" }); continue }
          const file = path.join(dir, `${entry.memoryId}.md`)
          try {
            const existing = await read(file)
            const baseline = state.entries[entry.memoryId]
            const accepted = baseline ? markdown({ ...header, revision: baseline.revision }, entry.text) : undefined
            if (existing !== undefined && hash(existing) !== baseline?.hash && existing !== accepted) { result.conflicts.push({ id: entry.memoryId, reason: "Markdown has external edits" }); continue }
            await write(file, text)
            state.entries[entry.memoryId] = { revision: header.revision, hash: hash(text) }
            result.exported.push(entry.memoryId)
          } catch (error) { result.conflicts.push({ id: entry.memoryId, reason: error instanceof Error ? error.message : "File unavailable" }) }
        }
        const index = "# Shared MendCode memories\n\nImport edits for manual review. Keep metadata unchanged. Deleting a file keeps internal memory.\n\n" + result.exported.map((id) => `- [${id}](${id}.md)`).join("\n") + "\n"
        try {
          const file = path.join(dir, "index.md")
          const previous = await read(file)
          if (previous !== undefined && hash(previous) !== state.indexHash) result.conflicts.push({ id: "index.md", reason: "Index has external edits" })
          else { await write(file, index); state.indexHash = hash(index) }
        } catch (error) { result.conflicts.push({ id: "index.md", reason: error instanceof Error ? error.message : "Index unavailable" }) }
      } else {
        for (const [id, baseline] of Object.entries(state.entries)) {
          try {
            const text = await read(path.join(dir, `${id}.md`))
            if (text === undefined || hash(text) === baseline.hash) continue
            const first = text.split("\n", 1)[0]!
            const match = /^<!-- mendcode-memory (.+) -->$/.exec(first)
            const header = match ? Header.safeParse(JSON.parse(match[1]!)) : undefined
            const entry = input.store.memories.get(id as MemoryId)
            if (!header?.success || header.data.id !== id || header.data.scope !== scope || header.data.identity !== identity || header.data.revision !== baseline.revision) throw new Error("Metadata or origin changed")
            if (!entry || !shareable(entry) || sharedMemoryRevision(entry) !== baseline.revision) throw new Error("Internal revision changed")
            const proposed = text.slice(first.length).trim()
            if (!proposed || proposed.length > 2_000 || redactSecrets(proposed).count || /\[redacted:|‹secret:/.test(proposed)) throw new Error("Edit is empty, too long or contains secrets")
            if (proposed === entry.text) continue
            let created: MemoryId | undefined
            const proposal = input.store.memorySharing.propose(`${identity}:${id}:${hash(text)}`, baseline.revision, () => {
              const memoryId = input.id()
              input.store.memories.add({ memoryId, scope: entry.scope, ...(entry.directory ? { directory: entry.directory } : {}), ...(entry.profile ? { profile: entry.profile } : {}), text: proposed, category: entry.category, status: "pending", source: "user", kind: "update", targetId: entry.memoryId, reason: "Markdown sharing import · manual review" })
              created = memoryId
              return memoryId
            })
            if (created) input.changed(created)
            result.proposals.push(proposal)
          } catch (error) { result.conflicts.push({ id, reason: error instanceof Error ? error.message : "Invalid Markdown" }) }
        }
      }
      return { ...result, entries: Object.keys(state.entries).length }
    })
  }
  return { status, configure, run }
}
