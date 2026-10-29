import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { killProcessTree } from "@mendcode/tools"
import { projectRelative } from "./query"

export const JG_TIMEOUT_MS = 60_000
const STDOUT_CAP = 512 * 1024
const STDERR_CAP = 4096

/** Provider keys jg may use; passed only when the user's own environment already has them. */
export const JG_ENV_KEYS = ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY"] as const

export function jgEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ["PATH", "HOME", ...JG_ENV_KEYS]) {
    const value = source[key]
    if (value !== undefined && value !== "") env[key] = value
  }
  return env
}

export type JgOutcome = { kind: "ok"; stdout: string } | { kind: "failed"; reason: string } | { kind: "aborted" }

async function readCapped({ stream, cap, onCap }: { stream: ReadableStream<Uint8Array>; cap: number; onCap?: (() => void) | undefined }): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let capped = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (capped) continue
      chunks.push(value)
      total += value.length
      if (total >= cap) {
        capped = true
        onCap?.()
      }
    }
  } catch {
    // the pipe closed under us (the process was killed); what arrived is enough
  }
  return Buffer.concat(chunks).subarray(0, cap).toString("utf8")
}

/**
 * Runs `jg <query> <path>` in its own process group with a minimal environment. The group is killed on
 * timeout, on `signal` abort and once the output cap is reached, so no grandchild outlives the call.
 */
export async function runJg({
  bin,
  query,
  path,
  cwd,
  signal,
  timeoutMs,
}: {
  bin: string
  query: string
  path: string
  cwd: string
  signal: AbortSignal
  timeoutMs: number
}): Promise<JgOutcome> {
  if (signal.aborted) return { kind: "aborted" }
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    proc = Bun.spawn([bin, query, path], { cwd, env: jgEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
  } catch (error) {
    return { kind: "failed", reason: `cannot run jg: ${error instanceof Error ? error.message : String(error)}` }
  }
  const kill = () => killProcessTree({ pid: proc.pid, signal: "SIGKILL", fallback: (name) => { try { proc.kill(name) } catch { /* already gone */ } } })
  let timedOut = false
  let wasAborted = false
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutMs)
  const onAbort = () => {
    wasAborted = true
    kill()
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    const [stdout, stderr, code] = await Promise.all([
      readCapped({ stream: proc.stdout, cap: STDOUT_CAP, onCap: kill }),
      readCapped({ stream: proc.stderr, cap: STDERR_CAP }),
      proc.exited,
    ])
    if (wasAborted || signal.aborted) return { kind: "aborted" }
    if (timedOut) return { kind: "failed", reason: `jg timed out after ${Math.round(timeoutMs / 1000)} s` }
    if (stdout.length >= STDOUT_CAP) return { kind: "ok", stdout }
    if (code !== 0) return { kind: "failed", reason: `jg exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}` }
    if (stdout.trim() === "") return { kind: "failed", reason: "jg returned no output" }
    return { kind: "ok", stdout }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
    kill()
  }
}

export type JgHit = { path: string; line: number; text: string }
export type JgResult = { summary: string; hits: JgHit[] }

const ANSI = /\x1b\[[0-9;]*m/g
const HIT = /^\s*(?:[-*>•]\s+)?(?:\d+[.)]\s+)?((?:[A-Za-z]:)?[^\s:]+?\.[A-Za-z0-9_]+|[^\s:]*\/[^\s:]+):(\d+)(?:-\d+)?(?::\d+)?(?:[:\s]+(.*))?$/

/** jg prints plain text: prose lines are the summary, `path:line[:col] text` lines are hits. */
export function parseJgOutput({ text, cwd }: { text: string; cwd: string }): JgResult {
  const summary: string[] = []
  const hits: JgHit[] = []
  for (const raw of text.replace(ANSI, "").split("\n")) {
    const line = raw.trimEnd()
    if (line.trim() === "" || /^[-=─━_*\s]{3,}$/.test(line)) continue
    const match = HIT.exec(line)
    if (!match) {
      summary.push(line.trim())
      continue
    }
    const rel = projectRelative({ cwd, input: match[1] as string })
    hits.push({ path: rel === undefined || rel === "" ? (match[1] as string) : rel, line: Number(match[2]), text: (match[3] ?? "").trim().slice(0, 200) })
  }
  return { summary: summary.join("\n").slice(0, 1500), hits }
}

/** Case-insensitive literal search over `files` (project-relative), stopping at `limit` hits or on abort. */
export async function literalSearch({
  cwd,
  files,
  needles,
  limit,
  signal,
}: {
  cwd: string
  files: string[]
  needles: string[]
  limit: number
  signal: AbortSignal
}): Promise<JgHit[]> {
  const lowered = needles.map((needle) => needle.toLowerCase()).filter((needle) => needle !== "")
  const hits: JgHit[] = []
  if (lowered.length === 0) return hits
  let scanned = 0
  for (const path of files) {
    if (signal.aborted || hits.length >= limit || scanned >= 3000) break
    scanned++
    if (scanned % 50 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    const text = await readFile(join(cwd, path), "utf8").catch(() => "")
    if (text === "") continue
    const rows = text.split("\n")
    for (let i = 0; i < rows.length && hits.length < limit; i++) {
      const row = rows[i] as string
      const lower = row.toLowerCase()
      if (lowered.some((needle) => lower.includes(needle))) hits.push({ path, line: i + 1, text: row.trim().slice(0, 200) })
    }
  }
  return hits
}
