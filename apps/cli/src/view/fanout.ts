export type FanoutRow = { sessionId: string; model: string; directory: string; branch: string; state?: string; summary?: string; error?: string }

/** Explicit quoting keeps a model name out of the prompt and rejects an accidental one-session run. */
export function parseFanout(args: string): { prompt: string; models: string[] } | undefined {
  const match = /^("(?:\\.|[^"\\])*")\s+(.+)$/.exec(args.trim())
  if (!match) return undefined
  let prompt: string
  try { prompt = JSON.parse(match[1]!) } catch { return undefined }
  const models = match[2]!.trim().split(/\s+/)
  return prompt.trim() && prompt.length <= 8000 && models.length >= 2 && models.length <= 8 ? { prompt, models } : undefined
}

export const fanoutSections = (rows: FanoutRow[]) => rows.length ? rows.map((row, index) => ({ heading: `${index + 1}. ${row.model}`, note: row.state ?? "idle", lines: [row.branch, row.error ?? row.summary ?? "No summary yet", `/fanout open ${index + 1} · /fanout changes ${index + 1}`] })) : [{ lines: ["No fan-out yet", '/fanout "prompt" modelA modelB'] }]
