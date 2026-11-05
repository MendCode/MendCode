import { readFileSync, writeFileSync } from "node:fs"
import { channelOf, compareSemver, MOVING_NIGHTLY_TAG, parseReleases, parseVersion, pickRelease, type Channel, type Release } from "../packages/upgrade/src/releases"
import { brief, emptyItems, highlights, MAX_HIGHLIGHTS, NOTE_GROUPS, parseChangelog, sentences, whatsNewPrompt, type ChangelogSection, type NoteGroup } from "../packages/protocol/src/changelog"

/**
 * The title and notes of a GitHub release (docs/release.md, "Release titles and notes"). The public repository holds one snapshot
 * commit per release, so GitHub's generated notes are empty: the curated text comes from CHANGELOG.md, reviewed with the code it
 * describes. A stable or beta release needs its own section (`## vX.Y.Z`, `## vX.Y.Z-beta.N`); a nightly takes the items under
 * `## Unreleased` that the previous release of its channel did not have yet. Nothing to say fails the release, like V1's notes.
 * The previous release is the updater's (`pickRelease`): a nightly follows the newest older nightly, beta or stable.
 */

// The parser, the one-line highlights and the copyable prompt are shared with `/changelog` and `/whatsnew` (docs/whats-new.md).
export { NOTE_GROUPS, brief, highlight, highlights, parseChangelog, sentences, type ChangelogSection } from "../packages/protocol/src/changelog"
type Group = NoteGroup

const fail = (message: string): never => { throw new Error(`[RELEASE_NOTES]: ${message}`) }
const itemCount = (section: ChangelogSection) => NOTE_GROUPS.reduce((total, group) => total + section.items[group].length, 0)
const channelOfTag = (tag: string) => channelOf({ tag, prerelease: tag.includes("-"), draft: false, publishedAt: 0, assets: [] })

/** "MendCode v0.0.2", "MendCode v0.0.2 Beta 4", "MendCode Nightly" (the one moving release), "MendCode Dev 1a2b3c4". */
export function releaseTitle(tag: string): string {
  const beta = /^v(\d+\.\d+\.\d+)-beta\.(\d+)$/.exec(tag)
  if (beta) return `MendCode v${beta[1]} Beta ${beta[2]}`
  if (/^v\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d{0,8}$/.test(tag)) return "MendCode Nightly"
  const dev = /^dev-([0-9a-f]{7,40})$/.exec(tag)
  if (dev) return `MendCode Dev ${dev[1]!.slice(0, 7)}`
  if (/^v\d+\.\d+\.\d+$/.test(tag)) return `MendCode ${tag}`
  return fail(`unsupported release tag: ${tag}`)
}

/** The tag of the GitHub release that carries `tag`'s files: every build has its own, except a nightly, which replaces the one `nightly`. */
export const releaseTagOf = (tag: string) => (channelOfTag(tag) === "nightly" ? MOVING_NIGHTLY_TAG : tag)

const MAX_LIST = 6

/** The release `tag` follows: the newest published release older than it that its channel takes. */
export function previousRelease(tag: string, releases: readonly Release[]): Release | undefined {
  const channel = channelOfTag(tag) ?? fail(`unsupported release tag: ${tag}`)
  const version = parseVersion(tag)
  const older = releases.filter((release) => release.tag !== tag && (channel === "dev" || (!!parseVersion(release.tag) && compareSemver(parseVersion(release.tag)!, version!) < 0)))
  return pickRelease(older, channel)
}

export type NotesInput = {
  tag: string
  repository: string
  /** Published releases (`gh api repos/<repo>/releases`); the one being written may be among them. */
  releases: readonly Release[]
  /** Named sections are read here (CHANGELOG.md at the tag, or a newer one when correcting an older release). */
  changelog: string
  /** CHANGELOG.md at the tag, for `## Unreleased`; undefined when the tag has none. */
  tagChangelog: string | undefined
  /** CHANGELOG.md at the previous release, whose items a nightly does not repeat. */
  previousChangelog: string | undefined
  head: string
  /** The tag's tree is the previous release's. */
  sameTree: boolean
  commits: ReadonlyArray<{ sha: string; subject: string }>
  files: readonly string[]
  provenance: boolean
}

