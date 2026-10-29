import type { SessionStats } from "@mendcode/extension-api"
import { STAT_PART_IDS, type StatPartId } from "@mendcode/protocol/wire"
import type { ColorName, Line, Span } from "../ui/theme"
import { compact } from "./format"

/**
 * The registry of named session stats (docs/customize.md, "Session stats"). One entry per figure: its id, label, a short and a long
 * formatter and the colour it takes by threshold. The footer (`/footer`), the activity status (`activityParts`), the top bar
 * (`topbarStats`) and the sidebar's `stats` card all draw from it, so a figure reads and colours the same wherever it is placed.
 * Pure and synchronous; the numbers come from `SessionStats` (session-stats.ts).
 */

/** A piece of a formatted value: `words` are the connecting words (muted where the surface can), the rest is the figure. */
export type Piece = { text: string; words?: true }
export type StatForm = "short" | "long"

export type StatPart = {
  id: StatPartId
  /** The name the figure goes by next to its value; also the sidebar row's label. */
  label: string
  /** One sentence for the docs and `/footer` help. */
  help: string
  /** Surfaces put `label` before the value; false when the value already carries its own words (`~5 turns to compact`). */
  labelled: boolean
  /** The value in the least room, or undefined while there is nothing to say. */
  short(stats: SessionStats): Piece[] | undefined
  /** The value with its detail, for rows that have room. */
  long(stats: SessionStats): Piece[] | undefined
  /** The colour token by threshold: `success`, `text` (normal), `warning`, `error`. */
  tone(stats: SessionStats): ColorName
}

const figure = (text: string): Piece => ({ text })
const words = (text: string): Piece => ({ text, words: true })

/** Seconds with one decimal under ten, whole above. */
const seconds = (ms: number) => (ms < 9_950 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)
export const formatTtft = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : seconds(ms))
export const formatSpeed = (tokensPerSecond: number) => `${tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} tok/s`
export const formatCost = (micros: number) => (micros > 0 && micros < 10_000 ? "<$0.01" : `$${(micros / 1e6).toFixed(2)}`)

/** Green from `healthy` up, error from `errorAt` up; the share of a cache or a window is read the other way round for a cache. */
const pressure = (percent: number, warnAt: number, errorAt: number): ColorName => (percent >= errorAt ? "error" : percent >= warnAt ? "warning" : "success")
const cacheTone = (percent: number | undefined): ColorName => (percent === undefined ? "text" : percent >= 60 ? "success" : percent >= 25 ? "text" : "warning")

