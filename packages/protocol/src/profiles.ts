/**
 * Profiles by folder (zod-free, shared by daemon and clients): a session belongs to the profile whose folders
 * contain its directory; the most specific folder wins, and anything else is `personal`.
 */
export const DEFAULT_PROFILE = "personal"
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,23}$/

export type ProfileRule = { name: string; directories: readonly string[] }

/** `~/Code/acme/*`, `~/Code/acme/` and `~/Code/acme` all mean that folder and everything under it. */
function folderOf(pattern: string, home: string | undefined): string {
  let folder = pattern.trim().replace(/\/\*{1,2}$/, "")
  if (home && (folder === "~" || folder.startsWith("~/"))) folder = home + folder.slice(1)
  return folder.length > 1 ? folder.replace(/\/+$/, "") : folder
}

export function profileFor(directory: string | undefined, profiles: readonly ProfileRule[] | undefined, home?: string): string {
  if (!directory || !profiles?.length) return DEFAULT_PROFILE
  const dir = directory.length > 1 ? directory.replace(/\/+$/, "") : directory
  let best: { name: string; length: number } | undefined
  for (const profile of profiles)
    for (const pattern of profile.directories) {
      const folder = folderOf(pattern, home)
      if (!folder) continue
      const inside = dir === folder || dir.startsWith(folder === "/" ? "/" : `${folder}/`)
      if (inside && (!best || folder.length > best.length)) best = { name: profile.name, length: folder.length }
    }
  return best?.name ?? DEFAULT_PROFILE
}
