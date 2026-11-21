import type { BotListReport, BotState, SessionSummary } from "@mendcode/protocol"
import { glyphs, type ColorName, type Glyphs, type Line, type Span } from "../ui/theme"
import { botIcon } from "./bot-icon"
import { fit, spread } from "./deck"
import { relativeTime } from "./session-list"
import { sessionActivityAt } from "./session-label"
import { markSymbol, sessionMark } from "./sidebar"
import { eligibleDirectory } from "./sidebar-projects"
import { lineWidth, truncateEnd } from "./wrap"

/**
 * The left list's search (docs/sidebar.md): one index over what the terminal already holds (sessions, their folders as projects,
 * the bots), built once per change of those lists, and a query pass that allocates nothing per item. Loaded with the first `/`.
 *
 * Layout: parallel arrays, one slot per item. `lower` is the label in lower case with the same length (a char whose lower case is
 * longer stays as it is), so a position found in it marks the same char of `label`. `mask` holds one bit per letter, one for the
 * digits and five for the rest: a query whose bits are not all in an item's mask cannot match it and is skipped before any scan.
 */
export type SearchSession = Pick<SessionSummary, "sessionId" | "title" | "directory" | "updatedAt" | "state" | "queued"> & Partial<Pick<SessionSummary, "archivedAt" | "draft" | "pendingKind" | "paused" | "lifecycle" | "since">>

export type SearchSources = {
  /** Lists of sessions, the first one winning for a session in several (this terminal's own list, then the other folders'). */
  sessions: ReadonlyArray<readonly SearchSession[]>
  bots?: BotListReport | undefined
  home: string
  tmpRoots: readonly string[]
  /** `sidebarHiddenProjects`: never offered. */
  hidden?: ReadonlySet<string> | undefined
}

export const KIND_SESSION = 0
export const KIND_PROJECT = 1
export const KIND_BOT = 2
/** Results kept in rank order; the count says how many matched in all. */
export const SEARCH_TOP = 64
/** A session row id is its own id; these are the sidebar's own (view/sidebar-multi.ts). */
const GROUP = "group:"
const BOT = "bot:"
const EXTERNAL = "xbot:"

export type SearchIndex = {
  size: number
  kind: Uint8Array
  id: string[]
  label: string[]
  lower: string[]
  /** A project's folder (`~` for home) and its lower case; "" for the others. */
  path: string[]
  pathLower: string[]
  mask: Int32Array
  recency: Float64Array
  session: Array<SearchSession | undefined>
  botState: Array<BotState | undefined>
  botLook: Array<Partial<BotListReport["bots"][number]["identity"]> | undefined>
  /** Origin of a bot, for the detail line. */
  note: string[]
  /** Scratch of the last query, reused: the matching items (`hits`, `hitCount`), each one's score, and the best `SEARCH_TOP` in order. */
  hits: Int32Array
  hitCount: number
  score: Int32Array
  top: Int32Array
  topCount: number
  /** The query `hits` answers; undefined before the first. */
  query: string | undefined
}

/** Lower case of the same length, so positions agree with the label. */
function lowerSameLength(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ""
  for (const char of text) { const one = char.toLowerCase(); out += one.length === char.length ? one : char }
  return out
}

function charBit(code: number): number {
  if (code >= 97 && code <= 122) return 1 << (code - 97)
  if (code >= 48 && code <= 57) return 1 << 26
  if (code === 32) return 0
  return 1 << (27 + (code % 5))
}
function maskOf(lower: string, into = 0): number {
  let mask = into
  for (let at = 0; at < lower.length; at++) mask |= charBit(lower.charCodeAt(at))
  return mask
}

const isLowerCode = (code: number) => code >= 97 && code <= 122
const isUpperCode = (code: number) => code >= 65 && code <= 90
const isWordCode = (code: number) => isLowerCode(code) || isUpperCode(code) || (code >= 48 && code <= 57) || code > 127
/** A word starts at the first char, after a char that is no letter or digit, and at a camelCase hump. */
function wordStart(raw: string, at: number): boolean {
  if (at === 0) return true
  const before = raw.charCodeAt(at - 1)
  return !isWordCode(before) || (isUpperCode(raw.charCodeAt(at)) && isLowerCode(before))
}

