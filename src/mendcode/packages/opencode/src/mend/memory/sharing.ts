import { constants } from "node:fs"
import { lstat, mkdir, open, rename, realpath, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Flock } from "@mendcode/core/util/flock"
import { z } from "zod"
import { memoryPaths, type MemoryScope } from "./config"
import { memoryEntryRevision, readMemoryEntries } from "./store"
import { listMemoryProposals, proposeMemory, redactMemoryText } from "./proposals"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const Revision = z.string().regex(/^[a-f0-9]{64}$/)
const State = z.object({
  version: z.literal(1), enabled: z.boolean(),
  entries: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.object({ revision: Revision, hash: Revision })),
  indexHash: Revision.optional(),
})
const Header = z.object({ version: z.literal(1), id: z.string(), scope: z.enum(["global", "project"]), identity: Revision, revision: Revision }).strict()
const MAX_BYTES = 32_768
const MAX_ENTRIES = 200

function parseHeader(line: string) {
  const match = /^<!-- mendcode-memory (.+) -->$/.exec(line)
  if (!match) return undefined
  try {
    const parsed = Header.safeParse(JSON.parse(match[1]!))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function directory(scope: MemoryScope, root?: string) {
  const paths = memoryPaths(root)
  const base = scope === "global" ? paths.globalDir : paths.projectDir
  await mkdir(base, { recursive: true, mode: 0o700 })
  const canonical = await realpath(base)
  const dir = path.join(canonical, "sharing")
  for (const child of [dir, path.join(dir, ".locks")]) {
    await mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
    const info = await lstat(child)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Memory sharing directory must not be a symlink")
  }
  return { dir, identity: digest(scope === "global" ? "global" : await realpath(paths.root)) }
}

async function safeRead(file: string, maxBytes = MAX_BYTES) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error("Shared memory file is not a bounded regular file")
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const chunk = await handle.read(buffer, size, buffer.length - size, size)
      if (!chunk.bytesRead) break
      size += chunk.bytesRead
    }
    if (size > maxBytes) throw new Error("Shared memory file grew beyond the size limit")
    return buffer.subarray(0, size).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function atomicWrite(file: string, text: string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { flag: "wx", mode: 0o600 })
  await rename(temporary, file)
}

async function transaction<T>(scope: MemoryScope, root: string | undefined, operation: (location: Awaited<ReturnType<typeof directory>>, state: z.infer<typeof State>) => Promise<T>) {
  const location = await directory(scope, root)
  return Flock.withLock(`memory-sharing:${location.dir}`, async () => {
    const file = path.join(location.dir, "state.json")
    const raw = await safeRead(file, 256_000)
    const state = raw ? State.parse(JSON.parse(raw)) : State.parse({ version: 1, enabled: false, entries: {} })
    if (Object.keys(state.entries).length > MAX_ENTRIES) throw new Error("Sharing inventory exceeds 200 entries")
    const result = await operation(location, state)
    await atomicWrite(file, JSON.stringify(state, null, 2) + "\n")
    return result
  }, { dir: path.join(location.dir, ".locks"), timeoutMs: 5_000 })
}

export async function memorySharingStatus(scope: MemoryScope, root?: string) {
  const paths = memoryPaths(root)
  const dir = path.join(scope === "global" ? paths.globalDir : paths.projectDir, "sharing")
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return { enabled: false, scope, directory: dir }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Memory sharing directory must not be a symlink")
  const raw = await safeRead(path.join(dir, "state.json"), 256_000)
  return { enabled: raw ? State.parse(JSON.parse(raw)).enabled : false, scope, directory: dir }
}

export async function configureMemorySharing(scope: MemoryScope, enabled: boolean, root?: string) {
  return transaction(scope, root, async ({ dir }, state) => {
    state.enabled = enabled
    return { enabled, scope, directory: dir }
  })
}