const CHANNEL_LABEL: Record<Channel, string> = { stable: "Stable", beta: "Beta", nightly: "Nightly", dev: "Development build" }

/** Paths grouped by area (`packages/daemon`, `docs`, a root file), largest first. */
function areas(files: readonly string[]) {
  const counts = new Map<string, number>()
  for (const file of files) {
    const parts = file.split("/")
    const area = parts.length === 1 ? file : ["apps", "packages"].includes(parts[0]!) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!
    counts.set(area, (counts.get(area) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([area, count]) => `${area} (${count})`).join(", ")
}

/** The curated part: the tag's own section, else (nightly, dev) the unreleased items its previous release lacked. */
function curated(input: NotesInput, previous: Release | undefined): { summary: string; items: Record<Group, string[]>; folded: string[] } {
  const channel = channelOfTag(input.tag)!
  const sections = parseChangelog(input.changelog)
  const own = sections.get(input.tag)
  const items = emptyItems()
  const add = (section: ChangelogSection) => { for (const group of NOTE_GROUPS) for (const item of section.items[group]) if (!items[group].includes(item)) items[group].push(item) }
  // Versions between the previous release and this one that its users never got (a beta whose release failed, the betas of a stable).
  const folded: string[] = []
  const version = parseVersion(input.tag)
  const since = previous && parseVersion(previous.tag)
  if (version && channel !== "dev") {
    const published = new Set(input.releases.filter((release) => pickRelease([release], channel)).map((release) => release.tag))
    for (const section of sections.values()) {
      const at = parseVersion(section.name)
      if (!at || section.name === input.tag || published.has(section.name) || compareSemver(at, version) >= 0 || (since && compareSemver(at, since) <= 0)) continue
      add(section)
      folded.push(section.name)
    }
  }
  if (own) {
    if (!own.summary || !itemCount(own)) fail(`CHANGELOG.md "## ${input.tag}" needs a summary paragraph and at least one item`)
    add(own)
    return { summary: own.summary, items, folded }
  }
  if (input.sameTree && previous) return { summary: `This ${CHANNEL_LABEL[channel].toLowerCase()} is the same code as ${previous.tag}; there are no changes since it.`, items, folded }
  if (channel === "stable" || channel === "beta") fail(`CHANGELOG.md has no "## ${input.tag}" section; add one with a summary and at least one item before releasing`)
  const unreleased = parseChangelog(input.tagChangelog ?? "").get("Unreleased")
  const known = new Set([...parseChangelog(input.previousChangelog ?? "").values()].flatMap((section) => NOTE_GROUPS.flatMap((group) => section.items[group])))
  if (unreleased) for (const group of NOTE_GROUPS) for (const item of unreleased.items[group]) if (!known.has(item) && !items[group].includes(item)) items[group].push(item)
  const count = NOTE_GROUPS.reduce((total, group) => total + items[group].length, 0)
  if (!count) fail(`nothing to say: "## Unreleased" in CHANGELOG.md has no item that ${previous?.tag ?? "an earlier release"} did not have`)
  return { summary: unreleased?.summary || `${count} change${count === 1 ? "" : "s"} since ${previous?.tag ?? "the first release"}.`, items, folded }
}

/** `- ` lines for `items`, at most `MAX_LIST`, then how many more the folded details hold. */
function shortList(items: readonly string[]): string[] {
  const shown = items.slice(0, MAX_LIST).map((item) => `- ${brief(item, 130)}`)
  return items.length > MAX_LIST ? [...shown, `- … and ${items.length - MAX_LIST} more in the full details below`] : shown
}

/** The nightly's line: `Nightly build 2026-11-05 #7` for `v0.0.4-nightly.20261105.7`; the channel name for the others. */
function buildLabel(tag: string, channel: Channel): string {
  const nightly = /-nightly\.(\d{4})(\d{2})(\d{2})\.(\d+)$/.exec(tag)
  return nightly ? `Nightly build ${nightly[1]}-${nightly[2]}-${nightly[3]} #${nightly[4]}` : CHANNEL_LABEL[channel]
}

/**
 * The release notes, in English, short first: a line or two of summary, "What's new" (at most eight highlights), "Fixes" and
 * "Changes" as one-line lists, then how to install. The complete items, how to verify and the commits are folded away, and the
 * full CHANGELOG is one link.
 */
export function releaseNotes(input: NotesInput): string {
  const channel = channelOfTag(input.tag) ?? fail(`unsupported release tag: ${input.tag}`)
  const previous = previousRelease(input.tag, input.releases)
  const { summary, items, folded } = curated(input, previous)
  const url = `https://github.com/${input.repository}`
  const version = input.tag.replace(/^v/, "")
  const sample = `mendcode-${version}-darwin-arm64`
  const source = releaseTagOf(input.tag)
  const since = previous ? ` · since [${previous.tag}](${url}/releases/tag/${previous.tag})` : " · first release"
  const lines = [sentences(summary, 2), "", `${buildLabel(input.tag, channel)}${since} · built from [\`${input.head.slice(0, 12)}\`](${url}/commit/${input.head})`, ""]
  const top = highlights(items)
  if (top.length) lines.push("## What's new", "", ...top.map((line) => `- ${line}`), "")
  if (items.Fixed.length) lines.push("## Fixes", "", ...shortList(items.Fixed), "")
  const shown = new Set(items.New.concat(items.Changed).slice(0, MAX_HIGHLIGHTS))
  const rest = items.Changed.filter((item) => !shown.has(item))
  if (rest.length) lines.push("## Changes", "", ...shortList(rest), "")
  for (const group of ["Upgrade notes", "Known limitations"] as const) if (items[group].length) lines.push(`## ${group}`, "", ...shortList(items[group]), "")
  if (folded.length) lines.push(`Includes ${folded.join(", ")}, which ${folded.length === 1 ? "was" : "were"} not released to this channel.`, "")
  const flag = channel === "stable" ? "" : ` -s -- --channel ${channel}`
  lines.push("## Install", "", "```sh",
    channel === "dev" ? `curl -fsSL ${url}/releases/download/${input.tag}/install.sh | MENDCODE_VERSION=${input.tag} sh` : `curl -fsSL ${url}/releases/latest/download/install.sh | sh${flag}`,
    "```", "")
  if (channel !== "dev") lines.push(`Already installed: \`mendcode upgrade${channel === "stable" ? "" : ` --channel ${channel}`}\`.${channel === "nightly" ? "" : ` This exact build: \`MENDCODE_VERSION=${input.tag}\` with the same installer.`}`, "")
  lines.push("<details>", "<summary>Full details</summary>", "")
  for (const group of NOTE_GROUPS) {
    if (!items[group].length) continue
    lines.push(`### ${group}`, "", ...items[group].map((item) => `- ${item}`), "")
  }
  lines.push("### Verify", "",
    `\`SHA256SUMS\` lists every file of this release. It, every binary and both installers carry a keyless cosign bundle (\`*.sigstore.json\`) signed by this repository's release workflow at \`${input.tag}\`${input.provenance ? ", and the binaries have GitHub build provenance" : ""}.`,
    "", "```sh",
    `gh release download ${source} --repo ${input.repository} --pattern 'SHA256SUMS*' --pattern ${sample}`,
    `grep ' ${sample}$' SHA256SUMS | shasum -a 256 -c`,
    `cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity ${url}/.github/workflows/release.yml@refs/tags/${input.tag} --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS`,
    ...(input.provenance ? [`gh attestation verify ${sample} --repo ${input.repository}`] : []),
    "```", "")
  const listed = input.commits.slice(0, 100)
  lines.push("### Commits", "")
  if (!listed.length) lines.push(`No commits since ${previous?.tag ?? "the start"}: it is the same commit.`, "")
  else lines.push(`${input.commits.length} commit${input.commits.length === 1 ? "" : "s"} ${previous ? `since ${previous.tag}` : "in this release"}:`, "",
    ...listed.map((commit) => `- [\`${commit.sha.slice(0, 8)}\`](${url}/commit/${commit.sha}) ${commit.subject}`),
    ...(input.commits.length > listed.length ? [`- … and ${input.commits.length - listed.length} more`] : []), "")
  if (input.files.length) lines.push(`${input.files.length} file${input.files.length === 1 ? "" : "s"} changed: ${areas(input.files)}.`, "")
  lines.push("</details>", "", `**Changelog**: [CHANGELOG.md](${url}/blob/${input.tag}/CHANGELOG.md)${previous ? ` · [compare with ${previous.tag}](${url}/compare/${previous.tag}...${input.tag})` : ` · [commits](${url}/commits/${input.tag})`}`, "")
  lines.push(...askBlock(input.tag, `${url}/releases/tag/${source}`))
  return lines.join("\n")
}

/** The last block of every release page: a prompt to paste into any MendCode session (docs/whats-new.md, "The copyable prompt"). */
export function askBlock(tag: string, page: string): string[] {
  return ["## What fits you", "", "Paste this into any MendCode session:", "", "```text", whatsNewPrompt({ version: tag, changes: `on ${page}` }), "```", ""]
}

if (import.meta.main) {
  const args = new Map<string, string>()
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) fail("usage: release-notes.ts --tag T --repository OWNER/REPO --releases releases.json [--changelog FILE] [--provenance true|false] [--out FILE] [--title-out FILE]")
    args.set(argv[i]!.slice(2), argv[i + 1]!)
  }
  const tag = args.get("tag") ?? fail("--tag is required")
  const repository = args.get("repository") ?? fail("--repository is required")
  const releases = parseReleases(JSON.parse(readFileSync(args.get("releases") ?? fail("--releases is required"), "utf8")))
  const git = (...argv: string[]) => { const done = Bun.spawnSync(["git", ...argv], { stdout: "pipe", stderr: "pipe" }); return done.exitCode === 0 ? done.stdout.toString() : undefined }
  const commit = (ref: string) => git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)?.trim() ?? fail(`${ref} is not in this checkout (fetch the tags and the full history)`)
  const head = commit(tag)
  const previous = previousRelease(tag, releases)
  const base = previous ? commit(previous.tag) : undefined
  const tagChangelog = git("show", `${head}:CHANGELOG.md`)
  const log = git("log", "--format=%H%x09%s", base ? `${base}..${head}` : head) ?? ""
  const notes = releaseNotes({
    tag, repository, releases, head, provenance: args.get("provenance") !== "false",
    changelog: args.has("changelog") ? readFileSync(args.get("changelog")!, "utf8") : tagChangelog ?? "",
    tagChangelog, previousChangelog: base ? git("show", `${base}:CHANGELOG.md`) : undefined,
    sameTree: !!base && git("rev-parse", `${head}^{tree}`) === git("rev-parse", `${base}^{tree}`),
    commits: log.split("\n").filter(Boolean).map((line) => { const [sha, ...subject] = line.split("\t"); return { sha: sha!, subject: subject.join("\t") } }),
    files: base ? (git("diff", "--name-only", base, head) ?? "").split("\n").filter(Boolean) : [],
  })
  if (args.has("out")) writeFileSync(args.get("out")!, notes)
  else process.stdout.write(notes)
  if (args.has("title-out")) writeFileSync(args.get("title-out")!, `${releaseTitle(tag)}\n`)
}
