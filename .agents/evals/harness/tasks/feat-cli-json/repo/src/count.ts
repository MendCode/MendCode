export type Counts = { lines: number; words: number; bytes: number }

export function countText(text: string): Counts {
  const lines = (text.match(/\n/g) ?? []).length
  const words = text.split(/\s+/).filter(Boolean).length
  return { lines, words, bytes: Buffer.byteLength(text) }
}

export function addCounts(a: Counts, b: Counts): Counts {
  return { lines: a.lines + b.lines, words: a.words + b.words, bytes: a.bytes + b.bytes }
}

export const emptyCounts: Counts = { lines: 0, words: 0, bytes: 0 }
