/**
 * Pasted secrets reach the transcript as markers (`‹secret:N›`, docs/secrets.md). The terminal draws each one as
 * `‹secret ··<tail>›` with the last characters `secrets.list` reports, so two markers of one session tell apart by sight.
 * Never the value: that only comes from `secrets.reveal`, on the /secrets page.
 */

const MARKER = /‹secret:(\d{1,6})›/g

export const hasSecretMarker = (text: string) => text.includes("‹secret:")

/** The marker numbers mentioned in `text`. */
export function secretMarkers(text: string): number[] {
  if (!hasSecretMarker(text)) return []
  return [...text.matchAll(MARKER)].map((match) => Number(match[1]))
}

/** `‹secret ··a1b2›` for one marker. */
export const maskedMarker = (tail: string) => `‹secret ··${tail}›`

/** Every marker whose tail is known drawn as `‹secret ··<tail>›`; the others stay as written. */
export function maskSecretMarkers(text: string, tail: (n: number) => string | undefined): string {
  if (!hasSecretMarker(text)) return text
  return text.replace(MARKER, (marker, n: string) => {
    const known = tail(Number(n))
    return known === undefined ? marker : maskedMarker(known)
  })
}
