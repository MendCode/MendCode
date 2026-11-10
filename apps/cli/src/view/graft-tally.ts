// The tally line graft asks the model to end a reply with.
const TALLY = /\n*[ \t]*(?:\S{1,4}[ \t]+)?graft saved[ \t]+(~?[\d.,]+[kKmM]?)[ \t]+tokens?\b[^\n]*\s*$/i

// The reply without that line, and the amount it named.
export function splitGraftTally(text: string): { text: string; saved?: string } {
  const match = TALLY.exec(text)
  if (!match || match.index === 0) return { text }
  const amount = match[1]!
  return { text: text.slice(0, match.index).trimEnd(), saved: amount.startsWith("~") ? amount : `~${amount}` }
}