export async function exportSharedMemories(scope: MemoryScope, root?: string) {
  return transaction(scope, root, async ({ dir, identity }, state) => {
    if (!state.enabled) throw new Error(`Markdown sharing is disabled for ${scope}; explicitly enable it first`)
    const entries = await readMemoryEntries(scope, root)
    if (entries.length > MAX_ENTRIES) throw new Error("Export exceeds 200 entries; narrow the memory inventory first")
    const exported: string[] = []
    const conflicts: string[] = []
    const skipped: string[] = []
    for (const entry of entries) {
      if (!/^[a-zA-Z0-9_-]+$/.test(entry.id)) { skipped.push(entry.id); continue }
      if (entry.sensitivity !== "low" || redactMemoryText(entry.text).redactions.length) { skipped.push(entry.id); continue }
      const revision = memoryEntryRevision(entry)
      const header = { version: 1, id: entry.id, scope, identity, revision }
      const markdown = `<!-- mendcode-memory ${JSON.stringify(header)} -->\n\n${entry.text}\n`
      if (Buffer.byteLength(markdown) > MAX_BYTES) { skipped.push(entry.id); continue }
      const file = path.join(dir, `${entry.id}.md`)
      const existing = await safeRead(file)
      const baseline = state.entries[entry.id]
      // After manual approval the edited text is authoritative internally; only
      // refresh an exact projection, never silently replace other external edits.
      const acceptedProjection = baseline ? `<!-- mendcode-memory ${JSON.stringify({ ...header, revision: baseline.revision })} -->\n\n${entry.text}\n` : undefined
      if (existing !== undefined && digest(existing) !== baseline?.hash && existing !== acceptedProjection) { conflicts.push(entry.id); continue }
      await atomicWrite(file, markdown)
      state.entries[entry.id] = { revision, hash: digest(markdown) }
      exported.push(entry.id)
    }
    const index = "# Shared MendCode memories\n\nEdit the text below each metadata header. Import creates reviewable proposals, not automatic updates. Do not change metadata. Deleting a file never deletes internal memory.\n\n" + exported.map((id) => `- [${id}](${id}.md)`).join("\n") + "\n"
    const indexPath = path.join(dir, "index.md")
    const previousIndex = await safeRead(indexPath)
    if (previousIndex === undefined || digest(previousIndex) === state.indexHash) {
      await atomicWrite(indexPath, index)
      state.indexHash = digest(index)
    } else conflicts.push("index.md")
    return { scope, directory: dir, exported, conflicts, skipped }
  })
}

export async function importSharedMemories(scope: MemoryScope, root?: string) {
  return transaction(scope, root, async ({ dir, identity }, state) => {
    if (!state.enabled) throw new Error(`Markdown sharing is disabled for ${scope}; explicitly enable it first`)
    const entries = await readMemoryEntries(scope, root)
    const pending = await listMemoryProposals(root, "pending")
    const proposals: string[] = []
    const conflicts: string[] = []
    for (const [id, baseline] of Object.entries(state.entries)) {
      const markdown = await safeRead(path.join(dir, `${id}.md`))
      if (markdown === undefined || digest(markdown) === baseline.hash) continue
      const line = markdown.split("\n", 1)[0]!
      const parsed = parseHeader(line)
      const entry = entries.find((entry) => entry.id === id)
      if (!parsed || parsed.id !== id || parsed.scope !== scope || parsed.identity !== identity || parsed.revision !== baseline.revision || !entry || memoryEntryRevision(entry) !== baseline.revision || entry.sensitivity !== "low") {
        conflicts.push(id)
        continue
      }
      const text = markdown.slice(line.length).trim()
      if (!text || redactMemoryText(text).redactions.length) { conflicts.push(id); continue }
      if (text === entry.text) continue
      const evidence = `markdown-sharing:${identity}:${id}:${digest(markdown)}`
      const existing = pending.find((proposal) => proposal.evidence === evidence)
      if (existing) { proposals.push(existing.id); continue }
      const proposal = await proposeMemory({
        operation: "update", scope, targetEntryID: id, targetEntryScope: scope,
        targetEntryRevision: baseline.revision, text,
        tags: entry.tags.filter((tag) => !["dream-dry-run", "dream-service-start", "graph-upsert", "graph-link"].includes(tag)),
        categoryIDs: entry.categoryIDs,
        source: "markdown-sharing", evidence, policyDecision: "manual-only",
        reason: "Editable Markdown import; review before applying. Reject if the internal revision changed.",
      }, root)
      proposals.push(proposal.id)
    }
    return { scope, directory: dir, proposals, conflicts }
  })
}
