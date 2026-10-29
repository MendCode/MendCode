import { DEFAULT_FOOTER, FOOTER_SEGMENTS, FOOTER_STATS, parseRowSegment, type FooterIconMode, type FooterSegment } from "@mendcode/protocol/wire"
import type { ForegroundState, GlobalEvent, Goal, PermissionMode } from "@mendcode/protocol"
import type { ColorName, Glyphs, Line, Span } from "../ui/theme"
import { quotaSegmentSpans, type QuotaStyle } from "./footer-quota"
import { EXTRA_SEGMENTS } from "./footer-segments"
import { footerIcon } from "../ui/footer-icons"
import { goalSpans } from "./goal"
import { truncateEnd } from "./session-list"
import { compact } from "./format"
import type { SessionStats } from "@mendcode/extension-api"
import { partSpans } from "./stat-parts"
import { computeSessionStats, EMPTY_USAGE } from "./session-stats"
import type { CallStats, SessionUsage } from "./usage-notes"
import { lineWidth as widthOf, textWidth } from "./wrap"

type Quota = Extract<GlobalEvent, { type: "quota.snapshot" }>

export type FooterInput = {
  segments: readonly FooterSegment[]
  width: number
  glyphs: Glyphs
  /** Label of the foreground state ("ready", "generating", "needs answer"…). */
  stateLabel: string
  state: ForegroundState
  /** The busy dot is drawn (true) or blanked (false) so it can pulse; ignored when the state is not busy. */
  dotOn: boolean
  connection: "connected" | "reconnecting" | "closed"
  permission: PermissionMode
  permissionLabel: string
  /** The profile's `showPermission`; false keeps the rows from adding the label on their own. */
  showPermission?: boolean
  /** Context tokens of the session's last model call and the compaction threshold. */
  context?: { tokens: number; threshold: number }
  model?: string
  quotas: readonly Quota[]
  /** How the `quota` segment draws: what is spent (`used`, the default) or what is left, in pressure colours or the theme's primary. */
  quotaStyle?: QuotaStyle
  /** The project directory, home-shortened (`directory`). */
  directory?: string
  /** The code graph tools: on or off for this session, and the tokens its lookups saved when the app counts them (`codegraph`). */
  codegraph?: { on: boolean; savedTokens?: number; /** The counts the daemon last pushed for this project; absent until a graph tool indexed it. */ index?: { state: "indexing" | "indexed"; files: number; symbols: number; edges: number }; /** Why this folder is not indexed (`large folder`, `no git repo`, `off`), as the daemon's gate said. */ skipped?: string }
  /** The profile's `footerText`: what `text:<name>` shows. */
  texts?: Readonly<Record<string, string | readonly string[]>>
  /** An icon before each segment (`footerIcons`); `ascii` chrome never has one. */
  icons?: { mode: FooterIconMode; ascii?: boolean }
  /** Between the windows of a named provider's quota (the profile's `statusSeparator`). */
  separator?: string
  /** Hex colours by segment name (the profile's `statusColors`), over the segment's figures. */
  colors?: Readonly<Record<string, string>>
  now: number
  today?: { tokens: number; calls: number; costMicros?: number }
  branch?: string
  /** The session's goal (docs/goals.md); its indicator shows whenever there is one, wherever `goal` sits in the order. */
  goal?: Goal
  notice: string
  /** Token totals of the session's model calls (the `cache` and `tokens` segments). */
  usage?: SessionUsage
  /** Reasoning effort of the session's model (`effort`). */
  effort?: string
  /** Adaptive reasoning (JEV) is on: a row's `effort` carries the marker (`low:JEV`). Never set for a model another engine runs, whose reasoning it owns. */
  adaptive?: boolean
  /** Priority processing (`/fast`) reaches the session's model: the `model` segment carries the lightning of its mode (`fast` without icons). */
  fast?: boolean
  /** `/fast` is on but the session's model never gets it (another engine runs it, or its provider has no priority tier): the mark says `n/a`. */
  fastIgnored?: boolean
  /** The last model calls' timings (`ttft`, `tps`) and the session's estimated spend in micro-USD (`spend`). */
  calls?: readonly CallStats[]
  spentMicros?: number
  /** Turns left before compaction (`forecast`), from the last turns' growth; absent with too little history. */
  forecast?: { turns: number }
  /** The prompt cache of the session's last call (`warm`): when it expires, the context the next message sends if it has, and when the idle compaction packs it first. */
  warm?: { expiresAt: number; tokens: number; /** Nobody states the provider's lifetime; the daemon assumes one (ChatGPT): drawn with `~`. */ assumed?: true; idleAt?: number }
  /** Background shells still running (`jobs`). */
  jobs?: number
  /** The configured sandbox mode (`sandbox`): a setting, not proof the system enforces it. */
  sandbox?: string
  /** Vim mode label while vim editing is on (`vim`). */
  vim?: string
  /** A newer release is available or installed (`update`), already worded. */
  update?: string
  /** Extension slots (`footer.left`, `footer.right`, `footer.replace`), already mapped to theme spans. */
  ext?: { left?: Line; right?: Line; replace?: Line }
  /** The session stats (session-stats.ts) the stat segments read; without it they are computed from `usage`, `calls`, `spentMicros`, `context`, `forecast` and `effort`. */
  stats?: SessionStats
}

