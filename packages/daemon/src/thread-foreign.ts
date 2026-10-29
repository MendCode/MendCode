import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import path from "node:path"
import type { SessionTranscript } from "@mendcode/protocol"
import { latestCandidates, readRegular, translate, type ForeignHomes } from "./session-import-source"

/** Where a chat that is not a MendCode session of this daemon comes from. `v1`: the previous MendCode's own database. */
export const FOREIGN_SOURCES = ["codex", "claude", "v1"] as const
export type ForeignSource = (typeof FOREIGN_SOURCES)[number]
export type ForeignThread = { id: string; source: ForeignSource; updatedAt: number; title?: string }
/** One message or tool call of a foreign chat, oldest first in a list. */
export type ForeignLine = { role: "user" | "assistant" | "tool"; text: string }
export type ForeignThreads = ReturnType<typeof createForeignThreads>

const ID = /^(codex|claude|v1):([A-Za-z0-9_-]{4,57})$/
const V1_LISTED = 12
/** The newest parts of a v1 chat that one read turns into lines. */
const V1_PARTS = 4_000
const CACHED = 2
const ROLE: Record<string, ForeignLine["role"]> = { user_message: "user", agent_message: "assistant", tool_call: "tool" }
const SOURCE_NAME: Record<ForeignSource, string> = { codex: "Codex", claude: "Claude Code", v1: "the previous MendCode" }

/** `codex:<id>`, `claude:<id>` or `v1:<id>`: an id `threads list` gave for a chat of another program. */
export const foreignRef = (ref: string): { source: ForeignSource; key: string } | undefined => {
  const match = ID.exec(ref)
  return match ? { source: match[1] as ForeignSource, key: match[2]! } : undefined
}
export const foreignSourceName = (source: ForeignSource) => SOURCE_NAME[source]

/** The transcript's id as its file names it: Codex ends the name with it, Claude Code uses it as the name. */
const fileKey = (file: string) => {
  const name = path.basename(file, ".jsonl")
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(name)?.[0] ?? name.slice(-57)
}

function transcriptLines(transcript: SessionTranscript): ForeignLine[] {
  const lines: ForeignLine[] = []
  for (const turn of transcript.turns) for (const item of turn.items) {
    const role = ROLE[item.kind]
    if (!role) continue
    const text = role === "tool" ? [item.tool, item.input].filter(Boolean).join(" ") : item.text
    if (text.trim()) lines.push({ role, text })
  }
  return lines
}

/**
 * The chats other programs keep for one project, for the `threads` tool: Codex and Claude Code transcripts (the files the
 * session import reads) and the previous MendCode's database, opened read-only. Only chats whose own record names the asked
 * directory are listed, and a chat is only read through an id that list gave for that directory, so nothing of another
 * project is reachable. Nothing is written anywhere, and nothing is kept beyond the last chats read.
 */
export function createForeignThreads(input: { homes: Required<ForeignHomes>; v1Db?: string; now?: () => number }) {
  const now = input.now ?? Date.now
  const cache = new Map<string, ForeignLine[]>()

  function v1<T>(run: (db: Database) => T, fallback: T): T {
    if (!input.v1Db || !existsSync(input.v1Db)) return fallback
    let db: Database | undefined
    try {
      db = new Database(input.v1Db, { readonly: true })
      return run(db)
    } catch {
      return fallback
    } finally { db?.close() }
  }

  function files(directory: string, source: "codex" | "claude") {
    return latestCandidates({ directory, from: source === "codex" ? "codex" : "claude-code", homes: input.homes }).map((entry) => ({ ...entry, key: fileKey(entry.file) }))
  }

  function list(directory: string): ForeignThread[] {
    const wanted = path.resolve(directory)
    const fromFiles = (["codex", "claude"] as const).flatMap((source) => files(directory, source).map((entry): ForeignThread => ({ id: `${source}:${entry.key}`, source, updatedAt: Math.floor(entry.mtime) })))
    const old = v1((db) => (db.query("select id, title, time_updated as updatedAt from session where directory = ? and parent_id is null and time_archived is null order by time_updated desc limit ?").all(wanted, V1_LISTED) as Array<{ id: string; title: string; updatedAt: number }>)
      .filter((row) => foreignRef(`v1:${row.id}`))
      .map((row): ForeignThread => ({ id: `v1:${row.id}`, source: "v1", updatedAt: row.updatedAt, title: row.title })), [])
    return [...fromFiles, ...old].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function v1Lines(directory: string, key: string): ForeignLine[] | undefined {
    return v1<ForeignLine[] | undefined>((db) => {
      const owner = db.query("select directory from session where id = ?").get(key) as { directory?: string } | null
      if (!owner?.directory || path.resolve(owner.directory) !== path.resolve(directory)) return undefined
      // The newest parts are chosen by id first, so sorting never carries the rows' text (a tool part can hold megabytes).
      const rows = db.query("select m.data as message, p.data as part from part p join message m on m.id = p.message_id where p.id in (select id from part where session_id = ? order by time_created desc, id desc limit ?) order by p.time_created, p.id").all(key, V1_PARTS) as Array<{ message: string; part: string }>
      const lines: ForeignLine[] = []
      for (const row of rows) {
        try {
          const part = JSON.parse(row.part) as { type?: string; text?: unknown; synthetic?: unknown; ignored?: unknown; tool?: unknown; state?: { input?: unknown } }
          if (part.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored && part.text.trim()) lines.push({ role: (JSON.parse(row.message) as { role?: string }).role === "user" ? "user" : "assistant", text: part.text })
          else if (part.type === "tool" && typeof part.tool === "string") lines.push({ role: "tool", text: `${part.tool} ${part.state?.input === undefined ? "" : JSON.stringify(part.state.input)}`.trim() })
        } catch { /* a row this reader does not understand is skipped */ }
      }
      return lines
    }, undefined)
  }

  /** The chat as lines, oldest first; undefined when `ref` is not a chat of this directory. */
  async function lines(directory: string, ref: string): Promise<ForeignLine[] | undefined> {
    const parsed = foreignRef(ref)
    if (!parsed) return undefined
    if (parsed.source === "v1") return v1Lines(directory, parsed.key)
    const entry = files(directory, parsed.source).find((candidate) => candidate.key === parsed.key)
    if (!entry) return undefined
    const cacheKey = `${entry.file}\0${entry.mtime}`
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const { text, mtime } = await readRegular(entry.file)
    const translated = translate({ text, from: entry.kind, mtime, now: now() })
    const result = "transcript" in translated ? transcriptLines(translated.transcript) : []
    cache.set(cacheKey, result)
    while (cache.size > CACHED) cache.delete(cache.keys().next().value!)
    return result
  }

  return { list, lines }
}
