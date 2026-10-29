import { createReadStream, existsSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import type { MemoryEntry, MemoryId, MemoryStatus } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { derivedId } from "./ids"
import { addError, type MigrationReport } from "./report"
import { MAX_MEMORY_CATEGORY, MAX_MEMORY_TEXT, V1_MEMORY_DIR, V1_MEMORY_FILES } from "./settings"
import { isRecord } from "./v1-reader"

export type V1Memory = {
  id: string
  scope: string
  text: string
  categoryId: string
  cwd: string
  source: string
  sensitivity: string
  createdAt: number
  updatedAt: number
}

const str = (value: unknown) => (typeof value === "string" ? value : "")
const isoMs = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN
  return Number.isFinite(at) && at >= 0 ? at : undefined
}

/** One JSON line of a v1 memory file; undefined when it is unusable (no id or no text). */
export function parseMemory(line: string): V1Memory | undefined {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || !str(value.id) || !str(value.text).trim()) return undefined
  const createdAt = isoMs(value.createdAt) ?? isoMs(value.updatedAt) ?? 0
  const categories = Array.isArray(value.categoryIDs) ? value.categoryIDs : []
  return {
    id: str(value.id),
    scope: str(value.scope),
    text: str(value.text),
    categoryId: str(categories[0]),
    cwd: str(value.cwd),
    source: str(value.source),
    sensitivity: str(value.sensitivity),
    createdAt,
    updatedAt: isoMs(value.updatedAt) ?? createdAt,
  }
}

/** The v2 memory a v1 entry becomes: global → user scope; otherwise a cwd makes it a project memory. */
export function toMemoryEntry(memory: V1Memory, status: MemoryStatus): Omit<MemoryEntry, "createdAt" | "updatedAt"> & { createdAt: number; updatedAt: number } {
  const project = memory.scope !== "global" && memory.cwd !== ""
  return {
    memoryId: derivedId("memory", memory.id, memory.createdAt) as MemoryId,
    scope: project ? "project" : "user",
    ...(project ? { directory: memory.cwd } : {}),
    text: memory.text.length > MAX_MEMORY_TEXT ? `${memory.text.slice(0, MAX_MEMORY_TEXT - 1)}…` : memory.text,
    category: memory.categoryId.slice(0, MAX_MEMORY_CATEGORY),
    status,
    // The store keeps the text as written and reads any source that is not "agent" back as "user".
    source: `v1:${memory.source}` as MemoryEntry["source"],
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }
}

type MemoryTarget = {
  /** Current time for the store's clock while a memory is written (it stamps created/updated with it). */
  clock: { at: number }
  store: Pick<Store, "memories">
}

/**
 * Imports `memory/entries.jsonl` (saved) and `memory/archived.jsonl` (archived) line by line. Entries whose id was
 * imported before, whose exact text is already a memory, or that are high sensitivity are skipped and counted.
 * With no target store (dry run) nothing is written and only duplicates inside the files are detected.
 */
export async function importMemories({ from, report, target }: { from: string; report: MigrationReport; target?: MemoryTarget }) {
  const known = new Set<string>(target ? target.store.memories.list().map((memory) => memory.text) : [])
  for (const [status, file] of [["saved", V1_MEMORY_FILES.saved], ["archived", V1_MEMORY_FILES.archived]] as const) {
    const full = path.join(from, V1_MEMORY_DIR, file)
    if (!existsSync(full)) continue
    let lineNumber = 0
    for await (const line of createInterface({ input: createReadStream(full, { encoding: "utf8" }), crlfDelay: Infinity })) {
      lineNumber++
      if (!line.trim()) continue
      let memory: V1Memory | undefined
      try {
        memory = parseMemory(line)
      } catch (error) {
        addError(report, { id: `memory:${file}:${lineNumber}`, message: error instanceof Error ? error.message : String(error) })
      }
      if (!memory) {
        report.memories.invalid++
        continue
      }
      if (memory.sensitivity === "high") {
        report.memories.skippedHighSensitivity++
        continue
      }
      const entry = toMemoryEntry(memory, status)
      if (target?.store.memories.get(entry.memoryId)) {
        report.memories.already++
        continue
      }
      if (known.has(entry.text)) {
        report.memories.duplicate++
        continue
      }
      if (entry.text !== memory.text) report.memories.truncated++
      try {
        if (target) {
          const { createdAt, updatedAt, ...row } = entry
          target.clock.at = createdAt
          target.store.memories.add(row)
          if (updatedAt !== createdAt) {
            target.clock.at = updatedAt
            target.store.memories.update(entry.memoryId, {})
          }
        }
        known.add(entry.text)
        report.memories.imported++
      } catch (error) {
        addError(report, { id: `memory:${memory.id}`, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
