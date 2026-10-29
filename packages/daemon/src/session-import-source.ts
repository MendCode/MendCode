import { closeSync, constants, openSync, readdirSync, readSync, statSync } from "node:fs"
import { open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SESSION_IMPORT_MAX_BYTES, type SessionTranscript } from "@mendcode/protocol"
import { detectForeign, foreignTranscript, type ForeignKind } from "./session-import-foreign"

/** A foreign transcript can be long (tool output); this bounds what one import reads, before translation trims it. */
export const FOREIGN_MAX_BYTES = 64 * 1024 * 1024
const CANDIDATES = 12
const SCANNED_ROLLOUTS = 400

export type ForeignHomes = { claude?: string; codex?: string }
export const defaultHomes = (env: NodeJS.ProcessEnv = process.env): Required<ForeignHomes> => ({
  claude: env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"),
  codex: env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"),
})

/** Regular file only, no symlink at the end, bounded, decoded leniently (transcripts may carry odd bytes). */
export async function readRegular(file: string, max = FOREIGN_MAX_BYTES): Promise<{ text: string; mtime: number }> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("Import source must be a regular file")
    if (info.size > max) throw new Error(`Import exceeds ${max} bytes`)
    return { text: await handle.readFile({ encoding: "utf8" }), mtime: Math.floor(info.mtimeMs) }
  } finally { await handle.close() }
}

const safe = <T>(read: () => T[]): T[] => { try { return read() } catch { return [] } }

/** Claude Code keeps a project's sessions in `projects/<path with every non-alphanumeric character as "-">/`. */
function claudeFiles(home: string, directory: string): Array<{ file: string; kind: ForeignKind; mtime: number }> {
  const root = path.join(home, "projects", path.resolve(directory).replace(/[^a-zA-Z0-9]/g, "-"))
  return safe(() => readdirSync(root).filter((name) => name.endsWith(".jsonl")).map((name) => ({ file: path.join(root, name), kind: "claude-code" as const, mtime: statSync(path.join(root, name)).mtimeMs })))
}

/** Codex files by date; a rollout belongs to the project whose directory its first row (`session_meta`) names. */
function codexFiles(home: string, directory: string): Array<{ file: string; kind: ForeignKind; mtime: number }> {
  const root = path.join(home, "sessions")
  const wanted = path.resolve(directory)
  const sorted = (dir: string) => safe(() => readdirSync(dir)).sort().reverse()
  const out: Array<{ file: string; kind: ForeignKind; mtime: number }> = []
  let scanned = 0
  for (const year of sorted(root)) for (const month of sorted(path.join(root, year))) for (const day of sorted(path.join(root, year, month))) for (const name of sorted(path.join(root, year, month, day))) {
    if (!/^rollout-.*\.jsonl$/.test(name) || scanned >= SCANNED_ROLLOUTS) continue
    scanned++
    const file = path.join(root, year, month, day, name)
    try {
      const head = headOf(file)
      const meta = JSON.parse(head) as { type?: string; payload?: { cwd?: unknown }; cwd?: unknown }
      const cwd = meta.payload?.cwd ?? meta.cwd
      if (typeof cwd === "string" && path.resolve(cwd) === wanted) out.push({ file, kind: "codex", mtime: statSync(file).mtimeMs })
    } catch { /* unreadable or foreign first line: not ours */ }
  }
  return out
}

function headOf(file: string): string {
  const buffer = Buffer.alloc(256 * 1024)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? ""
  } finally { closeSync(fd) }
}

/** Newest first, from the tools' default locations; `from` narrows to one tool. */
export function latestCandidates({ directory, from, homes }: { directory: string; from: "auto" | ForeignKind; homes: Required<ForeignHomes> }) {
  const all = [...(from === "codex" ? [] : claudeFiles(homes.claude, directory)), ...(from === "claude-code" ? [] : codexFiles(homes.codex, directory))]
  return all.sort((a, b) => b.mtime - a.mtime).slice(0, CANDIDATES)
}

/** The transcript text becomes a `mendcode-session@1` value, or undefined when it is already native JSON. */
export function translate({ text, from, mtime, now }: { text: string; from: "auto" | "mendcode" | ForeignKind; mtime: number; now: number }): { transcript: SessionTranscript; kind: ForeignKind } | { native: unknown } {
  if (from === "auto" || from === "mendcode") {
    try {
      const whole = JSON.parse(text) as unknown
      const record = whole && typeof whole === "object" ? whole as Record<string, unknown> : undefined
      if (record && (record.format === "mendcode-session@1" || "info" in record && "messages" in record)) return { native: whole }
      if (from === "mendcode") return { native: whole }
    } catch { if (from === "mendcode") throw new Error("Invalid session JSON") }
  }
  const kind = from === "claude-code" || from === "codex" ? from : detectForeign(text)
  if (!kind && Buffer.byteLength(text) > SESSION_IMPORT_MAX_BYTES) throw new Error(`Import exceeds ${SESSION_IMPORT_MAX_BYTES} bytes`)
  if (!kind) throw new Error("Unrecognized transcript: expected mendcode-session JSON or a Claude Code / Codex JSONL file")
  return { transcript: foreignTranscript(kind, text, { fallbackAt: mtime, now }), kind }
}
