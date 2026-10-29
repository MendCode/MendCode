import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Release } from "../packages/upgrade/src/releases"
import { parseChangelog, previousRelease, releaseNotes, releaseTitle, type NotesInput } from "./release-notes"

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
    expect(releaseTitle("v0.0.2-nightly.20261029.2")).toBe("MendCode Nightly — 2026-10-29 · Build 2")
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
  test("a beta reads its own section; one the channel never got is folded in; install, verify and the full changelog follow", () => {
    const notes = releaseNotes(input("v0.0.2-beta.2"))
    expect(notes.startsWith("**v0.0.2-beta.2** · Beta · since [v0.0.1](https://github.com/MendCode/MendCode/releases/tag/v0.0.1) · built from [`cccccccccccc`]")).toBe(true)
    expect(notes).toContain("\nHeadless runs end cleanly.\n")
    expect(notes).toContain("## New\n\n- PR review walkthrough.\n")
    expect(notes).toContain("## Fixed\n\n- `run --format json` ends on the turn's result.\n")
    expect(notes).toContain("Includes v0.0.2-beta.1, which was not released to this channel.")
    expect(notes).toContain("curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh -s -- --channel beta")
    expect(notes).toContain("cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/v0.0.2-beta.2")
    expect(notes).toContain("gh attestation verify mendcode-0.0.2-beta.2-darwin-arm64 --repo MendCode/MendCode")
    expect(notes).toContain("<details>\n<summary>Full changelog</summary>")
    expect(notes).toContain("4 files changed: packages/daemon (2), CHANGELOG.md (1), docs (1).")
    expect(notes).toContain("**Full Changelog**: https://github.com/MendCode/MendCode/compare/v0.0.1...v0.0.2-beta.2")
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
    expect(notes.match(/run --format json/g)).toHaveLength(1)
    expect(notes).toContain("curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh\n")
    expect(notes).toContain("Already installed: `mendcode upgrade`.")
  })

  test("a nightly lists the Unreleased items its previous release did not have, and fails when there are none", () => {
    const before = CHANGELOG.replace("- Release titles name the channel.", "- Something older.")
    const notes = releaseNotes(input("v0.0.2-nightly.20261030.3", { previousChangelog: before }))
    expect(notes).toContain("· Nightly · since [v0.0.2-nightly.20261029.1]")
    expect(notes).toContain("\nReadable releases.\n\n## Changed\n\n- Release titles name the channel.\n")
    expect(notes).toContain("| sh -s -- --channel nightly")
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
    expect(notes).toContain("· Stable · first release ·")
    expect(notes).toContain("## New\n\n- One daemon keeps your sessions.")
    expect(notes).toContain("1 commit in this release:")
    expect(notes).toContain("**Full Changelog**: https://github.com/MendCode/MendCode/commits/v0.0.1")
    expect(notes).not.toContain("attestation")
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
    writeFileSync(path.join(dir, "releases.json"), JSON.stringify([{ tag_name: "v0.0.2-nightly.20261029.1", prerelease: true, draft: false, published_at: "2026-10-29T00:00:00Z", assets: [] }]))
    const done = Bun.spawnSync(["bun", path.join(import.meta.dir, "release-notes.ts"), "--tag", "v0.0.2-nightly.20261030.2", "--repository", "MendCode/MendCode", "--releases", "releases.json", "--out", "notes.md", "--title-out", "title.txt"], { cwd: dir, env, stderr: "pipe" })
    expect({ code: done.exitCode, err: done.stderr.toString() }).toEqual({ code: 0, err: "" })
    const notes = readFileSync(path.join(dir, "notes.md"), "utf8")
    expect(readFileSync(path.join(dir, "title.txt"), "utf8")).toBe("MendCode Nightly — 2026-10-30 · Build 2\n")
    expect(notes).toContain("\nSecond.\n\n## New\n\n- Two.\n")
    expect(notes).not.toContain("- One.")
    expect(notes).toContain("1 commit since v0.0.2-nightly.20261029.1:")
    expect(notes).toContain("2 files changed: CHANGELOG.md (1), a.ts (1).")
    // Code changed but nothing new under Unreleased: the command fails and writes nothing.
    writeFileSync(path.join(dir, "a.ts"), "export const changed = 1\n")
    git("commit", "-q", "-am", "three"); git("tag", "v0.0.2-nightly.20261031.3")
    writeFileSync(path.join(dir, "releases.json"), JSON.stringify([{ tag_name: "v0.0.2-nightly.20261030.2", prerelease: true, draft: false, published_at: "2026-10-30T00:00:00Z", assets: [] }]))
    rmSync(path.join(dir, "notes.md"))
    const empty = Bun.spawnSync(["bun", path.join(import.meta.dir, "release-notes.ts"), "--tag", "v0.0.2-nightly.20261031.3", "--repository", "MendCode/MendCode", "--releases", "releases.json", "--out", "notes.md"], { cwd: dir, env, stderr: "pipe" })
    expect(empty.exitCode).not.toBe(0)
    expect(empty.stderr.toString()).toContain("[RELEASE_NOTES]: nothing to say")
    expect(Bun.file(path.join(dir, "notes.md")).size).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