const BUSY = new Set<ForegroundState>(["generating", "tool", "compacting", "cancelling"])
const GAP = "  "
/** State and notice are never dropped when the footer overflows. */
const KEPT = new Set<FooterSegment>(["state", "notice"])
/** When the footer overflows the lowest rank goes first, the later one of equal rank before the earlier: telemetry, then quota and spend, then branch and model, with the goal and the context last. */
const DROP_RANK: Readonly<Record<string, number>> = { ttft: 1, tps: 1, spend: 1, cache: 1, tokens: 1, update: 1, vim: 2, sandbox: 2, jobs: 2, forecast: 2, effort: 2, hit: 1, think: 1, calls: 1, ctx: 2, today: 3, cost: 3, quota: 3, branch: 4, model: 5, permission: 6, goal: 7, context: 8, codegraph: 1, time: 1, text: 1, directory: 4, warm: 2 }

export { formatCost, formatSpeed, formatTtft } from "./stat-parts"

function pressureColor(percent: number, warnAt: number, errorAt: number): ColorName {
  return percent >= errorAt ? "error" : percent >= warnAt ? "warning" : "success"
}

export { quotaText } from "./footer-quota"

/** The `quota` segment (every provider) or `quota:<provider>` (one); the rules for a stale or ended window live in footer-quota.ts. */
function quotaSpans(input: FooterInput, only?: string): Span[] {
  return quotaSegmentSpans({ quotas: input.quotas, now: input.now, style: input.quotaStyle ?? { view: "used", color: "pressure" }, glyphs: input.glyphs, width: input.width, ...(only !== undefined ? { only } : {}), ...(input.separator !== undefined ? { separator: input.separator } : {}) })
}

/** The mark of priority processing: the lightning of the footer's icon mode, or the word when there are no icons (`none`, accessible or ASCII chrome). */
export function fastMark(input: Pick<FooterInput, "icons">): string {
  return input.icons ? footerIcon({ entry: "fast", mode: input.icons.mode, ...(input.icons.ascii ? { ascii: true } : {}) }) ?? "fast" : "fast"
}

