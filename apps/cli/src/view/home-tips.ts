import type { Line, Span } from "../ui/theme"

/** No built-in tips. Keep markup support for explicit home tips supplied by integrations. */
export const HOME_TIPS: readonly string[] = []

type Part = { text: string; highlight: boolean }

function parse(tip: string): Part[] {
  const parts: Part[] = []
  let last = 0
  for (const match of tip.matchAll(/\{highlight\}(.*?)\{\/highlight\}/g)) {
    const start = match.index ?? 0
    if (start > last) parts.push({ text: tip.slice(last, start), highlight: false })
    parts.push({ text: match[1]!, highlight: true })
    last = start + match[0].length
  }
  if (last < tip.length) parts.push({ text: tip.slice(last), highlight: false })
  return parts
}

/** The tip picked by `random` (0 up to 1), so a frame is reproducible. */
export function homeTip(random: number): string {
  return HOME_TIPS[Math.min(HOME_TIPS.length - 1, Math.floor(random * HOME_TIPS.length))] ?? ""
}

/** The tip's plain words, markers removed. */
export const tipText = (tip: string) => parse(tip).map((part) => part.text).join("")

/** v1's `● Tip …` row: the marker in the warning color, highlighted words in the text color. */
export function tipLine(tip: string): Line {
  const spans: Span[] = [{ text: "● Tip ", fg: "warning" }]
  for (const part of parse(tip)) spans.push({ text: part.text, fg: part.highlight ? "text" : "muted" })
  return spans
}