const baseName = (directory: string) => directory.replace(/\/+$/, "").split("/").pop() || directory

export function buildSearchIndex(sources: SearchSources): SearchIndex {
  const id: string[] = []
  const label: string[] = []
  const path: string[] = []
  const session: Array<SearchSession | undefined> = []
  const botState: Array<BotState | undefined> = []
  const botLook: SearchIndex["botLook"] = []
  const note: string[] = []
  const recency: number[] = []
  const kind: number[] = []
  const seen = new Set<string>()
  const projects = new Map<string, number>()
  const add = (item: { kind: number; id: string; label: string; recency: number; path?: string; session?: SearchSession; state?: BotState; look?: SearchIndex["botLook"][number]; note?: string }) => {
    kind.push(item.kind); id.push(item.id); label.push(item.label); recency.push(item.recency); path.push(item.path ?? "")
    session.push(item.session); botState.push(item.state); botLook.push(item.look); note.push(item.note ?? "")
  }
  const addSession = (summary: SearchSession) => {
    if (seen.has(summary.sessionId) || summary.archivedAt !== undefined) return
    seen.add(summary.sessionId)
    const at = sessionActivityAt(summary)
    const directory = summary.directory
    if (directory && !sources.hidden?.has(directory)) projects.set(directory, Math.max(projects.get(directory) ?? 0, at))
    const title = summary.title.trim()
    if (title) add({ kind: KIND_SESSION, id: summary.sessionId, label: title, recency: at, session: summary })
  }
  for (const list of sources.sessions) for (const summary of list) addSession(summary)
  for (const bot of sources.bots?.bots ?? []) {
    let latest = 0
    for (const project of bot.projects) for (const member of project.sessions) {
      latest = Math.max(latest, member.updatedAt)
      addSession({ sessionId: member.sessionId, title: member.title, directory: project.directory, updatedAt: member.updatedAt, state: (member.status === "running" ? "generating" : "idle") as SearchSession["state"], queued: 0 })
    }
    add({ kind: KIND_BOT, id: `${BOT}${bot.name}`, label: bot.name, recency: latest, state: bot.state, look: bot.identity, note: bot.identity.origin })
  }
  for (const external of sources.bots?.external ?? []) {
    if (!external.chat) continue
    add({ kind: KIND_BOT, id: `${EXTERNAL}${external.origin}:${external.id}`, label: external.name, recency: 0, state: external.state, look: external.identity ?? { origin: external.origin }, note: external.origin })
  }
  const home = sources.home.replace(/\/+$/, "")
  for (const [directory, at] of projects) {
    if (!eligibleDirectory({ directory, home: sources.home, tmpRoots: sources.tmpRoots })) continue
    const shown = home && (directory === home || directory.startsWith(`${home}/`)) ? `~${directory.slice(home.length)}` : directory
    add({ kind: KIND_PROJECT, id: `${GROUP}${directory}`, label: baseName(directory), recency: at, path: shown })
  }
  const size = id.length
  const lower = label.map(lowerSameLength)
  const pathLower = path.map(lowerSameLength)
  const mask = new Int32Array(size)
  for (let at = 0; at < size; at++) mask[at] = maskOf(pathLower[at]!, maskOf(lower[at]!))
  return {
    size, kind: Uint8Array.from(kind), id, label, lower, path, pathLower, mask, recency: Float64Array.from(recency), session, botState, botLook, note,
    hits: new Int32Array(size), hitCount: 0, score: new Int32Array(size), top: new Int32Array(Math.min(SEARCH_TOP, size)), topCount: 0, query: undefined,
  }
}

const TIER_PREFIX = 4
const TIER_WORD = 3
const TIER_INSIDE = 2
const TIER_SCATTERED = 1
const SUB = 65535
const packed = (tier: number, sub: number) => (tier << 16) | Math.max(0, Math.min(SUB, sub))

