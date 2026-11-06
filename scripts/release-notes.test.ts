import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Release } from "../packages/upgrade/src/releases"
import { brief, highlight, highlights, parseChangelog, previousRelease, releaseNotes, releaseTagOf, releaseTitle, sentences, type NotesInput } from "./release-notes"

const release = (tag: string, publishedAt = 0): Release => ({ tag, prerelease: tag.includes("-"), draft: false, publishedAt, assets: [] })
// The public repository's releases on 2026-10-29: v0.0.2-beta.1 has a tag but no release (its smoke test failed).
const PUBLISHED = ["v0.0.1", "v0.0.2-beta.2", "v0.0.2-beta.3", "v0.0.2-nightly.20261029.1"].map((tag) => release(tag))
const CHANGELOG = `# Changelog

## Unreleased

Readable releases.

### Changed

- Release titles name the channel.

## v0.0.2-beta.3 - 2026-10-29

Reviews of large pull requests work.

### Fixed

- PR review: a long prompt goes into an attachment
  instead of failing.

## v0.0.2-beta.2 - 2026-10-29

Headless runs end cleanly.

### Fixed

- \`run --format json\` ends on the turn's result.

## v0.0.2-beta.1 - 2026-10-29

Not released.

### New

- PR review walkthrough.

## v0.0.1 - 2026-10-29

The first release.

### New

- One daemon keeps your sessions.
`
const input = (tag: string, extra: Partial<NotesInput> = {}): NotesInput => ({
  tag, repository: "MendCode/MendCode", releases: PUBLISHED, changelog: CHANGELOG, tagChangelog: CHANGELOG, previousChangelog: undefined,
  head: "c".repeat(40), sameTree: false, commits: [{ sha: "c".repeat(40), subject: "MendCode 0.0.2" }], files: ["packages/daemon/src/a.ts", "packages/daemon/src/b.ts", "docs/release.md", "CHANGELOG.md"], provenance: true, ...extra,
})

describe("release titles", () => {
  test("each channel has a readable title; the tag stays machine-readable", () => {
    expect(releaseTitle("v0.0.2")).toBe("MendCode v0.0.2")
    expect(releaseTitle("v0.0.2-beta.4")).toBe("MendCode v0.0.2 Beta 4")
    expect(releaseTitle("v0.0.2-nightly.20261029.2")).toBe("MendCode Nightly")
    expect(releaseTagOf("v0.0.2-nightly.20261029.2")).toBe("nightly")
    expect(releaseTagOf("v0.0.2-beta.4")).toBe("v0.0.2-beta.4")
    expect(releaseTitle("dev-1a2b3c4d5e")).toBe("MendCode Dev 1a2b3c4")
    expect(() => releaseTitle("v0.0.2-rc.1")).toThrow("[RELEASE_NOTES]: unsupported release tag: v0.0.2-rc.1")
  })
})

describe("the previous release of the channel", () => {
  test("is the updater's: a nightly follows the newest older nightly, beta or stable; a beta skips a tag that was never released; a stable only stables", () => {
    expect(previousRelease("v0.0.2-nightly.20261029.2", PUBLISHED)?.tag).toBe("v0.0.2-nightly.20261029.1")
    expect(previousRelease("v0.0.2-nightly.20261029.1", PUBLISHED)?.tag).toBe("v0.0.2-beta.3")
    expect(previousRelease("v0.0.2-beta.3", PUBLISHED)?.tag).toBe("v0.0.2-beta.2")
    expect(previousRelease("v0.0.2-beta.2", PUBLISHED)?.tag).toBe("v0.0.1")
    expect(previousRelease("v0.0.2", PUBLISHED)?.tag).toBe("v0.0.1")
    expect(previousRelease("v0.0.1", PUBLISHED)).toBeUndefined()
    // A newer release (or the one being edited) is never the baseline.
    expect(previousRelease("v0.0.2-beta.2", [...PUBLISHED, release("v0.0.2-beta.2")])?.tag).toBe("v0.0.1")
  })
})

