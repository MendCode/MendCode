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

/** `↑45.2K ↓~1,240 tokens`: sent, then received; `~` while part of it is estimated from the stream. */
export function tokensText(tokens: { input: number; output: number; estimated?: boolean }): string {
  return `${tokens.input > 0 ? `↑${compact(tokens.input)} ` : ""}↓${tokens.estimated ? "~" : ""}${compact(tokens.output)} tokens`
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
  if (current?.kind === "tool_call") return current.tool ? toolPhase(current.tool) : "Running command..."
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
  /** This turn's tokens: `input` sent and `output` received, exact per finished call; `estimated` while a call is still streaming. */
  tokens?: { input: number; output: number; estimated?: boolean }
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
  /** One part, when it has something to say: the turn's own text is `head`, the rest follows a retry too. */
  const draw = (part: ActivityPart, head: boolean) => {
    if (head && part === "spinner") addSpinner(input.stalledMs === undefined ? "text" : "warning")
    else if (head && part === "verb") add(input.phase, "text")
    else if (head && part === "elapsed" && input.elapsedMs !== undefined) add(formatElapsed(input.elapsedMs), "text")
    else if (head && part === "stalled" && input.stalledMs !== undefined) add(`no response for ${formatElapsed(input.stalledMs)}`, "warning")
    else if (part === "model" && input.model) add(input.model, "muted")
    else if (part === "tokens" && input.tokens) add(tokensText(input.tokens), "muted")
    else if (part === "tps" && input.tokensPerSecond) add(`${input.tokensPerSecond} tok/s`, "muted")
    else if (part === "queue" && input.queued) add(`${input.queued} queued`, "muted")
    else if (part === "interrupt" && input.interruptHint) add("[esc again to interrupt]", "warning")
    // The session figures of the stats registry; `tokens` and `tps` above stay this turn's own live numbers.
    else if (input.stats && isStatPart(part) && !TURN_PARTS.has(part)) {
      const spans = partSpans(part, input.stats, { quiet: true })
      if (spans.length) add(spans.map((span) => span.text).join(""), spans.find((span) => span.fg !== "muted")?.fg ?? "muted")
    }
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
  } else {
    for (const part of parts) draw(part, true)
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
