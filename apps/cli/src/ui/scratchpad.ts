import fs from "node:fs"
import path from "node:path"

/**
 * The dock's Scratchpad: a per-session text note kept on this machine in `<dataDir>/tui/scratch/<sessionId>.md`, like the
 * rest of the terminal's own files (profile, models, stash). It never goes through the daemon or into the session, and
 * the model never sees it. A missing or unreadable file is an empty note; saving an empty note removes the file.
 */
export const SCRATCH_MAX_CHARS = 8_000

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export const scratchPath = (dataDir: string, sessionId: string) => path.join(dataDir, "tui", "scratch", `${sessionId}.md`)

/** The note of a session; empty when there is none. */
export function readScratch(dataDir: string, sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) return ""
  try {
    return fs.readFileSync(scratchPath(dataDir, sessionId), "utf8").slice(0, SCRATCH_MAX_CHARS)
  } catch {
    return ""
  }
}

/** Saves the note (cut to `SCRATCH_MAX_CHARS`), written whole and renamed into place; an empty note removes the file. */
export function writeScratch(dataDir: string, sessionId: string, text: string): { ok: true } | { ok: false; error: string } {
  if (!SAFE_ID.test(sessionId)) return { ok: false, error: "[TUI]: no scratchpad for this session id" }
  const file = scratchPath(dataDir, sessionId)
  const temp = `${file}.${process.pid}.tmp`
  try {
    const note = text.replace(/\r\n?/g, "\n").slice(0, SCRATCH_MAX_CHARS)
    if (note.trim() === "") {
      fs.rmSync(file, { force: true })
      return { ok: true }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, note)
    fs.renameSync(temp, file)
    return { ok: true }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Nothing left to clean up.
    }
    return { ok: false, error: `[TUI]: could not save ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}