describe("release notes", () => {
  test("a beta reads its own section; one the channel never got is folded in; install comes first, verify and the commits are folded", () => {
    const notes = releaseNotes(input("v0.0.2-beta.2"))
    expect(notes.startsWith("Headless runs end cleanly.\n\nBeta · since [v0.0.1](https://github.com/MendCode/MendCode/releases/tag/v0.0.1) · built from [`cccccccccccc`]")).toBe(true)
    expect(notes).toContain("## What's new\n\n- PR review walkthrough.\n")
    expect(notes).toContain("## Fixes\n\n- `run --format json` ends on the turn's result.\n")
    expect(notes).toContain("Includes v0.0.2-beta.1, which was not released to this channel.")
    expect(notes).toContain("curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh -s -- --channel beta")
    const [visible, folded] = notes.split("<details>")
    expect(visible).not.toContain("cosign")
    expect(folded).toContain("cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/v0.0.2-beta.2")
    expect(folded).toContain("gh attestation verify mendcode-0.0.2-beta.2-darwin-arm64 --repo MendCode/MendCode")
    expect(folded).toContain("<summary>Full details</summary>")
    expect(folded).toContain("4 files changed: packages/daemon (2), CHANGELOG.md (1), docs (1).")
    expect(notes).toContain("**Changelog**: [CHANGELOG.md](https://github.com/MendCode/MendCode/blob/v0.0.2-beta.2/CHANGELOG.md) · [compare with v0.0.1](https://github.com/MendCode/MendCode/compare/v0.0.1...v0.0.2-beta.2)")
    // Items are not repeated, and a continued item reads as one line.
    expect(releaseNotes(input("v0.0.2-beta.3"))).toContain("- PR review: a long prompt goes into an attachment instead of failing.\n")
    expect(releaseNotes(input("v0.0.2-beta.3"))).not.toContain("Includes")
  })

  test("a stable or beta without its section, or with an empty one, fails: no release goes out with only a link", () => {
    expect(() => releaseNotes(input("v0.0.2-beta.4"))).toThrow('[RELEASE_NOTES]: CHANGELOG.md has no "## v0.0.2-beta.4" section')
    expect(() => releaseNotes(input("v0.0.2"))).toThrow('no "## v0.0.2" section')
    const empty = `${CHANGELOG}\n## v0.0.3 - 2026-11-01\n\n### Fixed\n`
    expect(() => releaseNotes(input("v0.0.3", { changelog: empty, releases: [...PUBLISHED, release("v0.0.2")] }))).toThrow('"## v0.0.3" needs a summary paragraph and at least one item')
    expect(() => parseChangelog("## v0.0.3\n\nx\n\n### Misc\n- y\n")).toThrow('unknown heading "### Misc"')
    expect(() => parseChangelog("## v0.0.3\n\nx\n\n## v0.0.3\n")).toThrow('two "## v0.0.3" sections')
  })

  test("a stable takes its betas' items too: its users never got them", () => {
    const stable = `## v0.0.2 - 2026-11-03\n\nThe second release.\n\n### Fixed\n\n- \`run --format json\` ends on the turn's result.\n\n${CHANGELOG.split("## Unreleased")[1]!.replace(/^[^#]*?(?=## v)/s, "")}`
    const notes = releaseNotes(input("v0.0.2", { changelog: stable }))
    expect(notes).toContain("since [v0.0.1]")
    expect(notes).toContain("Includes v0.0.2-beta.3, v0.0.2-beta.2, v0.0.2-beta.1, which were not released to this channel.")
    // Once in the short Fixes and once in the folded details, never twice in the same list.
    expect(notes.match(/run --format json/g)).toHaveLength(2)
    expect(notes).toContain("curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh\n")
    expect(notes).toContain("Already installed: `mendcode upgrade --channel stable`.")
  })

  test("a nightly lists the Unreleased items its previous release did not have, and fails when there are none", () => {
    const before = CHANGELOG.replace("- Release titles name the channel.", "- Something older.")
    const notes = releaseNotes(input("v0.0.2-nightly.20261030.3", { previousChangelog: before }))
    expect(notes).toContain("Nightly build 2026-10-30 #3 · since [v0.0.2-nightly.20261029.1]")
    expect(notes).toContain("Readable releases.\n\nNightly build")
    expect(notes).toContain("## What's new\n\n- Release titles name the channel.\n")
    expect(notes).not.toContain("## Changes")
    expect(notes).toContain("| sh -s -- --channel nightly")
    expect(notes).toContain("gh release download nightly --repo")
    expect(notes).toContain("release.yml@refs/tags/v0.0.2-nightly.20261030.3")
    expect(notes).not.toContain("This exact build")
    expect(() => releaseNotes(input("v0.0.2-nightly.20261030.3", { previousChangelog: CHANGELOG }))).toThrow('[RELEASE_NOTES]: nothing to say: "## Unreleased" in CHANGELOG.md has no item that v0.0.2-nightly.20261029.1 did not have')
    expect(() => releaseNotes(input("v0.0.2-nightly.20261030.3", { tagChangelog: undefined }))).toThrow("nothing to say")
  })

  test("a release of the same tree as its previous one says so instead of failing", () => {
    const notes = releaseNotes(input("v0.0.2-nightly.20261029.1", { sameTree: true, tagChangelog: undefined, commits: [], files: [] }))
    expect(notes).toContain("This nightly is the same code as v0.0.2-beta.3; there are no changes since it.")
    expect(notes).toContain("No commits since v0.0.2-beta.3: it is the same commit.")
  })

  test("the first release has no previous one: its own section, the commits of its tag, no provenance line on a private repository", () => {
    const notes = releaseNotes(input("v0.0.1", { provenance: false }))
    expect(notes).toContain("\nStable · first release · built from")
    expect(notes).toContain("## What's new\n\n- One daemon keeps your sessions.")
    expect(notes).toContain("1 commit in this release:")
    expect(notes).toContain("**Changelog**: [CHANGELOG.md](https://github.com/MendCode/MendCode/blob/v0.0.1/CHANGELOG.md) · [commits](https://github.com/MendCode/MendCode/commits/v0.0.1)")
    expect(notes).not.toContain("attestation")
  })
})

