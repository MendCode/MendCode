import { open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { BlobRef } from "@mendcode/protocol"
import { compactText, isRealUser, recentOperationalContext } from "./compaction-context"
import type { ModelMessage } from "./provider"

/**
 * What the executor can hand the advisor on top of the automatic brief (docs/advisor.md): files by path with an optional
 * line range, images the session already holds, and a short capped summary of the session so the advisor does not judge
 * earlier work as this turn's. Every size lives here, next to the other advisor limits; nothing calls a model.
 */

export const ADVISOR_EVIDENCE_LIMITS = {
  /** Files per consultation; more are refused by the tool's schema. */
  maxFiles: 6,
  /** One file, with or without a range. */
  fileMaxLines: 300,
  fileMaxChars: 12_000,
  /** All files together (characters of the rendered text). */
  filesTotalChars: 32_000,
  /** A file larger than this is not read. */
  fileReadBytes: 1_000_000,
  /** Images per consultation. */
  maxImages: 4,
  /** The session summary block. */
  contextMaxChars: 6_000,
  contextListMax: 20,
} as const

export type AdvisorFileRef = { path: string; startLine?: number | undefined; endLine?: number | undefined }

const lineCount = (lines: readonly string[]) => (lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length)

/**
 * One file as numbered lines. A range is honoured, then the per-file line and character caps apply (and `room`, what is left
 * of the total); whatever is cut is counted in a marker that says how to ask for it.
 */
export function renderAdvisorFile({ path, text, startLine, endLine, room = ADVISOR_EVIDENCE_LIMITS.fileMaxChars }: { path: string; text: string; startLine?: number | undefined; endLine?: number | undefined; room?: number }): string {
  const lines = text.split("\n")
  const total = lineCount(lines)
  const first = Math.max(1, startLine ?? 1)
  const last = Math.min(total, Math.max(first, endLine ?? total))
  const heading = (from: number, to: number) => `### ${path} (lines ${from}-${to} of ${total})`
  if (total === 0) return `### ${path} (empty file)`
  if (first > total) return `### ${path}\n[no lines ${first}-${endLine ?? total}: the file has ${total} lines]`
  const budget = Math.min(room, ADVISOR_EVIDENCE_LIMITS.fileMaxChars)
  const body: string[] = []
  let chars = 0
  let shown = first - 1
  for (let line = first; line <= last && body.length < ADVISOR_EVIDENCE_LIMITS.fileMaxLines; line++) {
    const rendered = `${line}: ${lines[line - 1]}`
    if (chars + rendered.length + 1 > budget && body.length > 0) break
    body.push(chars + rendered.length + 1 > budget ? rendered.slice(0, Math.max(0, budget - chars - 1)) : rendered)
    chars += rendered.length + 1
    shown = line
  }
  const cut = last - shown
  const marker = cut > 0 ? `\n[${cut} lines cut (lines ${shown + 1}-${last} of ${total}); pass startLine/endLine to see them]` : ""
  return `${heading(first, shown)}\n${body.join("\n")}${marker}`
}

/** Reads `ref.path` under `cwd` (a path outside it is refused) and renders it, or says why it was not sent. */
export async function renderAdvisorFiles({ files, cwd, room = ADVISOR_EVIDENCE_LIMITS.filesTotalChars }: { files: readonly AdvisorFileRef[]; cwd: string; room?: number }): Promise<string> {
  const parts: string[] = []
  let left = room
  const sent = files.slice(0, ADVISOR_EVIDENCE_LIMITS.maxFiles)
  for (const ref of sent) {
    if (left < 400) { parts.push(`### ${ref.path}\n[not sent: the files together are capped at ${room} characters]`); continue }
    const text = await readUnder(cwd, ref.path)
    const rendered = typeof text === "string" ? renderAdvisorFile({ ...ref, text, room: left }) : `### ${ref.path}\n[not sent: ${text.problem}]`
    parts.push(rendered)
    left -= rendered.length
  }
  if (files.length > sent.length) parts.push(`[${files.length - sent.length} more files not sent: at most ${ADVISOR_EVIDENCE_LIMITS.maxFiles} per consultation]`)
  return parts.join("\n\n")
}

async function readUnder(cwd: string, path: string): Promise<string | { problem: string }> {
  try {
    const root = await realpath(cwd)
    const real = await realpath(resolve(root, path))
    const inside = relative(root, real)
    if (inside.startsWith("..") || isAbsolute(inside)) return { problem: "outside the project folder" }
    const handle = await open(real, "r")
    try {
      const size = (await handle.stat()).size
      if (size > ADVISOR_EVIDENCE_LIMITS.fileReadBytes) return { problem: `larger than ${ADVISOR_EVIDENCE_LIMITS.fileReadBytes} bytes; pass a smaller file` }
      const bytes = Buffer.alloc(size)
      await handle.read(bytes, 0, size, 0)
      return bytes.includes(0) ? { problem: "binary file" } : bytes.toString("utf8")
    } finally { await handle.close() }
  } catch { return { problem: "cannot be read" } }
}

/** Attachments of the session (user messages and the tool images the engine adds as such) that match a name or a sha256 prefix. */
export function selectAdvisorImages({ wanted, messages }: { wanted: readonly string[]; messages: readonly ModelMessage[] }): { refs: BlobRef[]; missing: string[] } {
  const known = messages.flatMap((message) => message.role === "user" ? (message.attachments ?? []).filter((ref) => ref.mime.startsWith("image/")) : [])
  const refs: BlobRef[] = []
  const missing: string[] = []
  for (const want of wanted.slice(0, ADVISOR_EVIDENCE_LIMITS.maxImages)) {
    const key = want.trim().toLowerCase()
    const found = known.findLast((ref) => ref.name?.toLowerCase() === key || (key.length >= 6 && ref.sha256.toLowerCase().startsWith(key)))
    if (found && !refs.some((ref) => ref.sha256 === found.sha256)) refs.push(found)
    else if (!found) missing.push(want)
  }
  return { refs, missing }
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
/** The native engine's command tools: `shell`, and `shell_session` whose `start` carries the command. */
const COMMAND_TOOLS = new Set(["shell", "shell_session"])
const VERIFY = /\b(test|tests|tsc|typecheck|lint|build|check|pytest|vitest|jest|cargo|go vet|mypy|ruff)\b/i

/** The files an edit, write or apply_patch call names. */
export function editedPaths(call: { args: unknown }): string[] {
  const args = call.args
  if (args === null || typeof args !== "object") return []
  const record = args as Record<string, unknown>
  const direct = ["path", "filePath", "file"].flatMap((key) => typeof record[key] === "string" ? [record[key] as string] : [])
  if (direct.length) return direct
  const patch = Object.values(record).find((value): value is string => typeof value === "string" && /^\*\*\* (?:Add|Update|Delete) File: /m.test(value))
  return patch ? [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim()) : []
}

const lines = (text: unknown) => typeof text === "string" && text ? text.split("\n").length : 0

/** How many lines an edit, write or apply_patch call changes: the larger side of each replacement, a write's content, a patch's +/- lines. */
export function changedLines(call: { name: string; args: unknown }): number {
  if (call.args === null || typeof call.args !== "object") return 0
  const record = call.args as Record<string, unknown>
  if (call.name === "write") return lines(record.content)
  if (call.name === "apply_patch") return typeof record.patch === "string" ? record.patch.split("\n").filter((line) => /^[+-]/.test(line)).length : 0
  if (call.name !== "edit") return 0
  const pairs = [{ oldString: record.oldString, newString: record.newString }, ...(Array.isArray(record.edits) ? record.edits as Array<Record<string, unknown>> : [])]
  return pairs.reduce((total, pair) => total + Math.max(lines(pair.oldString), lines(pair.newString)), 0)
}

/**
 * A short block placed ahead of the transcript: how many requests came before this turn's, which files earlier turns
 * edited and which this turn did (so the diff is read in that light), and this turn's verification runs with their
 * results. Built from the messages already in hand, with the compaction module's operational-context builder.
 */
export function advisorSessionContext({ messages, requestIndex }: { messages: readonly ModelMessage[]; requestIndex: number }): string {
  const turnStart = Math.max(0, requestIndex)
  const results = new Map(messages.flatMap((message) => message.role === "tool" ? [[message.callId, message] as const] : []))
  const earlier: string[] = []
  const now: string[] = []
  const checks: ModelMessage[] = []
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return
    const inTurn = index >= turnStart
    const verification = message.toolCalls.filter((call) => COMMAND_TOOLS.has(call.name) && VERIFY.test(String((call.args as { command?: unknown } | null)?.command ?? "")))
    for (const call of message.toolCalls) {
      if (!EDIT_TOOLS.has(call.name) || results.get(call.callId)?.isError) continue
      for (const path of editedPaths(call)) { const list = inTurn ? now : earlier; if (!list.includes(path)) list.push(path) }
    }
    if (inTurn && verification.length) checks.push({ ...message, content: "", toolCalls: verification }, ...verification.flatMap((call) => results.get(call.callId) ?? []))
  })
  const priorRequests = messages.slice(0, turnStart).filter(isRealUser).length
  const listed = (paths: readonly string[]) => paths.length ? `${paths.slice(0, ADVISOR_EVIDENCE_LIMITS.contextListMax).join(", ")}${paths.length > ADVISOR_EVIDENCE_LIMITS.contextListMax ? ` (+${paths.length - ADVISOR_EVIDENCE_LIMITS.contextListMax} more)` : ""}` : "none"
  const compacted = messages.slice(0, turnStart).some((message) => message.role === "user" && !isRealUser(message))
  const operational = recentOperationalContext(checks)[0]?.split("\n\nUse this as")[0]?.replace(/^Recent Operational Context:/, "This turn's verification runs:")
  return compactText([
    `Earlier requests in this session: ${priorRequests}${compacted ? " (older history was compacted and is not repeated here)" : ""}. The diff below is the whole working tree against HEAD: it can hold changes from earlier turns or other sources, and untracked files are listed apart from it.`,
    `Files edited by the executor in earlier turns: ${listed(earlier)}`,
    `Files edited by the executor in this turn: ${listed(now)}`,
    operational ?? "This turn's verification runs: none recorded.",
  ].join("\n"), ADVISOR_EVIDENCE_LIMITS.contextMaxChars)
}