/** The spans of one segment; empty when it has nothing to show. */
export function segmentSpans(id: FooterSegment, input: FooterInput): Span[] {
  switch (id) {
    case "state": {
      const spans: Span[] = [{ text: input.stateLabel, fg: input.state === "error" ? "error" : BUSY.has(input.state) ? "text" : "muted" }]
      if (BUSY.has(input.state)) spans.push({ text: ` ${input.dotOn ? input.glyphs.running : " "}`, fg: "primary" })
      if (input.connection !== "connected") spans.push({ text: `${GAP}${input.connection === "reconnecting" ? "offline · reconnecting…" : "disconnected"}`, fg: "warning" })
      return spans
    }
    case "permission":
      return input.permission === "ask" ? [] : [{ text: input.permissionLabel, fg: input.permission === "full" ? "error" : input.permission === "plan" ? "heading" : "warning", bold: true }]
    case "context": {
      if (!input.context || input.context.threshold <= 0) return []
      const percent = Math.round((input.context.tokens / input.context.threshold) * 100)
      return [{ text: "compact ", fg: "muted" }, { text: `${percent}%`, fg: pressureColor(percent, 60, 85) }]
    }
    case "model":
      return input.model ? [{ text: input.model, fg: "muted" }, ...(input.fast ? [{ text: ` ${fastMark(input)}`, fg: "warning" as const }] : input.fastIgnored ? [{ text: ` ${fastMark(input)} n/a`, fg: "muted" as const }] : [])] : []
    case "quota":
      return quotaSpans(input)
    case "today":
      return input.today && input.today.tokens > 0 ? [{ text: "today ", fg: "muted" }, { text: compact(input.today.tokens), fg: "text" }] : []
    case "cost":
      return input.today?.costMicros ? [{ text: "cost ", fg: "muted" }, { text: `$${(input.today.costMicros / 1e6).toFixed(2)}`, fg: "text" }] : []
    case "branch":
      return input.branch ? [{ text: "git ", fg: "muted" }, { text: input.branch, fg: "body" }] : []
    case "goal":
      return input.goal ? goalSpans(input.goal, input.now, input.glyphs) : []
    case "notice":
      return input.notice ? [{ text: input.notice, fg: "warning" }] : []
    // The session figures come from the stats registry (stat-parts.ts), the same text and colours as every other surface.
    case "cache":
    case "hit":
    case "ctx":
    case "tokens":
    case "think":
    case "calls":
    case "effort":
    case "ttft":
    case "tps":
    case "spend":
    case "forecast":
      return partSpans(id, statsOf(input))
    case "jobs":
      return input.jobs ? [{ text: `${input.jobs} job${input.jobs === 1 ? "" : "s"}`, fg: "secondary" }] : []
    case "sandbox":
      return input.sandbox ? [{ text: "sandbox ", fg: "muted" }, { text: input.sandbox, fg: input.sandbox === "off" ? "warning" : "text" }] : []
    case "vim":
      return input.vim ? [{ text: input.vim, fg: "heading", bold: true }] : []
    case "update":
      return input.update ? [{ text: input.update, fg: "success" }] : []
    case "directory":
    case "codegraph":
    case "time":
    case "warm":
      return EXTRA_SEGMENTS[id]!(input, undefined)
  }
}

/**
 * A segment as a row names it (`model`, `quota:codex`, `text:tagline`): its spans, with the icon in front when `footerIcons` is on and the
 * hex colour of `statusColors` over its figures. Empty when it has nothing to show.
 */
export const entrySpans = (entry: string, input: FooterInput): Span[] => decorate(entry, entryBody(entry, input), input)

/** A segment entry's own spans, before its colour and icon. */
export function entryBody(entry: string, input: FooterInput): Span[] {
  const { id, arg } = parseRowSegment(entry)
  return id === "quota" && arg !== undefined ? quotaSpans(input, arg) : id === "text" ? EXTRA_SEGMENTS.text!(input, arg) : isSegment(id) ? segmentSpans(id, input) : []
}

/** `body` with the hex colour of `statusColors` over its figures and the icon of `footerIcons` before it. */
export function decorate(entry: string, body: Span[], input: FooterInput): Span[] {
  const { id } = parseRowSegment(entry)
  if (body.length === 0) return body
  const hex = input.colors?.[entry] ?? input.colors?.[id]
  const colored = hex ? body.map((span) => span.fg === "muted" || span.fg === "border" || span.fgHex ? span : { ...span, fgHex: hex }) : body
  const icon = input.icons ? footerIcon({ entry, mode: input.icons.mode, ...(input.icons.ascii ? { ascii: true } : {}) }) : undefined
  return icon ? [{ text: `${icon} `, fg: "primary" }, ...colored] : colored
}