// A beta with many items, as the real CHANGELOG has them: bold leads, long bodies, "See" links, fixes and changes.
const RICH = `## Unreleased

## v0.0.4-beta.1 - 2026-11-05

Worktrees get a manager and background sessions survive a daemon restart. The footer has packs. A third sentence stays out of the header.

### New

- **Worktree manager.** \`mendcode worktrees list|size|gc\` shows every worktree with its size and why it is kept. \`gc\` previews and \`--yes\` removes. See [storage](docs/storage.md).
- A daemon restart no longer leaves your turns interrupted for good: sessions it stopped continue when it starts again. Turn it off with \`resumeAfterRestart: false\`.
- **Footer packs.** The footer's whole look in one data file, chosen with \`/footer pack NAME\`.
- Logo fonts rounded, double, shade and braille.
- \`mendcode usage --quota\` prints the quota windows the footer shows.
- \`/customize\` is regrouped: the common sections first, the rest under Advanced.
- \`/\` in \`/customize\` filters the rows by name.
- Home > Input position puts the chat input at the bottom.
- A ninth new thing that stays in the full details only.

### Changed

- The default footer is \`clean\`: folder and branch, then model, effort and context.
- Plans are saved as Markdown files per project.

### Fixed

- Pasting an image from the clipboard works on every OS.
- The wheel scrolls history, keymap and compaction pages.

### Upgrade notes

- \`footerPack: off\` brings back the previous footer.
`
const RICH_RELEASES = [release("v0.0.3"), release("v0.0.3-beta.1")]

