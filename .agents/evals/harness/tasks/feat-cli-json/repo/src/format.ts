import type { Counts } from "./count"

export type Row = Counts & { file: string }

/** Right-aligned columns followed by the file name; a total row is added for more than one file. */
export function formatTable(rows: Row[], total: Counts): string {
  const lines = rows.map((row) => formatRow(row, row.file))
  if (rows.length > 1) lines.push(formatRow(total, "total"))
  return `${lines.join("\n")}\n`
}

function formatRow(counts: Counts, label: string): string {
  return [counts.lines, counts.words, counts.bytes].map((value) => String(value).padStart(8)).join("") + ` ${label}`
}
