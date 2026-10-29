import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { canonicalDir } from "@mendcode/tools"
import { BACKLOG_LIMITS, backlogOrder, type BacklogEdit, type BacklogItem, type BacklogOrigin, type BacklogReport } from "@mendcode/protocol/wire"

/**
 * The project backlog: one small JSON file per project under the daemon data dir, beside the scratchpads and keyed the same
 * way (the canonical project directory). It is the user's list: no session, tool or model call writes it (`backlog.change`
 * is refused to a session's own shell), and it is never part of a prompt.
 */
type Stored = { version: 1; directory: string; next: number; items: BacklogItem[] }

export function backlogFile(dir: string, directory: string) {
  const key = createHash("sha256").update(canonicalDir(directory)).digest("hex")
  return path.join(dir, "backlogs", `${key}.json`)
}

const oneLine = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit)

function origin(value: unknown): BacklogOrigin | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const sessionId = typeof raw.sessionId === "string" ? oneLine(raw.sessionId, 100) : ""
  const file = typeof raw.path === "string" ? oneLine(raw.path, BACKLOG_LIMITS.path) : ""
  const commit = typeof raw.commit === "string" && /^[0-9a-fA-F]{4,64}$/.test(raw.commit) ? raw.commit.toLowerCase() : ""
  if (!sessionId && !file && !commit) return undefined
  return { ...(sessionId ? { sessionId } : {}), ...(file ? { path: file } : {}), ...(commit ? { commit } : {}) }
}

/** A file someone edited by hand is read item by item: what does not fit the shape is left out, never trusted. */
function read(dir: string, directory: string): Stored {
  const empty: Stored = { version: 1, directory: canonicalDir(directory), next: 1, items: [] }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(backlogFile(dir, directory), "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return empty
    throw error
  }
  const list = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : []
  const items: BacklogItem[] = []
  const seen = new Set<number>()
  for (const entry of list.slice(0, BACKLOG_LIMITS.items)) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    const text = typeof item.text === "string" ? oneLine(item.text, BACKLOG_LIMITS.text) : ""
    if (!Number.isInteger(item.id) || (item.id as number) < 1 || seen.has(item.id as number) || !text) continue
    seen.add(item.id as number)
    const from = origin(item.origin)
    items.push({
      id: item.id as number, text, done: item.done === true, createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
      ...(item.done === true && typeof item.doneAt === "number" ? { doneAt: item.doneAt } : {}), ...(from ? { origin: from } : {}),
    })
  }
  const stated = (raw as { next?: unknown } | null)?.next
  const next = Math.max(Number.isInteger(stated) ? (stated as number) : 1, ...items.map((item) => item.id + 1), 1)
  return { ...empty, next, items }
}

function write(dir: string, directory: string, stored: Stored) {
  const file = backlogFile(dir, directory)
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

const report = (stored: Stored): BacklogReport => ({ directory: stored.directory, items: backlogOrder(stored.items) })

export function readBacklog(dir: string, directory: string): BacklogReport {
  return report(read(dir, directory))
}

/** Applies one change of the user's and returns the list as it now stands; an add also says the new item's id. */
export function changeBacklog({ dir, directory, change, now }: { dir: string; directory: string; change: BacklogEdit; now: number }): BacklogReport & { added?: number } {
  const stored = read(dir, directory)
  if (change.op === "add") {
    const text = oneLine(change.text, BACKLOG_LIMITS.text)
    if (!text) throw new TypeError("[BACKLOG]: an item needs text")
    if (stored.items.length >= BACKLOG_LIMITS.items) throw new RangeError(`[BACKLOG]: the list holds ${BACKLOG_LIMITS.items} items; clear the finished ones or remove some first`)
    const id = stored.next
    const from = origin(change.origin)
    stored.items.push({ id, text, done: false, createdAt: now, ...(from ? { origin: from } : {}) })
    stored.next = id + 1
    write(dir, directory, stored)
    return { ...report(stored), added: id }
  }
  if (change.op === "clear-done") {
    stored.items = stored.items.filter((item) => !item.done)
    write(dir, directory, stored)
    return report(stored)
  }
  const index = stored.items.findIndex((item) => item.id === change.id)
  if (index < 0) throw new RangeError(`[BACKLOG]: no item #${change.id}`)
  if (change.op === "remove") stored.items.splice(index, 1)
  else {
    const { doneAt: _doneAt, ...item } = stored.items[index]!
    stored.items[index] = change.op === "done" ? { ...item, done: true, doneAt: now } : { ...item, done: false }
  }
  write(dir, directory, stored)
  return report(stored)
}
