export type CardPriority = "high" | "normal" | "low"

/**
 * Which cards a bar shorter than its content keeps. `low` cards go first (last in the list first), then `normal` ones, but
 * only while some `high` card is there to be protected; `high` cards never go. A list with no priorities stays whole and the
 * bar scrolls. Order is kept.
 */
export function dropForHeight<T extends { priority: CardPriority; rows: number }>(cards: readonly T[], height: number): T[] {
  const kept = [...cards]
  const total = () => kept.reduce((sum, card) => sum + card.rows, 0)
  for (const level of ["low", "normal"] as const) {
    if (level === "normal" && !kept.some((card) => card.priority === "high")) break
    while (total() > height) {
      const at = kept.findLastIndex((card) => card.priority === level)
      if (at < 0) break
      kept.splice(at, 1)
    }
  }
  return kept
}
