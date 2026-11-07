import fs from "node:fs"
import path from "node:path"
import changelogFile from "../../../CHANGELOG.md" with { type: "file" }
import { NOTE_GROUPS, parseChangelog, plainItem, type ChangelogSection } from "@mendcode/protocol/changelog"
import { channelOfVersion, compareSemver, MOVING_NIGHTLY_TAG, parseVersion } from "@mendcode/upgrade/releases"
import { UPGRADE_REPO } from "@mendcode/upgrade/settings"

/**
 * What changed in MendCode, read from the CHANGELOG.md packed into the build (no network), for `/changelog` and `/whatsnew`
 * (docs/whats-new.md). The terminal remembers what it showed in `<dataDir>/tui/changelog-seen`: the newest version section and
 * the items of `## Unreleased` (a nightly's changes have no version of their own), so the next look marks only what is new.
 * Loaded on first use: nothing here runs at start-up.
 */

/** A section as the pages show it: `## Unreleased` names the running build, the others their tag and date. */
export type ChangelogEntry = ChangelogSection & { title: string }
/** What the terminal showed last. `date` is the marker of the older hand-kept list (a date), read as "every section up to that day". */
export type ChangelogSeen = { version?: string | undefined; date?: string | undefined; unreleased: string[] }

const MAX_SEEN_ITEMS = 500

/** The sections of the bundled CHANGELOG.md, newest first, without empty ones; a file the parser refuses throws. */
export function bundledChangelog(version?: string): ChangelogEntry[] {
  return changelogEntries(fs.readFileSync(changelogFile, "utf8"), version)
}

export function changelogEntries(text: string, version?: string): ChangelogEntry[] {
  return [...parseChangelog(text).values()]
    .filter((section) => NOTE_GROUPS.some((group) => section.items[group].length))
    .map((section) => ({ ...section, title: section.name === "Unreleased" ? `Unreleased${version ? ` · in ${version}` : ""}` : `${section.name}${section.date ? ` · ${section.date}` : ""}` }))
}

/** Where the copyable prompt says the changes are: this build's release page, or `/changelog` for a build with no release. */
export function changesWhere(version: string): string {
  const channel = channelOfVersion(version)
  if (!channel || channel === "dev") return "listed by /changelog in MendCode"
  return `on https://github.com/${UPGRADE_REPO}/releases/tag/${channel === "nightly" ? MOVING_NIGHTLY_TAG : `v${version.replace(/^v/, "")}`}`
}

/** Every item of a section, in the CHANGELOG's group order. */
export const sectionItems = (section: ChangelogSection): string[] => NOTE_GROUPS.flatMap((group) => section.items[group])

/** A short stable id of an item (FNV-1a), so the seen file holds a few characters per item instead of its text. */
export function itemKey(item: string): string {
  let hash = 0x811c9dc5
  for (const char of plainItem(item)) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
  return hash.toString(36)
}

/** Which items of `section` (in `sectionItems` order) are new since `seen`; none on a first look (nothing to compare with). */
export function freshItems(section: ChangelogEntry, seen: ChangelogSeen | undefined, entries?: readonly ChangelogEntry[]): boolean[] {
  const items = sectionItems(section)
  if (!seen) return items.map(() => false)
  if (section.name === "Unreleased") {
    const known = new Set(seen.unreleased)
    return items.map((item) => !known.has(itemKey(item)))
  }
  // The list is newest first, so a section above the seen one is new: a beta cut after a stable is newer though lower by semver.
  const seenAt = seen.version && entries ? entries.findIndex((entry) => entry.name === seen.version) : -1
  if (seenAt >= 0) {
    const fresh = entries!.indexOf(section) < seenAt
    return items.map(() => fresh)
  }
  const at = parseVersion(section.name)
  const before = seen.version ? parseVersion(seen.version) : undefined
  const fresh = at && before ? compareSemver(at, before) > 0 : !!(seen.date && section.date && section.date > seen.date)
  return items.map(() => fresh)
}

/** How many items of `section` are new since `seen`. */
export const newItems = (section: ChangelogEntry, seen: ChangelogSeen | undefined, entries?: readonly ChangelogEntry[]): number => freshItems(section, seen, entries).filter(Boolean).length

const seenFile = (dataDir: string) => path.join(dataDir, "tui", "changelog-seen")

/** What this terminal showed last; undefined when it never showed the changelog. */
export function readSeen(dataDir: string): ChangelogSeen | undefined {
  let text: string
  try { text = fs.readFileSync(seenFile(dataDir), "utf8").trim() } catch { return undefined }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { date: text, unreleased: [] }
  try {
    const value = JSON.parse(text) as { version?: unknown; unreleased?: unknown }
    return {
      ...(typeof value.version === "string" ? { version: value.version } : {}),
      unreleased: Array.isArray(value.unreleased) ? value.unreleased.filter((key): key is string => typeof key === "string").slice(0, MAX_SEEN_ITEMS) : [],
    }
  } catch {
    return undefined
  }
}

/** Records `entries` as shown. A failed write only means the entries show as new again. */
export function writeSeen(dataDir: string, entries: readonly ChangelogEntry[]) {
  const version = entries.find((entry) => entry.name !== "Unreleased" && parseVersion(entry.name))?.name
  const unreleased = entries.find((entry) => entry.name === "Unreleased")
  const seen = { ...(version ? { version } : {}), unreleased: unreleased ? sectionItems(unreleased).map(itemKey).slice(0, MAX_SEEN_ITEMS) : [] }
  try {
    fs.mkdirSync(path.dirname(seenFile(dataDir)), { recursive: true })
    fs.writeFileSync(seenFile(dataDir), `${JSON.stringify(seen)}\n`)
  } catch {
    // Nothing to do: the marker is a convenience.
  }
}