describe("release notes for a beta, a stable and a nightly", () => {
  const beta = () => releaseNotes(input("v0.0.4-beta.1", { releases: RICH_RELEASES, changelog: RICH, tagChangelog: RICH }))

  test("a beta: two sentences, eight highlights, short fixes and changes, the rest folded", () => {
    const notes = beta()
    const [visible = "", folded = ""] = notes.split("<details>")
    expect(visible.startsWith("Worktrees get a manager and background sessions survive a daemon restart. The footer has packs.\n\nBeta · since [v0.0.3]")).toBe(true)
    expect(visible).not.toContain("A third sentence")
    const top = visible.split("## What's new\n\n")[1]!.split("\n\n")[0]!.split("\n")
    expect(top).toHaveLength(8)
    expect(top[0]).toBe("- **Worktree manager.** `mendcode worktrees list|size|gc` shows every worktree with its size and why it is kept.")
    expect(top[1]).toBe("- A daemon restart no longer leaves your turns interrupted for good: sessions it stopped continue when it starts again.")
    expect(top[2]).toBe("- **Footer packs.** The footer's whole look in one data file, chosen with `/footer pack NAME`.")
    expect(visible).not.toContain("A ninth new thing")
    expect(folded).toContain("- A ninth new thing that stays in the full details only.")
    expect(visible).toContain("## Fixes\n\n- Pasting an image from the clipboard works on every OS.\n- The wheel scrolls history, keymap and compaction pages.\n")
    expect(visible).toContain("## Changes\n\n- The default footer is `clean`: folder and branch, then model, effort and context.\n- Plans are saved as Markdown files per project.\n")
    expect(visible).toContain("## Upgrade notes\n\n- `footerPack: off` brings back the previous footer.\n")
    expect(visible).not.toContain("Resume")
    expect(visible).not.toContain("See [storage]")
    expect(folded).toContain("See [storage](docs/storage.md).")
    expect(visible.length).toBeLessThan(2400)
  })

  test("a stable of the same section reads like the beta, titled and installed as a stable", () => {
    const stable = RICH.replace("## v0.0.4-beta.1", "## v0.0.4")
    const notes = releaseNotes(input("v0.0.4", { releases: [release("v0.0.3")], changelog: stable, tagChangelog: stable }))
    expect(notes).toContain("\nStable · since [v0.0.3]")
    expect(notes).toContain("## What's new")
    expect(notes).toContain("Already installed: `mendcode upgrade --channel stable`.")
    expect(releaseTitle("v0.0.4")).toBe("MendCode v0.0.4")
  })

  test("a nightly takes the unreleased items its previous build lacked and links its one moving release", () => {
    const unreleased = `## Unreleased\n\nToday's build.\n\n### New\n\n- **Quota page.** \`/usage\` shows the quota windows. More text here.\n\n### Fixed\n\n- A fixed thing.\n`
    const notes = releaseNotes(input("v0.0.4-nightly.20261105.7", { releases: [...RICH_RELEASES, release("v0.0.4-nightly.20261104.5")], changelog: unreleased, tagChangelog: unreleased, previousChangelog: "## Unreleased\n" }))
    expect(notes).toContain("Nightly build 2026-11-05 #7 · since [v0.0.4-nightly.20261104.5]")
    expect(notes).toContain("## What's new\n\n- **Quota page.** `/usage` shows the quota windows.\n")
    expect(notes).toContain("## Fixes\n\n- A fixed thing.\n")
    expect(notes).toContain("gh release download nightly --repo MendCode/MendCode")
    expect(releaseTitle("v0.0.4-nightly.20261105.7")).toBe("MendCode Nightly")
  })

  test("the helpers keep a sentence whole and a lead bold", () => {
    expect(sentences("Fixes e.g. docs/a.md and more. Second one! Third.", 2)).toBe("Fixes e.g. docs/a.md and more. Second one!")
    expect(sentences("One sentence only", 2)).toBe("One sentence only")
    expect(brief("x ".repeat(200), 20)).toBe("x x x x x x x x x x…")
    expect(highlight("**Lead.** Body one. Body two.")).toBe("**Lead.** Body one.")
    expect(highlight("**Lead only**")).toBe("**Lead only.**")
    expect(highlights({ New: ["a", "b"], Changed: ["c"], Fixed: ["no"], "Upgrade notes": [], "Known limitations": [] })).toEqual(["a", "b", "c"])
  })
})

