import type { SessionDraft } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { graphemes } from "./editor"
import { labelString, sessionLabel } from "./session-label"
import { suggestionWindowStart } from "./commands"
import { textWidth } from "./wrap"

export type MentionEntry = { path: string; kind: "file" | "dir" | "resource" | "agent" | "thread" | "command"; description?: string }

const MAX_AGENT_SUGGESTIONS = 5
const MAX_THREAD_SUGGESTIONS = 5
const THREAD_PREFIX = "thread:"

/** True once the query reads `th…` or `thread:…`: only then are the project's sessions worth asking for. */
export function wantsThreads(query: string): boolean {
  const needle = query.toLowerCase()
  return needle.startsWith(THREAD_PREFIX) || (needle.length >= 2 && THREAD_PREFIX.startsWith(needle))
}

/**
 * The other sessions `@thread:` can attach, newest first as the daemon lists them. The token keeps the last 8 characters
 * of the id (the daemon resolves it inside this project) and the note shows the title. Never offered to a remote client.
 */
export function threadMentions(sessions: ReadonlyArray<{ sessionId: string; title: string; draft?: SessionDraft | undefined }> | undefined, query: string, current: string | undefined): MentionEntry[] {
  if (!wantsThreads(query)) return []
  const needle = query.toLowerCase().startsWith(THREAD_PREFIX) ? query.slice(THREAD_PREFIX.length).toLowerCase() : ""
  return (sessions ?? [])
    .filter((session) => session.sessionId !== current && (!needle || session.title.toLowerCase().includes(needle) || session.sessionId.toLowerCase().endsWith(needle)))
    .slice(0, MAX_THREAD_SUGGESTIONS)
    .map((session): MentionEntry => ({ path: `${THREAD_PREFIX}${session.sessionId.slice(-8)}`, kind: "thread", description: labelString(sessionLabel(session, { untitled: "untitled", marker: "draft" })) }))
}

/**
 * The sub-agents `@query` can address: usable, visible agents that are not primary (a primary agent runs the session, it
 * is not delegated to), names starting with the query first, then names that contain it.
 */
export function agentMentions(agents: ReadonlyArray<{ name: string; description: string; mode: string; hidden?: boolean | undefined; disable?: boolean | undefined; trusted: boolean }> | undefined, query: string): MentionEntry[] {
  const needle = query.toLowerCase()
  const usable = (agents ?? []).filter((agent) => agent.mode !== "primary" && agent.trusted && !agent.hidden && !agent.disable && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(agent.name))
  const starts = usable.filter((agent) => agent.name.toLowerCase().startsWith(needle))
  const inside = usable.filter((agent) => !agent.name.toLowerCase().startsWith(needle) && agent.name.toLowerCase().includes(needle))
  return [...starts, ...inside].slice(0, MAX_AGENT_SUGGESTIONS).map((agent): MentionEntry => ({ path: agent.name, kind: "agent", ...(agent.description ? { description: agent.description } : {}) }))
}
export type MentionToken = { start: number; query: string; slash?: true }

/**
 * `/name` typed after other text (a skill or custom command called mid-prompt): the nearest `/` before the cursor that starts a
 * word, with only name characters after it. A `/` that starts the whole prompt belongs to the slash menu; a path (`src/a`) is no token.
 */
export function findSlashToken(line: string, col: number, firstRow: boolean): MentionToken | undefined {
  const upto = graphemes(line).slice(0, Math.max(0, col))
  let start = upto.length - 1
  while (start >= 0 && /[a-z0-9:_-]/i.test(upto[start]!)) start--
  if (start < 0 || upto[start] !== "/") return undefined
  if (start > 0 && !/\s/.test(upto[start - 1]!)) return undefined
  if (firstRow && !upto.slice(0, start).join("").trim()) return undefined
  return { start, query: upto.slice(start + 1).join(""), slash: true }
}

/** The custom commands and skills a mid-prompt `/query` can name: names starting with it first, then names containing it. */
export function commandMentions(commands: ReadonlyArray<{ name: string; summary: string; custom?: true | undefined }>, query: string): MentionEntry[] {
  const needle = query.toLowerCase()
  const usable = commands.filter((command) => command.custom && command.name.toLowerCase().includes(needle))
  return [...usable.filter((command) => command.name.toLowerCase().startsWith(needle)), ...usable.filter((command) => !command.name.toLowerCase().startsWith(needle))]
    .slice(0, 50).map((command): MentionEntry => ({ path: command.name, kind: "command", ...(command.summary ? { description: command.summary } : {}) }))
}

/**
 * A prompt that names a custom command or skill after other text runs it: `explain this /review` becomes `/review explain this`,
 * so the command gets the rest of the prompt as its arguments. Only a whole `/name` word of a known command counts; paths stay text.
 */
export function hoistCommand(text: string, commands: ReadonlyArray<{ name: string; custom?: true | undefined }>): string | undefined {
  if (text.startsWith("/")) return undefined
  const names = new Set(commands.filter((command) => command.custom).map((command) => command.name.toLowerCase()))
  for (const match of text.matchAll(/(^|\s)\/([a-z0-9][a-z0-9:_-]*)(?=\s|$)/gi)) {
    if (!names.has(match[2]!.toLowerCase())) continue
    const at = match.index! + match[1]!.length
    const rest = `${text.slice(0, at)}${text.slice(at + match[2]!.length + 1)}`.replace(/[ \t]{2,}/g, " ").trim()
    return `/${match[2]!.toLowerCase()}${rest ? ` ${rest}` : ""}`
  }
  return undefined
}

const MAX_SUGGESTIONS = 8

/**
 * `@token` at the cursor on one editor row: the nearest `@` at or before `col` that starts a word (line
 * start or preceded by whitespace) with no whitespace between it and the cursor. Mirrors the slash
 * trigger (`findSlashAutocompleteTrigger` in v1) but per-row, since a mention never spans a newline.
 */
export function findMentionToken(line: string, col: number): MentionToken | undefined {
  const chars = graphemes(line)
  const upto = chars.slice(0, Math.max(0, Math.min(col, chars.length)))
  let start = -1
  for (let i = upto.length - 1; i >= 0; i--) {
    if (upto[i] === "@") {
      start = i
      break
    }
    if (/\s/.test(upto[i]!)) return undefined
  }
  if (start === -1) return undefined
  const prev = start === 0 ? undefined : upto[start - 1]
  if (prev !== undefined && !/\s/.test(prev)) return undefined
  return { start, query: upto.slice(start + 1).join("") }
}

function truncate(text: string, width: number) {
  if (textWidth(text) <= width) return text
  let out = ""
  for (const char of text) {
    if (textWidth(out + char) > width - 1) break
    out += char
  }
  return width > 0 ? `${out}…` : ""
}

/** One line per candidate: "@path" (directories get a trailing "/"), at most MAX_SUGGESTIONS in a window that follows the selection. */
export function renderMentionSuggestions(entries: MentionEntry[], width: number, selected = 0): Line[] {
  const first = suggestionWindowStart(entries.length, selected)
  return entries.slice(first, first + MAX_SUGGESTIONS).map((entry, offset) => {
    const index = first + offset
    const label = truncate(`${entry.kind === "command" ? "/" : "@"}${entry.path}${entry.kind === "dir" ? "/" : ""}`, width)
    return [index === selected ? { text: label, fg: "primary" as const, bold: true } : { text: label, fg: "text" as const }]
  })
}
