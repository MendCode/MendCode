export type TimelineDiffStats = {
  additions: number
  deletions: number
}

export type PatchFileLike = {
  type?: unknown
  relativePath?: unknown
  filePath?: unknown
  movePath?: unknown
  additions?: unknown
  deletions?: unknown
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function diffStatsFromPatch(patch: string): TimelineDiffStats {
  let additions = 0
  let deletions = 0
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

export function diffStatsFromFile(file: PatchFileLike, patch = ""): TimelineDiffStats {
  const additions = numberValue(file.additions)
  const deletions = numberValue(file.deletions)
  if (additions !== undefined || deletions !== undefined) {
    return {
      additions: additions ?? 0,
      deletions: deletions ?? 0,
    }
  }
  return diffStatsFromPatch(patch)
}

export function formatDiffStats(stats: TimelineDiffStats) {
  const parts: string[] = []
  if (stats.additions) parts.push(`+${stats.additions}`)
  if (stats.deletions) parts.push(`-${stats.deletions}`)
  return parts.length ? `(${parts.join(" ")})` : ""
}

export function patchFilePath(file: PatchFileLike) {
  return stringValue(file.relativePath) ?? stringValue(file.movePath) ?? stringValue(file.filePath) ?? "patch"
}

export function patchFileTitle(file: PatchFileLike, patch = "") {
  const type = stringValue(file.type)
  const path = patchFilePath(file)
  const stats = formatDiffStats(diffStatsFromFile(file, patch))
  if (type === "delete") return `Deleted ${path} ${stats}`.trim()
  if (type === "add") return `Added ${path} ${stats}`.trim()
  if (type === "move") {
    const from = stringValue(file.filePath)
    return `Patched ${from ? `${from} -> ` : ""}${path} ${stats}`.trim()
  }
  return `Patched ${path} ${stats}`.trim()
}