/**
 * How well `query` matches `hay` (the lower case, or the label itself for an exact query); 0 for no match. Higher tiers win:
 * a prefix (shorter labels first), a run at a word start, a run inside a word (earlier first), then the chars in order with the
 * fewest gaps and the most word starts. Spaces in the query are skipped for the scattered match.
 */
function rankIn(hay: string, raw: string, query: string, scattered: boolean): number {
  const n = query.length
  const m = hay.length
  if (n > m) return 0
  let at = hay.indexOf(query)
  if (at === 0) return packed(TIER_PREFIX, SUB - m)
  if (at > 0) {
    const first = at
    while (at > 0) {
      if (wordStart(raw, at)) return packed(TIER_WORD, SUB - at)
      at = hay.indexOf(query, at + 1)
    }
    return packed(TIER_INSIDE, SUB - first)
  }
  if (!scattered) return 0
  let from = 0
  let begin = -1
  let end = 0
  let starts = 0
  for (let index = 0; index < n; index++) {
    const code = query.charCodeAt(index)
    if (code === 32) continue
    while (from < m && hay.charCodeAt(from) !== code) from++
    if (from === m) return 0
    if (begin < 0) begin = from
    if (wordStart(raw, from)) starts++
    end = from++
  }
  return begin < 0 ? 0 : packed(TIER_SCATTERED, 32768 + starts * 512 - (end - begin) * 8 - begin)
}

/** An item's score: its label first; a project's path also matches as a run, one step below the label's own tier. */
function scoreOf(index: SearchIndex, item: number, query: string, exact: boolean): number {
  const label = index.label[item]!
  const own = rankIn(exact ? label : index.lower[item]!, label, query, true)
  const ownTier = own >>> 16
  let best = own ? packed(ownTier * 2 + 1, own & SUB) : 0
  const path = index.path[item]!
  if (path && ownTier < TIER_PREFIX) {
    const other = rankIn(exact ? path : index.pathLower[item]!, path, query, false)
    if (other && packed((other >>> 16) * 2, other & SUB) > best) best = packed((other >>> 16) * 2, other & SUB)
  }
  return best
}

const better = (index: SearchIndex, a: number, b: number) => index.score[a]! > index.score[b]! || (index.score[a] === index.score[b] && index.recency[a]! > index.recency[b]!)

/**
 * Runs `query` over the index into its scratch arrays: `hitCount` items match, `top[0..topCount)` are the best in order. A query
 * that extends the previous one only rescans the previous matches. Nothing is allocated per item.
 */
export function runSearch(index: SearchIndex, query: string): void {
  const lowerQuery = query.toLowerCase()
  // Smart case: a query with an uppercase letter matches the label's own case.
  const exact = lowerQuery !== query
  const needle = exact ? query : lowerQuery
  let qmask = 0
  for (let at = 0; at < lowerQuery.length; at++) qmask |= charBit(lowerQuery.charCodeAt(at))
  const narrowing = index.query !== undefined && index.query.length > 0 && query.startsWith(index.query)
  const scan = narrowing ? index.hitCount : index.size
  const { hits, score, mask } = index
  let count = 0
  for (let k = 0; k < scan; k++) {
    const item = narrowing ? hits[k]! : k
    if (needle.length) {
      if ((qmask & ~mask[item]!) !== 0) continue
      const value = scoreOf(index, item, needle, exact)
      if (!value) continue
      score[item] = value
    } else score[item] = 1
    hits[count++] = item
  }
  index.hitCount = count
  index.query = query
  // The best few by insertion: a short array, so a match that does not beat the last one costs one comparison.
  const top = index.top
  const cap = top.length
  let size = 0
  for (let k = 0; k < count; k++) {
    const item = hits[k]!
    if (size === cap && !better(index, item, top[cap - 1]!)) continue
    let at = size < cap ? size++ : cap - 1
    while (at > 0 && better(index, item, top[at - 1]!)) { top[at] = top[at - 1]!; at-- }
    top[at] = item
  }
  index.topCount = size
}