/** The session stats a segment reads: the app's own (one computation per frame), else the figures this input carries. */
function statsOf(input: FooterInput): SessionStats {
  return input.stats ?? computeSessionStats({
    usage: input.usage ?? EMPTY_USAGE,
    ...(input.calls ? { calls: input.calls } : {}),
    ...(input.spentMicros !== undefined ? { costMicros: input.spentMicros } : {}),
    ...(input.context ? { contextTokens: input.context.tokens, contextLimit: input.context.threshold } : {}),
    ...(input.forecast ? { forecastTurns: input.forecast.turns } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  })
}


/**
 * One footer line of at most `width` cells. Segments follow the configured order (`notice` is always
 * included when there is one). When they do not fit, segments are dropped from the end of the order —
 * never `state` or `notice` — and the notice is truncated last.
 */
export function renderFooter(input: FooterInput): Line {
  // An extension's `footer.replace` is the whole row; `footer.left` leads it and `footer.right` ends it, both before the segments give way.
  if (input.ext?.replace) return clip(input.ext.replace, input.width)
  const left = input.ext?.left ?? []
  const right = input.ext?.right ?? []
  if (left.length > 0 || right.length > 0) return withExtensions({ input, left, right })
  return segmentsRow(input, input.width)
}

/** The row with extension spans on its sides; the built-in segments get what is left of `width`. */
function withExtensions({ input, left, right }: { input: FooterInput; left: Line; right: Line }): Line {
  const rightWidth = widthOf(right)
  // The right block and one cell before it are kept; the left block may take the rest, then the segments what remains.
  const rightRoom = rightWidth > 0 ? rightWidth + 1 : 0
  const lead = clip(left, Math.max(0, input.width - rightRoom))
  const leadRoom = lead.length > 0 ? widthOf(lead) + GAP.length : 0
  const middle = segmentsRow(input, Math.max(0, input.width - rightRoom - leadRoom))
  const row: Line = [...lead, ...(lead.length > 0 && middle.length > 0 ? [{ text: GAP }] : []), ...middle]
  if (right.length === 0) return row
  const pad = Math.max(1, input.width - widthOf(row) - rightWidth)
  return clip([...row, { text: " ".repeat(pad) }, ...right], input.width)
}

/**
 * Drops parts from `parts` (in place) until they fit `width` with `gap` cells between them: the lowest rank first, the later of equal rank
 * before the earlier, never `state` or `notice`. Returns the width of what is left, as a function so the caller can measure again.
 */
export function dropToFit(parts: Array<{ id: string; spans: Span[] }>, width: number, gap: number): () => number {
  const total = () => parts.reduce((sum, part, index) => sum + widthOf(part.spans) + (index ? gap : 0), 0)
  const rank = (part: { id: string }) => DROP_RANK[parseRowSegment(part.id).id] ?? 2
  while (total() > width) {
    const droppable = parts.filter((part) => !KEPT.has(part.id as FooterSegment))
    const lowest = Math.min(...droppable.map(rank))
    const drop = droppable.findLast((part) => rank(part) === lowest)
    if (!drop) break
    parts.splice(parts.indexOf(drop), 1)
  }
  return total
}

function segmentsRow(input: FooterInput, width: number): Line {
  const order = [...new Set(input.segments)]
  if (!order.includes("notice")) order.push("notice")
  // A goal is the session's standing task: its indicator follows the state even when the configured order leaves it out.
  if (input.goal && !order.includes("goal")) order.splice(Math.min(1, order.length), 0, "goal")
  const parts = order.map((id) => ({ id, spans: entrySpans(id, input) })).filter((part) => part.spans.length > 0)
  const total = dropToFit(parts, width, GAP.length)
  const overflow = total() - width
  const notice = parts.find((part) => part.id === "notice")
  if (overflow > 0 && notice) {
    const room = Math.max(0, widthOf(notice.spans) - overflow)
    if (room > 0) notice.spans = [{ ...notice.spans[0]!, text: truncateEnd(notice.spans[0]!.text, room) }]
    else parts.splice(parts.indexOf(notice), 1)
  }
  const line: Line = []
  parts.forEach((part, index) => {
    if (index) line.push({ text: GAP })
    line.push(...part.spans)
  })
  return clip(line, width)
}

export function clip(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}

export type FooterCommand = { ok: true; segments: FooterSegment[] } | { ok: false; error: string }

const isSegment = (id: string): id is FooterSegment => (FOOTER_SEGMENTS as readonly string[]).includes(id)

/**
 * `/footer` arguments against the current list: `reset`, `+id` / `-id` (any number), or bare ids to set the
 * exact order. Empty arguments keep the list (the caller shows it).
 */
export function parseFooterCommand(args: string, current: readonly FooterSegment[] = DEFAULT_FOOTER): FooterCommand {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { ok: true, segments: [...current] }
  if (tokens.length === 1 && tokens[0] === "reset") return { ok: true, segments: [...DEFAULT_FOOTER] }
  if (tokens.length === 1 && tokens[0] === "stats") return { ok: true, segments: [...FOOTER_STATS] }
  const valid = FOOTER_SEGMENTS.join(", ")
  const signed = tokens.some((token) => token.startsWith("+") || token.startsWith("-"))
  let segments = signed ? [...current] : []
  for (const token of tokens) {
    const id = signed ? token.replace(/^[+-]/, "") : token
    if (!isSegment(id)) return { ok: false, error: `unknown footer segment "${id}" (${valid})` }
    if (signed && !token.startsWith("+") && !token.startsWith("-")) return { ok: false, error: `use +${id} or -${id}` }
    if (token.startsWith("-")) segments = segments.filter((segment) => segment !== id)
    else if (!segments.includes(id)) segments.push(id)
  }
  return { ok: true, segments }
}
