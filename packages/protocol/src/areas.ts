/**
 * Areas by folder (zod-free, shared by daemon and clients): a session belongs to the area whose folders
 * contain its directory; the most specific folder wins, and anything else is `personal`.
 */
export const DEFAULT_AREA = "personal"
export const AREA_NAME = /^[a-z][a-z0-9-]{0,23}$/

export type AreaRule = { name: string; directories: readonly string[] }

/** `~/Code/acme/*`, `~/Code/acme/` and `~/Code/acme` all mean that folder and everything under it. */
function folderOf(pattern: string, home: string | undefined): string {
  let folder = pattern.trim().replace(/\/\*{1,2}$/, "")
  if (home && (folder === "~" || folder.startsWith("~/"))) folder = home + folder.slice(1)
  return folder.length > 1 ? folder.replace(/\/+$/, "") : folder
}

export function areaFor(directory: string | undefined, areas: readonly AreaRule[] | undefined, home?: string): string {
  if (!directory || !areas?.length) return DEFAULT_AREA
  const dir = directory.length > 1 ? directory.replace(/\/+$/, "") : directory
  let best: { name: string; length: number } | undefined
  for (const area of areas)
    for (const pattern of area.directories) {
      const folder = folderOf(pattern, home)
      if (!folder) continue
      const inside = dir === folder || dir.startsWith(folder === "/" ? "/" : `${folder}/`)
      if (inside && (!best || folder.length > best.length)) best = { name: area.name, length: folder.length }
    }
  return best?.name ?? DEFAULT_AREA
}
