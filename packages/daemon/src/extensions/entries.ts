import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import type { SessionEntry } from "@mendcode/extension-api"

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/
const ENTRY_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** One entry's JSON, one session's file per extension, and how many entries a read returns (the newest). */
export const ENTRY_LIMITS = { entryBytes: 64 * 1024, fileBytes: 4 * 1024 * 1024, read: 1000 } as const

const fileOf = (extensionData: string, sessionId: string) => path.join(extensionData, "sessions", `${sessionId}.jsonl`)

/**
 * `api.appendEntry` / `api.entries`: an extension's own records about one session, kept in its data folder
 * (`extensions-data/<name>/sessions/<sessionId>.jsonl`, mode 0600). They never enter the model's context or the transcript.
 * Every problem is an answer (`error`), never a throw.
 */
export function createSessionEntries(input: { extensionData(): string; sessionExists?(sessionId: string): boolean; now(): number }) {
  return {
    append(sessionId: string, type: string, data: unknown): { ok: true } | { ok: false; error: string } {
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || input.sessionExists?.(sessionId) === false) return { ok: false, error: "appendEntry: unknown session" }
      if (typeof type !== "string" || !ENTRY_TYPE.test(type)) return { ok: false, error: "appendEntry: type is letters, digits, . _ : - (max 64)" }
      let line: string
      try {
        line = JSON.stringify({ type, at: input.now(), ...(data === undefined ? {} : { data }) })
      } catch {
        return { ok: false, error: "appendEntry: data must be JSON" }
      }
      if (Buffer.byteLength(line) > ENTRY_LIMITS.entryBytes) return { ok: false, error: `appendEntry: an entry is at most ${ENTRY_LIMITS.entryBytes} bytes of JSON` }
      const file = fileOf(input.extensionData(), sessionId)
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
      if (size + line.length + 1 > ENTRY_LIMITS.fileBytes) return { ok: false, error: `appendEntry: this session's entries reached ${ENTRY_LIMITS.fileBytes} bytes` }
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
      return { ok: true }
    },
    read(sessionId: string, type?: string): SessionEntry[] {
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return []
      let text: string
      try {
        text = readFileSync(fileOf(input.extensionData(), sessionId), "utf8")
      } catch {
        return []
      }
      const entries: SessionEntry[] = []
      for (const line of text.split("\n")) {
        if (!line) continue
        try {
          const entry = JSON.parse(line) as SessionEntry
          if (type === undefined || entry.type === type) entries.push(entry)
        } catch {
          // A line cut by a crash is skipped; the rest still reads.
        }
      }
      return entries.slice(-ENTRY_LIMITS.read)
    },
  }
}

/** A deleted session's entries, in every extension's data folder. */
export function forgetSessionEntries(dataDir: string, sessionId: string) {
  if (!SESSION_ID.test(sessionId)) return
  const root = path.join(dataDir, "extensions-data")
  let names: string[] = []
  try { names = readdirSync(root) } catch { return }
  for (const name of names) rmSync(fileOf(path.join(root, name), sessionId), { force: true })
}
