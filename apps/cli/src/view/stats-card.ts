import type { SessionStats } from "@mendcode/extension-api"
import type { StatPartId } from "@mendcode/protocol/wire"
import type { Line, Span } from "../ui/theme"
import { fit, lineWidth, spread } from "./deck"
import { isStatPart, PART_BY_ID, plain } from "./stat-parts"
import { truncateEnd } from "./session-list"

/** The parts a `stats` card shows when its `text` option is empty. */
export const STATS_CARD_DEFAULT = "cache,hit,ctx,tokens,calls,spend,forecast"

/** The valid, distinct stat part ids of a comma list, in order; the card's default when the list names none. */
export function statsCardParts(list: string | undefined): StatPartId[] {
  const ids = (list ?? "").split(",").map((name) => name.trim()).filter((name, index, all): name is StatPartId => isStatPart(name) && all.indexOf(name) === index)
  return ids.length ? ids : (STATS_CARD_DEFAULT.split(",") as StatPartId[])
}

/**
 * The sidebar's `stats` card: one row per part that has a value, its label on the left and its value, coloured by the registry's
 * threshold, on the right. A value too wide for the row falls back to its short form, then is cut.
 */
export function statsCard(parts: readonly StatPartId[], stats: SessionStats, width: number): Line[] {
  const rows = parts.flatMap((id): Line[] => {
    const part = PART_BY_ID[id]
    const long = part.long(stats)
    if (!long) return []
    const room = Math.max(1, width - part.label.length - 1)
    const pieces = plain(long).length <= room ? long : part.short(stats) ?? long
    const tone = part.tone(stats)
    const value: Span[] = pieces.map((piece) => ({ text: piece.text, fg: piece.words ? "muted" : tone }))
    const clipped = lineWidth(value) > room ? [{ text: truncateEnd(plain(pieces), room), fg: tone }] : value
    return [fit(spread([{ text: part.label, fg: "text" }], clipped, width), width)]
  })
  return rows.length ? rows : [[{ text: "No model calls yet", fg: "muted" }]]
}