/** The ids of the kept results, best first (tests and the controller's lookups; drawing reads `top` directly). */
export function resultIds(index: SearchIndex): string[] {
  const out: string[] = []
  for (let at = 0; at < index.topCount; at++) out.push(index.id[index.top[at]!]!)
  return out
}

/** The positions of `text` that `query` matched (same rules and smart case as the search); undefined when it does not match. */
export function matchPositions(text: string, query: string): number[] | undefined {
  if (!query) return []
  const exact = query.toLowerCase() !== query
  const hay = exact ? text : lowerSameLength(text)
  let at = hay.indexOf(query)
  if (at >= 0) {
    for (let next = at; next > 0; next = hay.indexOf(query, next + 1)) if (wordStart(text, next)) { at = next; break }
    return Array.from({ length: query.length }, (_, offset) => at + offset)
  }
  const out: number[] = []
  let from = 0
  for (let index = 0; index < query.length; index++) {
    const code = query.charCodeAt(index)
    if (code === 32) continue
    while (from < hay.length && hay.charCodeAt(from) !== code) from++
    if (from === hay.length) return undefined
    out.push(from++)
  }
  return out
}

export type SearchDraw = {
  index: SearchIndex
  query: string
  /** Position in the kept results. */
  selected: number
  width: number
  height: number
  now: number
  current: string
  ascii?: boolean | undefined
  spinner?: string | undefined
  glyphs?: Glyphs | undefined
}

const PAD_X = 2
const HIT: Pick<Span, "fg" | "bold" | "underline"> = { fg: "primary", bold: true, underline: true }

/** `label` cut to `room` cells with the matched chars marked. */
function marked(label: string, query: string, room: number, fg: ColorName, bold: boolean): Line {
  const cut = truncateEnd(label, room)
  const kept = cut === label ? label.length : Math.max(0, cut.length - 1)
  const positions = matchPositions(label, query) ?? []
  const out: Line = []
  let run = ""
  let runHit = false
  let next = 0
  for (let at = 0; at < kept; at++) {
    while (next < positions.length && positions[next]! < at) next++
    const hit = positions[next] === at
    if (hit !== runHit && run) { out.push(runHit ? { text: run, ...HIT } : { text: run, fg, ...(bold ? { bold } : {}) }); run = "" }
    runHit = hit
    run += label[at]
  }
  if (run) out.push(runHit ? { text: run, ...HIT } : { text: run, fg, ...(bold ? { bold } : {}) })
  if (kept < label.length) out.push({ text: "…", fg })
  return out
}

const STATE_WORD: Record<BotState, string> = { working: "working", idle: "idle", waiting: "waiting", problem: "problem" }
const STATE_FG: Record<BotState, ColorName> = { working: "primary", idle: "muted", waiting: "warning", problem: "error" }
const STATE_MARK: Record<BotState, readonly [string, string]> = { working: ["●", "*"], idle: ["◌", "o"], waiting: ["…", "~"], problem: ["!", "!"] }

/** One result row: its mark (a session's state, a project's fold glyph, a bot's icon), the marked label and what it is on the right. */
function resultRow(input: SearchDraw, item: number, inner: number, picked: boolean): Line {
  const { index, ascii } = input
  const g = input.glyphs ?? glyphs()
  const label = index.label[item]!
  const kind = index.kind[item]
  let before: Line
  let right: Line
  if (kind === KIND_SESSION) {
    const summary = index.session[item]!
    const value = sessionMark(summary as never, false)
    const symbol = markSymbol(value, { g, spinner: input.spinner, ascii })
    before = [{ ...symbol, text: `${symbol.text} ` }]
    right = [{ text: relativeTime(input.now, sessionActivityAt(summary)), fg: "muted" }]
  } else if (kind === KIND_PROJECT) {
    before = [{ text: ascii ? "> " : "▸ ", fg: "muted" }]
    right = [{ text: "project", fg: "muted" }]
  } else {
    const look = index.botLook[item] ?? {}
    const icon = botIcon({ name: label, shape: look.shape, color: look.color, ascii })
    before = [{ text: ascii ? `${icon.text} ` : icon.text, fg: icon.fg }]
    const state = index.botState[item] ?? "idle"
    right = [{ text: `${ascii ? STATE_MARK[state][1] : STATE_MARK[state][0]} ${STATE_WORD[state]}`, fg: STATE_FG[state] }]
  }
  const room = Math.max(3, inner - lineWidth(before) - lineWidth(right) - 2)
  return spread([...before, ...marked(label, input.query, room, "text", picked)], right, inner)
}