const PARTS: readonly StatPart[] = [
  {
    id: "cache", label: "cache", labelled: true,
    help: "share of the session's prompt tokens read from the cache; green from 60%, amber under 25%",
    short: (s) => (s.cachePercent === undefined ? undefined : [figure(`${s.cachePercent}%`)]),
    long: (s) => (s.cachePercent === undefined ? undefined : [figure(`${s.cachePercent}%`), words(` · ${compact(s.cacheRead)} of ${compact(s.input + s.cacheRead + s.cacheWrite)} read`)]),
    tone: (s) => cacheTone(s.cachePercent),
  },
  {
    id: "hit", label: "hit", labelled: true,
    help: "share of the last call's prompt read from the cache; the same colours as cache",
    short: (s) => (s.lastCachePercent === undefined ? undefined : [figure(`${s.lastCachePercent}%`)]),
    long: (s) => (s.lastCachePercent === undefined ? undefined : [figure(`${s.lastCachePercent}%`), words(` · ${compact(s.lastCacheRead ?? 0)} of ${compact(s.lastPrompt ?? 0)} last prompt`)]),
    tone: (s) => cacheTone(s.lastCachePercent),
  },
  {
    id: "ctx", label: "ctx", labelled: true,
    help: "context in use against the compaction threshold (or the engine's own window); amber from 60%, red from 85%",
    short: (s) => (s.contextPercent === undefined ? undefined : [figure(`${s.contextApprox ? "~" : ""}${s.contextPercent}%`)]),
    long: (s) => (s.contextPercent === undefined ? undefined : [figure(`${s.contextApprox ? "~" : ""}${s.contextPercent}%`), words(` · ${compact(s.contextTokens ?? 0)} of ${compact(s.contextLimit ?? 0)}`)]),
    tone: (s) => (s.contextPercent === undefined ? "text" : pressure(s.contextPercent, 60, 85)),
  },
  {
    id: "tokens", label: "tokens", labelled: false,
    help: "prompt and output tokens, with the cache reads and writes when there are any; output includes the reasoning tokens",
    short: (s) => {
      if (s.calls === 0) return undefined
      const pieces = [words("in "), figure(compact(s.input + s.cacheRead + s.cacheWrite)), words(" out "), figure(compact(s.output + s.reasoning))]
      if (s.cacheRead > 0) pieces.push(words(" cr "), figure(compact(s.cacheRead)))
      if (s.cacheWrite > 0) pieces.push(words(" cw "), figure(compact(s.cacheWrite)))
      return pieces
    },
    long: (s) => (s.calls === 0 ? undefined : [...PART_BY_ID.tokens.short(s)!, words(` · ${s.calls} call${s.calls === 1 ? "" : "s"}`)]),
    tone: () => "text",
  },
  {
    id: "think", label: "think", labelled: true,
    help: "reasoning tokens the provider reported",
    short: (s) => (s.reasoning > 0 ? [figure(compact(s.reasoning))] : undefined),
    long: (s) => (s.reasoning > 0 ? [figure(compact(s.reasoning)), words(" reasoning tokens")] : undefined),
    tone: () => "text",
  },
  {
    id: "calls", label: "calls", labelled: false,
    help: "model calls this session; a tool loop is several",
    short: (s) => (s.calls > 0 ? [figure(String(s.calls)), words(s.calls === 1 ? " call" : " calls")] : undefined),
    long: (s) => (s.calls > 0 ? [figure(String(s.calls)), words(s.calls === 1 ? " model call" : " model calls")] : undefined),
    tone: () => "text",
  },
  {
    id: "spend", label: "spend", labelled: false,
    help: "estimated cost of the session's calls, when the model has a known price",
    short: (s) => (s.costMicros === undefined ? undefined : [figure(formatCost(s.costMicros))]),
    long: (s) => (s.costMicros === undefined ? undefined : [figure(formatCost(s.costMicros)), words(" estimated")]),
    tone: () => "text",
  },
  {
    id: "tps", label: "speed", labelled: false,
    help: "output tokens per second of the last call that reported timing",
    short: (s) => (s.tokensPerSecond === undefined ? undefined : [figure(formatSpeed(s.tokensPerSecond))]),
    long: (s) => (s.tokensPerSecond === undefined ? undefined : [figure(formatSpeed(s.tokensPerSecond)), words(" on the last call")]),
    tone: () => "text",
  },
  {
    id: "ttft", label: "ttft", labelled: true,
    help: "time to the first token of the last call that reported timing; amber over 8 s",
    short: (s) => (s.firstTokenMs === undefined ? undefined : [figure(formatTtft(s.firstTokenMs))]),
    long: (s) => (s.firstTokenMs === undefined ? undefined : [figure(formatTtft(s.firstTokenMs)), words(" to the first token")]),
    tone: (s) => (s.firstTokenMs !== undefined && s.firstTokenMs > 8_000 ? "warning" : "text"),
  },
  {
    id: "effort", label: "effort", labelled: true,
    help: "reasoning effort of the session's model",
    short: (s) => (s.effort ? [figure(s.effort)] : undefined),
    long: (s) => (s.effort ? [figure(s.effort)] : undefined),
    tone: () => "text",
  },
  {
    id: "forecast", label: "forecast", labelled: false,
    help: "turns left before the context reaches the compaction threshold, from the last turns' growth; amber at 3 or fewer",
    short: (s) => (s.forecastTurns === undefined ? undefined : [figure(s.forecastTurns === 0 ? "compacts next turn" : `~${s.forecastTurns} turn${s.forecastTurns === 1 ? "" : "s"} to compact`)]),
    long: (s) => PART_BY_ID.forecast.short(s),
    tone: (s) => (s.forecastTurns !== undefined && s.forecastTurns <= 3 ? "warning" : "muted"),
  },
]

/** Every part, in the order the docs list them. */
export const STAT_PARTS: readonly StatPart[] = PARTS
export const PART_BY_ID = Object.fromEntries(PARTS.map((part) => [part.id, part])) as Record<StatPartId, StatPart>
export const isStatPart = (id: string): id is StatPartId => (STAT_PART_IDS as readonly string[]).includes(id)

export const plain = (pieces: readonly Piece[]) => pieces.map((piece) => piece.text).join("")

/**
 * One part as spans for a surface that can show two tones: the label and the connecting words muted, the figure in the part's
 * colour. `quiet` turns the neutral colour into `muted` for rows that are secondary to their surroundings (the activity status).
 */
export function partSpans(id: StatPartId, stats: SessionStats, options: { form?: StatForm; quiet?: boolean } = {}): Span[] {
  const part = PART_BY_ID[id]
  const pieces = (options.form === "long" ? part.long(stats) : part.short(stats))
  if (!pieces) return []
  const tone = part.tone(stats)
  const figureColor: ColorName = options.quiet && tone === "text" ? "muted" : tone
  return [...(part.labelled ? [{ text: `${part.label} `, fg: "muted" as const }] : []), ...pieces.map((piece): Span => ({ text: piece.text, fg: piece.words ? "muted" : figureColor }))]
}

/** The parts of `ids` that have a value now, joined by `separator`, as one line (the top bar's and the activity status's text). */
export function partsLine(ids: readonly string[], stats: SessionStats, options: { form?: StatForm; quiet?: boolean; separator?: string } = {}): Line {
  const line: Line = []
  for (const id of ids) {
    if (!isStatPart(id)) continue
    const spans = partSpans(id, stats, options)
    if (spans.length === 0) continue
    if (line.length > 0) line.push({ text: options.separator ?? "  ", fg: "muted" })
    line.push(...spans)
  }
  return line
}
