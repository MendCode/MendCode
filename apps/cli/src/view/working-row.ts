import type { SessionStats } from "@mendcode/extension-api"
import type { ForegroundState } from "@mendcode/protocol"
import { compact } from "./format"
import { isStatPart, partSpans } from "./stat-parts"
import { ACTIVITY_PARTS_DEFAULT, type ActivityPart } from "@mendcode/protocol/wire"
import type { ColorName, Line, Span } from "../ui/theme"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"
import type { RetryState, RunningItem } from "./turn-state"

/** v1's working line above the prompt (`component/prompt/index.tsx`): spinner, phase word, elapsed time. */
const RETRY_MESSAGE_MAX = 80

/** The parts of a comma list, in order (`activityParts` after `normalizeActivityParts`). */
export const activityPartsOf = (text: string): ActivityPart[] => text.split(",").map((name) => name.trim()) as ActivityPart[]
const DEFAULT_PARTS = activityPartsOf(ACTIVITY_PARTS_DEFAULT)
/** Ids the row draws from the turn itself (this turn's output tokens and speed); the registry's session-wide version of them belongs to the other surfaces. */
const TURN_PARTS: ReadonlySet<string> = new Set(["tokens", "tps"])

/** v1's `formatDuration`: 45s · 3m 12s · 1h 5m. */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${total % 60}s`
  return `${total}s`
}

const TOOL_PHASES: ReadonlyArray<[RegExp, string]> = [
  [/^advisor\b|__advisor\b/, "Consulting advisor..."],
  [/question/, "Waiting for answer..."],
  [/^task$|subagent/, "Waiting for subagents..."],
  [/web|fetch|browser|screenshot/, "Browsing..."],
  [/test|typecheck|lint|build/, "Testing..."],
  [/patch|diff/, "Patching..."],
  [/edit|write|update|remember/, "Editing..."],
  [/read|open|cat/, "Reading..."],
  [/search|grep|glob|list|^ls$/, "Searching..."],
  [/plan/, "Planning..."],
  [/shell|bash|exec|command/, "Running command..."],
]

/** Characters of a running command the phase word keeps. */
const COMMAND_CHARS = 48

/** The phase word for a running tool: v1 matches the tool name against a few families. */
export function toolPhase(tool: string) {
  const name = tool.toLowerCase()
  return TOOL_PHASES.find(([pattern]) => pattern.test(name))?.[1] ?? "Running command..."
}

/** A turn that is generating and has produced no event for this long is called stalled. Reasoning models can think quietly for a while, so it is generous. */
export const STALL_AFTER_MS = 45_000
/**
 * A model that reasons without streaming its thinking (ChatGPT/Codex models at medium effort and up) is silent until it answers,
 * sometimes for minutes: that silence is thinking. It reads as a stall only past Codex's own stream idle limit (5 min).
 */
export const THINKING_STALL_AFTER_MS = 300_000

/**
 * How long a turn has been silent when it counts as stalled, else undefined. Only a model that is generating with no
 * tool running qualifies: a long shell command or an approval wait is not silence, and a retry has its own row.
 */
export function stalledFor(input: { state: ForegroundState; current?: RunningItem; lastEventAt?: number; now: number; retrying?: boolean; after?: number }): number | undefined {
  if (input.state !== "generating" || input.retrying || input.current?.kind === "tool_call" || input.lastEventAt === undefined) return undefined
  const silent = input.now - input.lastEventAt
  return silent >= (input.after ?? STALL_AFTER_MS) ? silent : undefined
}

/**
 * A quiet generating turn: a stall (`stalledMs`) or, for a model that reasons (`reasons`) and has no item open, thinking that
 * streams no words (`thinking`) until THINKING_STALL_AFTER_MS.
 */
export function quietTurn(input: Parameters<typeof stalledFor>[0] & { reasons: boolean }): { stalledMs?: number; thinking: boolean } {
  const { reasons, ...silence } = input
  const stalledMs = stalledFor(reasons ? { ...silence, after: THINKING_STALL_AFTER_MS } : silence)
  return { ...(stalledMs !== undefined ? { stalledMs } : {}), thinking: reasons && stalledMs === undefined && !silence.current && stalledFor(silence) !== undefined }
}

/** `88.6K` as Claude Code writes it: `88.6k`. */
const lowerUnit = (value: number) => compact(value).replace(/K$/, "k")

/**
 * The turn's tokens: what the provider reported for its model calls, exact. While a call streams, the received figure also counts what
 * arrived since the provider's last count, estimated (`estimated`), and reads `↓ ~4.3k`; the exact figure replaces it when the call reports.
 * Classic: `↑142K +1.5M cached ↓5,788 tokens`, what the turn's calls sent that the provider had not cached, then the context they resent
 * and the provider read from its prompt cache (every call resends the whole context, so a long turn's sum is mostly cache), then received.
 * Inline: `↓ 88.6k tokens`, the received figure alone unless `show` (the `activityTokens` setting) lists `in` and `cache` too.
 */
export function tokensText(tokens: { input: number; cached?: number; output: number; estimated?: boolean }, options: { style?: "inline" | "classic"; show?: readonly string[] } = {}): string {
  const inline = options.style === "inline"
  const show = options.show?.length ? options.show : inline ? ["out"] : ["in", "cache", "out"]
  const cached = Math.min(tokens.cached ?? 0, tokens.input)
  const fresh = tokens.input - cached
  const number = inline ? lowerUnit : compact
  const arrow = inline ? " " : ""
  const pieces = show.flatMap((name) =>
    name === "in" && tokens.input > 0 ? [`↑${arrow}${number(fresh)}`]
    : name === "cache" && cached > 0 ? [`+${number(cached)} cached`]
    : name === "out" ? [`↓${arrow}${tokens.estimated ? "~" : ""}${number(tokens.output)}`]
    : [])
  return `${pieces.join(" ")} tokens`
}

/** The phase word from the foreground state, the running item and whether a question or an approval waits. */
export function phaseOf(input: { state: ForegroundState; current?: RunningItem; waiting?: "question" | "approval" }): string {
  if (input.state === "waiting_approval") return input.waiting === "question" ? "Waiting for answer..." : "Waiting for approval..."
  if (input.state === "compacting") return "Compacting..."
  if (input.state === "cancelling") return "Cancelling..."
  const { current } = input
  if (!current && input.state === "tool") return "Running command..."
  if (current?.kind === "reasoning") return "Thinking..."
  if (current?.kind === "compaction") return "Compacting..."
  if (current?.kind === "tool_call" && current.writing) return "Writing..."
  if (current?.kind === "tool_call") {
    const phase = current.tool ? toolPhase(current.tool) : "Running command..."
    // A shell call says which command runs from the moment it starts.
    const command = current.tool && /^(shell|bash)$/i.test(current.tool) ? current.detail?.split("\n")[0]?.trim() : undefined
    return command ? `Running ${command.length > COMMAND_CHARS ? `${command.slice(0, COMMAND_CHARS - 1)}…` : command}...` : phase
  }
  return "Generating..."
}

/**
 * The single row above the prompt while work is going on. A provider retry replaces the phase with
 * `Retrying provider… <message> [retrying in Ns attempt #N]` in the error color; after the first Esc
 * `[esc again to interrupt]` follows in the warning color.
 */
export function renderWorkingRow(input: {
  width: number
  /** Blank cells before the spinner (v1 aligns it with the status row under the prompt). */
  margin: number
  spinner: string
  phase: string
  elapsedMs?: number
  /** This turn's tokens: `input` sent and `output` received, the provider's counts; `estimated` when `output` also holds words streamed since the last count. */
  tokens?: { input: number; cached?: number; output: number; estimated?: boolean }
  /** `inline` (the profile's default) draws the verb and then the data parts in one group, `Generating… (2m 53s · ↓ 4.3k tokens)`; `classic` (without a style) is one run of parts. */
  style?: "inline" | "classic"
  /** The figures of the `tokens` part (`activityTokens`); empty is the style's own. */
  tokenFigures?: readonly string[]
  /** Between the data parts inside the inline group. */
  groupSeparator?: string
  model?: string
  retry?: RetryState
  now: number
  interruptHint?: boolean
  /** The turn has been silent this long (see `stalledFor`): the spinner turns to the warning color and the row says so. */
  stalledMs?: number
  /** Output tokens per second so far, and prompts waiting behind this turn. */
  tokensPerSecond?: number
  queued?: number
  /** The parts to draw, in order (`activityParts`); the default is the classic row. */
  parts?: readonly ActivityPart[]
  /** The session stats the stat parts (`cache`, `ctx`…) draw from; without it they are left out. */
  stats?: SessionStats
  /** Between parts; two blanks is the classic row, a glyph is for the rows that sit on a rule. */
  separator?: string
}): Line {
  const parts = input.parts ?? DEFAULT_PARTS
  const has = (part: ActivityPart) => parts.includes(part)
  const spans: Span[] = [{ text: " ".repeat(input.margin) }]
  const separator = input.separator ?? "  "
  // What goes before the next piece: nothing at the start and after the spinner (which carries its own blank), else the separator.
  let gap = ""
  /** A blank separator stays in the part's span; a glyph is its own muted span. */
  const add = (text: string, fg: ColorName) => {
    if (gap && separator.trim()) spans.push({ text: ` ${separator} `, fg: "muted" }, { text, fg })
    else spans.push({ text: `${gap}${text}`, fg })
    gap = separator
  }
  const addSpinner = (fg: ColorName) => {
    if (gap && separator.trim()) spans.push({ text: ` ${separator} `, fg: "muted" }, { text: `${input.spinner} `, fg })
    else spans.push({ text: `${gap}${input.spinner} `, fg })
    gap = ""
  }
  const inline = (input.style ?? "classic") === "inline"
  const tokenOptions = { style: input.style ?? "classic", ...(input.tokenFigures ? { show: input.tokenFigures } : {}) } as const
  /** One part, when it has something to say: the turn's own text is `head`, the rest follows a retry too. */
  const piece = (part: ActivityPart, head: boolean): { text: string; fg: ColorName } | undefined => {
    if (head && part === "verb") return { text: inline ? input.phase.replace(/\.{3}$/, "…") : input.phase, fg: "text" }
    if (head && part === "elapsed" && input.elapsedMs !== undefined) return { text: formatElapsed(input.elapsedMs), fg: "text" }
    if (head && part === "stalled" && input.stalledMs !== undefined) return { text: `no response for ${formatElapsed(input.stalledMs)}`, fg: "warning" }
    if (part === "model" && input.model) return { text: input.model, fg: "muted" }
    if (part === "tokens" && input.tokens) return { text: tokensText(input.tokens, tokenOptions), fg: "muted" }
    if (part === "tps" && input.tokensPerSecond) return { text: `${input.tokensPerSecond} tok/s`, fg: "muted" }
    if (part === "queue" && input.queued) return { text: `${input.queued} queued`, fg: "muted" }
    if (part === "interrupt" && input.interruptHint) return { text: "[esc again to interrupt]", fg: "warning" }
    // The session figures of the stats registry; `tokens` and `tps` above stay this turn's own live numbers.
    if (input.stats && isStatPart(part) && !TURN_PARTS.has(part)) {
      const spans = partSpans(part, input.stats, { quiet: true })
      if (spans.length) return { text: spans.map((span) => span.text).join(""), fg: spans.find((span) => span.fg !== "muted")?.fg ?? "muted" }
    }
    return undefined
  }
  /** The inline style's group: the data parts between parentheses, `(2m 53s · ↓ 4.3k tokens)`; the spinner, the verb and the Esc hint stay outside it. */
  const GROUPED: ReadonlySet<ActivityPart> = new Set(["spinner", "verb", "interrupt"])
  const grouped: Array<{ text: string; fg: ColorName }> = []
  const flushGroup = () => {
    if (!grouped.length) return
    const glue = input.groupSeparator ?? (separator.trim() || "·")
    const lead = gap ? " " : ""
    const body = grouped.flatMap((each, at): Span[] => [...(at ? [{ text: ` ${glue} `, fg: "muted" as const }] : []), { text: each.text, fg: each.fg }])
    spans.push({ text: `${lead}(`, fg: "muted" }, ...body, { text: ")", fg: "muted" })
    gap = separator
    grouped.length = 0
  }
  const draw = (part: ActivityPart, head: boolean) => {
    if (head && part === "spinner") return addSpinner(input.stalledMs === undefined ? "text" : "warning")
    const found = piece(part, head)
    if (!found) return
    if (inline && !GROUPED.has(part)) return void grouped.push(found)
    if (inline && part === "interrupt") flushGroup()
    add(found.text, found.fg)
  }
  if (input.retry?.offlineSince !== undefined) {
    // The connection is down (offline, asleep): the turn is waiting, not failing, so the tone is a warning.
    const seconds = Math.max(0, Math.ceil((input.retry.nextAt - input.now) / 1000))
    const waited = formatElapsed(Math.max(0, input.now - input.retry.offlineSince))
    const lead = `${input.spinner} Offline · waiting for network · ${waited}`
    const tail = seconds > 0 ? `  [retrying in ${seconds}s]` : "  [retrying]"
    spans.push({ text: input.width - input.margin - textWidth(lead) - textWidth(tail) >= 0 ? lead : `${input.spinner} Offline · ${waited}`, fg: "warning" }, { text: tail, fg: "muted" })
    gap = separator
    for (const part of parts) draw(part, false)
    flushGroup()
  } else if (input.retry) {
    const seconds = Math.max(0, Math.ceil((input.retry.nextAt - input.now) / 1000))
    const tail = `[retrying in ${seconds}s attempt #${input.retry.attempt}]`
    const full = `${input.spinner} Retrying provider…`
    // On a narrow row the lead shortens before the countdown is cut.
    const lead = input.width - input.margin - textWidth(full) - textWidth(tail) - 1 >= 0 ? full : `${input.spinner} Retrying…`
    // The countdown always fits: the message gives way first (v1 caps it at 80 characters).
    const room = Math.min(RETRY_MESSAGE_MAX, input.width - input.margin - textWidth(lead) - textWidth(tail) - 2 - (input.interruptHint ? 25 : 0))
    const message = room >= 8 ? truncateEnd(input.retry.message.replace(/\s+/g, " ").trim(), room) : ""
    spans.push({ text: `${lead} `, fg: "error" }, ...(message ? [{ text: `${message} `, fg: "error" as const }] : []), { text: tail, fg: "error" })
    gap = separator
    for (const part of parts) draw(part, false)
    flushGroup()
  } else {
    for (const part of parts) draw(part, true)
    flushGroup()
  }
  return clip(spans, input.width)
}

function clip(spans: Span[], width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of spans) {
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

/** An extension's `working.replace` line in the working row's place: same margin, the `[esc again to interrupt]` hint kept. */
export function renderWorkingReplacement(input: { width: number; margin: number; line: Line; interruptHint?: boolean }): Line {
  const hint: Span[] = input.interruptHint ? [{ text: "  [esc again to interrupt]", fg: "warning" }] : []
  const room = Math.max(0, input.width - input.margin - textWidth(hint[0]?.text ?? ""))
  return clip([{ text: " ".repeat(input.margin) }, ...clip(input.line, room), ...hint], input.width)
}
