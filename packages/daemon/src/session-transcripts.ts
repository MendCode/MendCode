import { lstatSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { outputDirectory } from "./output-directory"

const MAX_BYTES = 4 * 1024 * 1024
const MAX_TOTAL = 128 * 1024 * 1024
const RETENTION = 30 * 24 * 60 * 60 * 1000

const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "session"

/** Full-session transcripts a compaction summary points to; owner-only files with their own disk budget and age limit. */
export function createSessionTranscripts(dir: string, now = Date.now, write?: (file: string, bytes: Uint8Array) => void) {
  function cleanup() {
    let entries: Array<{ file: string; size: number; time: number }> = []
    try {
      const directory = outputDirectory(dir, "session-transcripts")
      if (!directory) return
      entries = readdirSync(directory).filter((name) => /^[A-Za-z0-9_-]+-g\d+\.md$/.test(name)).flatMap((name) => {
        const file = path.join(directory, name)
        try {
          const stat = lstatSync(file)
          if (!stat.isFile() || stat.nlink !== 1) return []
          if (stat.mtimeMs < now() - RETENTION) { unlinkSync(file); return [] }
          return [{ file, size: stat.size, time: stat.mtimeMs }]
        } catch { return [] }
      })
    } catch { return }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (total <= MAX_TOTAL) break
      try { unlinkSync(entry.file); total -= entry.size } catch {}
    }
  }
  cleanup()
  return {
    cleanup,
    /** Returns the file path; the same session and generation overwrite atomically. */
    async save(input: { sessionId: string; generation: number; markdown: string }) {
      const directory = outputDirectory(dir, "session-transcripts", true)!
      const bytes = Buffer.from(input.markdown)
      const marker = Buffer.from("\n[Transcript capped for disk safety]\n")
      const half = Math.floor((MAX_BYTES - marker.length) / 2)
      let head = half, tail = bytes.length - half
      while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--
      while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++
      const saved = bytes.length <= MAX_BYTES ? bytes : Buffer.concat([bytes.subarray(0, head), marker, bytes.subarray(tail)])
      const file = path.join(directory, `${safeSegment(input.sessionId)}-g${Math.max(0, Math.floor(input.generation))}.md`)
      const temporary = `${file}.${crypto.randomUUID()}.tmp`
      if (write) write(file, saved)
      else { writeFileSync(temporary, saved, { mode: 0o600, flag: "wx" }); renameSync(temporary, file) }
      cleanup()
      return file
    },
  }
}