/** What the selected result is, under the list: a session's folder and age, a project's path, a bot's origin. */
function detailOf(input: SearchDraw, item: number): string {
  const { index } = input
  const kind = index.kind[item]
  if (kind === KIND_PROJECT) return `${index.path[item]} · ↵ new chat`
  if (kind === KIND_BOT) return `${index.note[item] || "bot"} · ↵ new chat`
  const summary = index.session[item]!
  return `${baseName(summary.directory)} · ${relativeTime(input.now, sessionActivityAt(summary))}`
}

/** The sidebar while searching: exactly `height` rows of `width` cells, the field on top, closed by the rule like the list. */
export function renderSidebarSearch(input: SearchDraw): { rows: Line[]; hits: Array<{ row: number; id: string }> } {
  const { index, width, height } = input
  const inner = Math.max(1, width - 1 - PAD_X - 2)
  const body: Array<{ line: Line; lead?: Line; fill?: boolean }> = []
  const count = index.topCount < index.hitCount ? `${index.topCount}/${index.hitCount}` : String(index.hitCount)
  const field: Line = [{ text: "/ ", fg: "muted" }, { text: input.query, fg: "text" }, { text: " ", bg: "primary" }]
  body.push({ line: spread(field, [{ text: input.query && !index.hitCount ? "0" : count, fg: input.query && !index.hitCount ? "warning" : "muted" }], inner) })
  body.push({ line: [{ text: "↑↓ move  ↵ open  esc back", fg: "muted" }] })
  body.push({ line: [] })
  const hits: Array<{ row: number; id: string }> = []
  const detailRows = 2
  const room = Math.max(1, height - body.length - detailRows)
  if (!index.topCount) body.push({ line: [{ text: input.query ? "No match" : "Nothing to find yet", fg: "muted" }] })
  const selected = Math.max(0, Math.min(input.selected, index.topCount - 1))
  const more = index.hitCount > index.topCount
  const shownRoom = more ? Math.max(1, room - 1) : room
  const start = Math.max(0, Math.min(selected - shownRoom + 1, index.topCount - shownRoom))
  const end = Math.min(index.topCount, start + shownRoom)
  for (let at = start; at < end; at++) {
    const item = index.top[at]!
    const picked = at === selected
    const isCurrent = index.id[item] === input.current
    hits.push({ row: body.length, id: index.id[item]! })
    body.push({ line: resultRow(input, item, inner, picked), lead: picked ? [{ text: input.ascii ? ">" : "›", fg: "muted" }, { text: " " }] : isCurrent ? [{ text: "▌", fg: "primary" }, { text: " " }] : [{ text: "  " }], ...(picked ? { fill: true } : {}) })
  }
  if (more && end === index.topCount) body.push({ line: [{ text: `+ ${index.hitCount - index.topCount} more · type to narrow`, fg: "muted" }] })
  while (body.length < height - detailRows) body.push({ line: [] })
  if (index.topCount && height > body.length) body.push({ line: [] }, { line: [{ text: truncateEnd(detailOf(input, index.top[selected]!), inner), fg: "muted" }] })
  const rows = body.slice(0, height).map(({ line, lead, fill }): Line => {
    const row: Line = [{ text: " " }, ...(lead ?? [{ text: " ".repeat(PAD_X) }]), ...fit(line, inner), { text: " ", fg: "muted" }]
    return [...(fill ? row.map((span) => ({ ...span, bg: "element" as const })) : row), { text: "│", fg: "border" }]
  })
  while (rows.length < height) rows.push([{ text: " ".repeat(width - 1) }, { text: "│", fg: "border" }])
  return { rows, hits: hits.filter((hit) => hit.row < height) }
}
