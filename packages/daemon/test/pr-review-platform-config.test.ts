import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { gitRun } from "../src/pr-review/context"
import { CONFIG_PATH } from "../src/pr-review/config"
import { createConfigControl } from "../src/pr-review/config-control"
import { effectiveConfig } from "../src/pr-review/config-layers"

/**
 * Platform scenario for conversational configuration (docs/pr-review.md, "Configuration layers"): one checkout whose base branch
 * has `.mendcode/review.yaml`, and the same request said for the personal and for the global reviewer. A temp git repository and
 * a temp data directory; the login and repository are given (no `gh`).
 */

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }
async function git(cwd: string, ...args: string[]) {
  const done = await gitRun(args, cwd)
  if (done.code !== 0) throw new Error(`git ${args.join(" ")}: exit ${done.code}`)
  return done.out.trim()
}

async function checkout() {
  const dir = temp("mc-platform-config-repo-")
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "config", "user.email", "t@example.com")
  await git(dir, "config", "user.name", "T")
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, CONFIG_PATH), "enabled: true\ncap: 8\nfix:\n  mode: fix-once\n  push: false\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-qm", "reviewer config")
  return dir
}

const control = (dataDir: string) => createConfigControl({ dataDir, repo: async () => "acme/app", login: async () => "alice", now: () => 1_000 })

describe("platform config: personal and global are never confused", () => {
  test("without a scope nothing is read as either or changed; the answer names both targets", async () => {
    const repo = await checkout()
    const answer = await control(temp("mc-platform-config-data-")).run({ action: "config-apply", directory: repo, patch: { cap: 3 } })
    expect(answer.ok).toBe(false)
    expect(answer.text).toContain("Say scope global or personal")
    expect(answer.text).toContain("- global:")
    expect(answer.text).toContain("- personal:")
    expect(await git(repo, "status", "--porcelain")).toBe("")
  })
  test("'my review' narrows only the personal profile; a value the repository has off is refused, never applied, and the repository file stays byte for byte", async () => {
    const repo = await checkout()
    const data = temp("mc-platform-config-data-")
    const config = control(data)
    const before = readFileSync(path.join(repo, CONFIG_PATH), "utf8")

    const preview = await config.run({ action: "config-preview", scope: "personal", directory: repo, patch: { cap: 3, fix: { mode: "fix-loop", push: true } } })
    expect(preview.ok).toBe(true)
    expect(preview.text).toContain("nothing saved")
    expect(preview.ok && preview.config.problems?.join("\n")).toContain("personal fix.push: the repository has it off")
    expect(preview.ok && preview.config.problems?.join("\n")).toContain("personal fix.mode: fix-loop does more than the repository's fix-once")

    const refused = await config.run({ action: "config-apply", scope: "personal", directory: repo, patch: { fix: { push: true } } })
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain("Not saved")

    const applied = await config.run({ action: "config-apply", scope: "personal", directory: repo, patch: { cap: 3, template: { tone: "concise" } } })
    if (!applied.ok) throw new Error(applied.text)
    expect(applied.config).toMatchObject({ scope: "personal", login: "alice", repo: "acme/app", version: 1 })
    expect(applied.config.origins).toMatchObject({ cap: "personal", template: "personal", enabled: "repository", fix: "repository" })
    expect(applied.config.effective).toMatchObject({ cap: 3, enabled: true, fix: { mode: "fix-once", push: false } })
    expect(applied.config.target.startsWith(path.join(data, "pr-review", "profiles"))).toBe(true)
    expect(applied.text).toContain("The repository's global reviewer is unchanged.")
    expect(readFileSync(path.join(repo, CONFIG_PATH), "utf8")).toBe(before)

    // The global view is untouched by the personal profile.
    const global = await config.run({ action: "config-show", scope: "global", directory: repo })
    if (!global.ok) throw new Error(global.text)
    expect(global.config.effective).toMatchObject({ cap: 8 })
    expect(global.config.origins.cap).toBe("repository")

    // Revert: a new version equal to the old one; history only grows.
    await config.run({ action: "config-apply", scope: "personal", directory: repo, patch: { cap: 5 } })
    const reverted = await config.run({ action: "config-revert", scope: "personal", directory: repo, version: 1 })
    if (!reverted.ok) throw new Error(reverted.text)
    expect(reverted.config).toMatchObject({ version: 3, effective: { cap: 3 } })
    const history = await config.run({ action: "config-history", scope: "personal", directory: repo })
    expect(history.ok && history.config.history?.map((entry) => entry.version)).toEqual([3, 2, 1])
  })
  test("the global reviewer's config is written to the working tree only, never committed; an invalid value blocks the write", async () => {
    const repo = await checkout()
    const config = control(temp("mc-platform-config-data-"))
    const headBefore = await git(repo, "rev-parse", "HEAD")
    const invalid = await config.run({ action: "config-apply", scope: "global", directory: repo, patch: { cap: 99 } })
    expect(invalid.ok).toBe(false)
    expect(await git(repo, "status", "--porcelain")).toBe("")
    const applied = await config.run({ action: "config-apply", scope: "global", directory: repo, patch: { cap: 12 } })
    if (!applied.ok) throw new Error(applied.text)
    expect(applied.text).toContain("not staged, not committed, not pushed")
    expect(applied.config).toMatchObject({ scope: "global", version: 2, effective: { cap: 12 } })
    expect(await git(repo, "rev-parse", "HEAD")).toBe(headBefore)
    expect(await git(repo, "status", "--porcelain")).toBe(`M ${CONFIG_PATH}`)
    const back = await config.run({ action: "config-revert", scope: "global", directory: repo, version: 1 })
    if (!back.ok) throw new Error(back.text)
    expect(await git(repo, "status", "--porcelain")).toBe("")
  })
  test("an inherited override shows its origin per key, and a personal layer cannot lift the repository's budget cap to unlimited", () => {
    const layered = effectiveConfig({ repository: { preset: "strict", budget: { tokens_per_pr: 500_000 } }, personal: { cap: 4, budget: { tokens_per_pr: null } } })
    expect(layered.preset).toBe("strict")
    expect(layered.origins).toMatchObject({ profile: "preset", coverage: "preset", budget: "repository", cap: "personal" })
    expect(layered.config.budget.tokens_per_pr).toBe(500_000)
    expect(layered.problems.join("\n")).toContain("personal budget.tokens_per_pr: no cap is above the repository's 500000")
  })
})
