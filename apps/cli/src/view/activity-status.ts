import { ACTIVITY_PARTS, ACTIVITY_PARTS_DEFAULT, type ActivityPart } from "@mendcode/protocol/wire"
import type { Line } from "../ui/theme"
import { overlayAt } from "./scroll-chrome"
import { PART_BY_ID } from "./stat-parts"
import { textWidth } from "./wrap"

/**
 * The activity status when it is not a row of its own (`activityPlacement` `above` or `inside`): the working row's parts drawn over
 * the prompt's own chrome, so a turn starting or ending moves nothing. See docs/customize.md, "Activity status".
 */

/** Fewest cells worth drawing the status in; narrower than this it is left out rather than cut to a spinner. */
export const ACTIVITY_MIN_CELLS = 8

/** Cells free for a label that ends at `right` on a prompt row whose text ends at `contentEnd`, with two blanks between them. */
export const insideRoom = (contentEnd: number, right: number) => right - contentEnd - 2

/** `label` right-aligned so it ends at `right` on the prompt row `row` (`width` cells); the typed text and the cursor stay where they are. */
export function placeInside({ row, width, right, label }: { row: Line; width: number; right: number; label: Line }): Line {
  const labelWidth = label.reduce((sum, span) => sum + textWidth(span.text), 0)
  if (!labelWidth) return row
  // A tinted prompt keeps its fill under the label.
  const fill = row.find((span) => span.bg)?.bg
  const tinted = fill ? label.map((span) => ({ ...span, bg: fill })) : label
  return overlayAt({ line: row, width, from: right - labelWidth, label: tinted }) ?? row
}

const PLACEMENTS = ["transcript", "above", "inside", "off"] as const

/**
 * `/activity` arguments: a placement word, or the parts as `/footer` takes its segments (`reset`, `+id` / `-id`, or bare ids for the exact
 * order). No arguments is an empty patch: the caller opens the page.
 */
export function parseActivityCommand(args: string, current: string): { ok: true; patch: { activityPlacement?: (typeof PLACEMENTS)[number]; activityParts?: string } } | { ok: false; error: string } {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { ok: true, patch: {} }
  const placement = PLACEMENTS.find((name) => name === tokens[0])
  if (tokens.length === 1 && placement) return { ok: true, patch: { activityPlacement: placement } }
  if (tokens.length === 1 && tokens[0] === "reset") return { ok: true, patch: { activityParts: ACTIVITY_PARTS_DEFAULT } }
  const valid = ACTIVITY_PARTS.join(", ")
  const signed = tokens.some((token) => token.startsWith("+") || token.startsWith("-"))
  let parts: string[] = signed ? current.split(",").map((name) => name.trim()).filter(Boolean) : []
  for (const token of tokens) {
    const id = signed ? token.replace(/^[+-]/, "") : token
    if (!(ACTIVITY_PARTS as readonly string[]).includes(id)) return { ok: false, error: `usage: /activity ${PLACEMENTS.join("|")} | reset | +part -part | parts in order (${valid})` }
    if (signed && !token.startsWith("+") && !token.startsWith("-")) return { ok: false, error: `use +${id} or -${id}` }
    if (token.startsWith("-")) parts = parts.filter((part) => part !== id)
    else if (!parts.includes(id)) parts.push(id)
  }
  return { ok: true, patch: { activityParts: parts.length ? parts.join(",") : ACTIVITY_PARTS_DEFAULT } }
}

/** One line per part, for `/activity` and the docs. */
export const ACTIVITY_PART_HELP: Readonly<Record<ActivityPart, string>> = {
  spinner: "the spinner",
  verb: "what it is doing (Generating..., Running command...)",
  elapsed: "time since the turn started",
  stalled: "no response for ... after 45 s of silence",
  model: "the model (needs Activity model on)",
  tokens: "tokens sent (↑) and received (↓) this turn, ~ while estimated",
  tps: "output tokens per second",
  queue: "prompts waiting behind this turn",
  interrupt: "[esc again to interrupt] after the first Esc",
  // The session figures of the stats registry; `tokens` and `tps` above stay this turn's own numbers.
  cache: PART_BY_ID.cache.help,
  hit: PART_BY_ID.hit.help,
  ctx: PART_BY_ID.ctx.help,
  think: PART_BY_ID.think.help,
  calls: PART_BY_ID.calls.help,
  spend: PART_BY_ID.spend.help,
  ttft: PART_BY_ID.ttft.help,
  effort: PART_BY_ID.effort.help,
  forecast: PART_BY_ID.forecast.help,
}
