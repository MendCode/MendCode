/**
 * CHANGELOG.md read the same way everywhere (docs/release.md, "Release titles and notes"; docs/whats-new.md): the GitHub release
 * notes (`scripts/release-notes.ts`), `/changelog` and `/whatsnew` share the parser, the one-line highlights and the copyable
 * "what fits me" prompt. Pure functions, no imports, so the terminal loads it only when one of those pages opens.
 */

export const NOTE_GROUPS = ["New", "Changed", "Fixed", "Upgrade notes", "Known limitations"] as const
export type NoteGroup = (typeof NOTE_GROUPS)[number]
/** `name` is the tag (`v0.0.3`) or `Unreleased`; `date` is the heading's `- YYYY-MM-DD` when it has one. */
export type ChangelogSection = { name: string; date?: string | undefined; summary: string; items: Record<NoteGroup, string[]> }

const fail = (message: string): never => { throw new Error(`[CHANGELOG]: ${message}`) }
export const emptyItems = (): Record<NoteGroup, string[]> => ({ New: [], Changed: [], Fixed: [], "Upgrade notes": [], "Known limitations": [] })

/** `## Unreleased` or `## <tag> - <date> ...`, a summary paragraph, then `### <group>` lists of `- ` items. */
export function parseChangelog(text: string): Map<string, ChangelogSection> {
  const sections = new Map<string, ChangelogSection>()
  let section: ChangelogSection | undefined
  let group: NoteGroup | undefined
  const summary: string[] = []
  const close = () => { if (section) section.summary = summary.join("\n").trim(); summary.length = 0 }
  for (const line of text.split("\n")) {
    const heading = /^## (\S+)(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?/.exec(line)
    if (heading) {
      close()
      if (sections.has(heading[1]!)) fail(`CHANGELOG.md has two "## ${heading[1]}" sections`)
      section = { name: heading[1]!, ...(heading[2] ? { date: heading[2] } : {}), summary: "", items: emptyItems() }
      sections.set(section.name, section)
      group = undefined
      continue
    }
    if (!section) continue
    const sub = /^### (.+?)\s*$/.exec(line)
    if (sub) {
      if (!NOTE_GROUPS.includes(sub[1] as NoteGroup)) fail(`CHANGELOG.md ${section.name}: unknown heading "### ${sub[1]}" (use ${NOTE_GROUPS.join(", ")})`)
      group = sub[1] as NoteGroup
      continue
    }
    if (!group) { summary.push(line); continue }
    const list = section.items[group]
    if (line.startsWith("- ")) list.push(line.slice(2).trim())
    else if (/^\s+\S/.test(line) && list.length) list[list.length - 1] += ` ${line.trim()}`
  }
  close()
  return sections
}

/** The first `count` sentences of `text` on one line (a sentence ends at . ! or ? before a capital letter, a quote, a bracket or the end). */
export function sentences(text: string, count: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  let end = 0
  for (let found = 0; found < count; found++) {
    const next = /[.!?](?=\s+[A-Z`\[(*"]|$)/.exec(flat.slice(end))
    if (!next) return flat
    end += next.index + 1
  }
  return flat.slice(0, end)
}

/**
 * One line for a list: the first sentence; when that is longer than `max`, it ends at its last colon or semicolon (or comma) that
 * leaves a readable start, else at a word with `…`. Links and code spans stay whole.
 */
export function brief(item: string, max = 150): string {
  const line = sentences(item, 1)
  if (line.length <= max) return line
  const head = line.slice(0, max)
  // A cut keeps code spans, links and parentheses whole, and leaves some words (not only a code span) before it.
  const whole = (index: number) => {
    const before = head.slice(0, index)
    const count = (character: string) => before.split(character).length - 1
    return count("`") % 2 === 0 && count("(") === count(")") && count("[") === count("]") && before.replace(/`[^`]*`/g, "").trim().length >= 20
  }
  for (const [separator, least] of [[/[:;] /g, 40], [/, /g, 60]] as const) {
    const at = [...head.matchAll(separator)].filter((found) => found.index! >= least && whole(found.index!)).pop()
    if (at) return `${head.slice(0, at.index!)}.`
  }
  const cut = head.replace(/\s+\S*$/, "")
  return `${cut.replace(/[,;:(\s]+$/, "")}…`
}

/** A highlight reads like a headline: the bold lead of the item (`**Footer packs.**`) and one sentence after it, or the first sentence. */
export function highlight(item: string): string {
  const lead = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(item)
  if (!lead) return brief(item, 150)
  const title = lead[1]!.replace(/\.$/, "")
  const rest = brief(lead[2]!, 130)
  return rest ? `**${title}.** ${rest}` : `**${title}.**`
}

export const MAX_HIGHLIGHTS = 8

/**
 * The same short list the release page, the nightly page, `/changelog` and `/whatsnew` show: the new things first, then the changes,
 * at most eight, each one line. Fixes never crowd it out (they have their own list).
 */
export function highlights(items: Record<NoteGroup, string[]>): string[] {
  return [...items.New, ...items.Changed].slice(0, MAX_HIGHLIGHTS).map(highlight)
}

/** An item as terminal text: bold marks and link targets dropped, code spans kept without their backticks. */
export function plainItem(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim()
}

/** Most characters of the changes `/whatsnew` sends in its one call (the terminal cuts the list to fit; docs/whats-new.md). */
export const WHATS_NEW_MAX_CHANGES = 16_000

/** "MendCode v0.0.3" for a tag or a version (`0.0.3`, `v0.0.4-nightly.20261105.7`). */
export const versionName = (version: string) => `MendCode ${version.startsWith("v") ? version : `v${version}`}`

/**
 * The copyable prompt at the end of every release's notes, and the request `/whatsnew` sends: a session reads the user's memories,
 * past sessions and settings and answers which changes of this version are worth using, knowing or configuring. Read only, short,
 * in the user's language. `changes` says where the list of changes is (a URL on the release page; `below` in `/whatsnew`).
 */
export function whatsNewPrompt(input: { version: string; changes: string }): string {
  return [
    `${versionName(input.version)} is installed. The changes are ${input.changes}.`,
    "From my memories, my past sessions and my MendCode settings, tell me which of these changes I should use, know about or configure, given what I usually do.",
    "Read only: do not change any setting unless I ask. Be brief.",
    "Answer in my language.",
  ].join("\n")
}