test("the command reads CHANGELOG.md and the commits from git and writes the title and notes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-notes-"))
  try {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }
    const git = (...args: string[]) => { const done = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: dir, env }); if (done.exitCode) throw new Error(done.stderr.toString()) }
    git("init", "-q", "-b", "main")
    writeFileSync(path.join(dir, "CHANGELOG.md"), "## Unreleased\n\nFirst.\n\n### New\n\n- One.\n")
    git("add", "-A"); git("commit", "-q", "-m", "one"); git("tag", "v0.0.2-nightly.20261029.1")
    writeFileSync(path.join(dir, "CHANGELOG.md"), "## Unreleased\n\nSecond.\n\n### New\n\n- One.\n- Two.\n")
    writeFileSync(path.join(dir, "a.ts"), "export {}\n")
    git("add", "-A"); git("commit", "-q", "-m", "two"); git("tag", "v0.0.2-nightly.20261030.2")
    // The one moving release: its tag is `nightly`, the build it holds is named by its binaries.
    writeFileSync(path.join(dir, "releases.json"), JSON.stringify([{ tag_name: "nightly", prerelease: true, draft: false, published_at: "2026-10-29T00:00:00Z", assets: [{ name: "mendcode-0.0.2-nightly.20261029.1-linux-x64", browser_download_url: "https://github.com/MendCode/MendCode/releases/download/nightly/mendcode-0.0.2-nightly.20261029.1-linux-x64" }] }]))
    const done = Bun.spawnSync(["bun", path.join(import.meta.dir, "release-notes.ts"), "--tag", "v0.0.2-nightly.20261030.2", "--repository", "MendCode/MendCode", "--releases", "releases.json", "--out", "notes.md", "--title-out", "title.txt"], { cwd: dir, env, stderr: "pipe" })
    expect({ code: done.exitCode, err: done.stderr.toString() }).toEqual({ code: 0, err: "" })
    const notes = readFileSync(path.join(dir, "notes.md"), "utf8")
    expect(readFileSync(path.join(dir, "title.txt"), "utf8")).toBe("MendCode Nightly\n")
    expect(notes.startsWith("Second.\n")).toBe(true)
    expect(notes).toContain("## What's new\n\n- Two.\n")
    expect(notes).not.toContain("- One.")
    expect(notes).toContain("1 commit since v0.0.2-nightly.20261029.1:")
    expect(notes).toContain("2 files changed: CHANGELOG.md (1), a.ts (1).")
    // Code changed but nothing new under Unreleased: the command fails and writes nothing.
    writeFileSync(path.join(dir, "a.ts"), "export const changed = 1\n")
    git("commit", "-q", "-am", "three"); git("tag", "v0.0.2-nightly.20261031.3")
    writeFileSync(path.join(dir, "releases.json"), JSON.stringify([{ tag_name: "nightly", prerelease: true, draft: false, published_at: "2026-10-30T00:00:00Z", assets: [{ name: "mendcode-0.0.2-nightly.20261030.2-linux-x64", browser_download_url: "https://github.com/MendCode/MendCode/releases/download/nightly/mendcode-0.0.2-nightly.20261030.2-linux-x64" }] }]))
    rmSync(path.join(dir, "notes.md"))
    const empty = Bun.spawnSync(["bun", path.join(import.meta.dir, "release-notes.ts"), "--tag", "v0.0.2-nightly.20261031.3", "--repository", "MendCode/MendCode", "--releases", "releases.json", "--out", "notes.md"], { cwd: dir, env, stderr: "pipe" })
    expect(empty.exitCode).not.toBe(0)
    expect(empty.stderr.toString()).toContain("[RELEASE_NOTES]: nothing to say")
    expect(Bun.file(path.join(dir, "notes.md")).size).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

describe("the copyable prompt sits under Install on every release page", () => {
  test("a stable, a beta and the Nightly show the prompt before the folded details, naming their page and their upgrade command", () => {
    const stable = RICH.replace("## v0.0.4-beta.1", "## v0.0.4")
    const unreleased = "## Unreleased\n\nToday's build.\n\n### Fixed\n\n- A fixed thing.\n"
    const pages: [string, string, string][] = [
      [releaseNotes(input("v0.0.4", { releases: [release("v0.0.3")], changelog: stable, tagChangelog: stable })), "/releases/tag/v0.0.4", "`mendcode upgrade --channel stable`"],
      [releaseNotes(input("v0.0.4-beta.1", { releases: RICH_RELEASES, changelog: RICH, tagChangelog: RICH })), "/releases/tag/v0.0.4-beta.1", "`mendcode upgrade --channel beta`"],
      [releaseNotes(input("v0.0.4-nightly.20261105.7", { releases: [...RICH_RELEASES, release("v0.0.4-nightly.20261104.5")], changelog: unreleased, tagChangelog: unreleased, previousChangelog: "## Unreleased\n" })), "/releases/tag/nightly", "`mendcode upgrade --channel nightly`"],
    ]
    for (const [notes, page, upgrade] of pages) {
      const at = notes.indexOf("## What fits you")
      const block = notes.slice(at, notes.indexOf("<details>"))
      expect(at).toBeGreaterThan(notes.indexOf("## Install"))
      expect(at).toBeLessThan(notes.indexOf("<summary>Full details</summary>"))
      expect(block).toContain("Paste this into any MendCode session:")
      expect(block).toContain("is out. The changes are on")
      expect(block).toContain(`If the MendCode I run is older (\`mendcode --version\`), update it first with ${upgrade}.`)
      expect(block).toContain("Read only: do not change any setting unless I ask.")
      expect(block).toContain(page)
      expect(block.trimEnd().endsWith("```")).toBe(true)
    }
  })
})

test("the repository's CHANGELOG.md has one item per line: a merge never glues two items together", () => {
  const text = readFileSync(path.join(import.meta.dir, "../CHANGELOG.md"), "utf8")
  const glued = text.split("\n").filter((line) => line.startsWith("- ") && /[.)`]- [A-Z`*]/.test(line))
  expect(glued).toEqual([])
})
