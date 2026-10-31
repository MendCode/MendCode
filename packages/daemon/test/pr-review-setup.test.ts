import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { MemoryEntry } from "@mendcode/protocol"
import { CONFIG_PATH } from "../src/pr-review/config"
import { createConfigControl } from "../src/pr-review/config-control"
import { gitRun } from "../src/pr-review/context"
import { claimMarker, prClaimKey } from "../src/pr-review/ownership"
import { createReviewSetup, type SetupGh, type SetupMemory } from "../src/pr-review/setup"
import { hostInstructions } from "../src/host-mcp"
import { createReviewConfigTool, NO_SELF_MENTION } from "../src/review-config-tool"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); temps.push(dir); return dir }

const git = async (dir: string, ...args: string[]) => {
  const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], dir)
  if (done.code) throw new Error(`git ${args.join(" ")}`)
  return done.out.trim()
}

/** A GitHub checkout of acme/widgets (origin is only configured, never fetched) with the given files committed on main. */
async function checkout(files: Record<string, string> = {}) {
  const dir = temp("pr-review-setup-repo-")
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "remote", "add", "origin", "https://github.com/acme/widgets.git")
  writeFileSync(path.join(dir, "README.md"), "x\n")
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "init")
  return dir
}

/** A fake gh: each answer is keyed by the start of its argument list; anything else fails like a logged-out gh. */
function fakeGh(answers: Record<string, string>): SetupGh & { calls: string[][] } {
  const calls: string[][] = []
  const gh: SetupGh = async (argv) => {
    calls.push(argv)
    const line = argv.join(" ")
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix))
    return key ? { code: 0, out: answers[key]! } : { code: 1, out: "" }
  }
  return Object.assign(gh, { calls })
}

const github = (login: string, permission: object, extra: Record<string, string> = {}) => fakeGh({
  "repo view": "acme/widgets",
  "api user": login,
  [`api repos/acme/widgets/collaborators/${login}/permission`]: JSON.stringify(permission),
  [`pr list --repo acme/widgets --state all --author ${login}`]: "[]",
  [`pr list --repo acme/widgets --state all --search reviewed-by:${login}`]: "[]",
  "api repos/acme/widgets/issues/comments": "[]",
  ...extra,
})

const memoryOf = (entries: Array<Partial<MemoryEntry>>): SetupMemory => ({ visible: () => entries as MemoryEntry[] })

describe("review setup: a repository with no config and a read-only user", () => {
  test("reports what is missing, infers the role from the permission and asks, without writing anything", async () => {
    const dir = await checkout()
    const dataDir = temp("pr-review-setup-data-")
    const gh = github("carol", { permission: "read", role_name: "read" })
    const { report, text } = await createReviewSetup({ dataDir, gh }).run(dir)

    expect(report).toMatchObject({ repo: "acme/widgets", login: "carol", permission: "read", forge: { kind: "github" } })
    expect(report.base.review).toMatchObject({ exists: false, enabled: false, language: "English", fixMode: "review" })
    expect(report.base.registry.exists).toBe(false)
    expect(report.hosted).toEqual({ onBase: false, inWorkingTree: false })
    expect(report.watches).toEqual([])
    expect(report.claims).toEqual({ read: true, others: [] })
    expect(report.personal).toMatchObject({ exists: false, version: 0, path: path.join(dataDir, "pr-review", "profiles", "github", "acme", "widgets", "carol.json") })
    expect(report.role).toMatchObject({ inferred: "contributor without write access", known: true, remembered: [] })
    expect(report.missing).toContain(`no ${CONFIG_PATH} on the base branch (HEAD): nothing is posted until it is committed there with enabled: true`)
    expect(report.missing).toContain("nothing reviews PRs automatically yet: no repo watch on this daemon and no hosted workflow on the base branch")
    expect(report.missing.some((line) => line.startsWith("carol has read permission: the repository's files need someone with write access"))).toBe(true)
    expect(report.missing).toContain("your role is inferred, not confirmed: confirm it with the developer")
    expect(report.questions[0]).toContain("on acme/widgets the signals point to contributor without write access (carol has read permission on acme/widgets)")
    expect(report.questions[1]).toContain("with read access you can set up your own personal reviewer here")
    expect(report.questions[2]).toContain("(A) the hosted GitHub workflow only")
    expect(report.questions[2]).toContain("(B, recommended when laptops sleep)")

    expect(text).toContain("Read only: nothing was changed.")
    expect(text).toContain(`${CONFIG_PATH}: absent (the defaults apply: enabled false)`)
    expect(text).toContain("Questions for the developer:")
    expect(text).toContain("Never post an @mendcode comment")
    // Read only: no gh call that writes, no data directory state, a clean working tree.
    const readOnly = (argv: string[]) => (argv[0] === "api" && !argv.some((part) => ["-X", "--method", "--input", "-f", "-F", "--field", "--raw-field"].includes(part))) || (argv[0] === "repo" && argv[1] === "view") || (argv[0] === "pr" && argv[1] === "list")
    expect(gh.calls.length).toBe(6)
    expect(gh.calls.every(readOnly)).toBe(true)
    expect(readdirSync(dataDir)).toEqual([])
    expect(await git(dir, "status", "--porcelain")).toBe("")
  })
})

describe("review setup: a maintainer with an existing review.yaml and a watch", () => {
  test("shows the base branch config, the registry, the watch, another device's claim and the role signals", async () => {
    const dir = await checkout({
      [CONFIG_PATH]: "enabled: true\nfix: { mode: fix-once, push: true }\nbudget: { tokens_per_pr: 500000 }\n",
      ".mendcode/reviewers.yaml": "version: 1\nreviewers:\n  - id: team\n    scope: global\n    login: acme-review-bot\n  - id: alice\n    scope: personal\n    login: alice\n    areas: [\"src/api/**\"]\nrouting:\n  default: team\n",
      ".github/CODEOWNERS": "# owners\nsrc/api/** @alice @bob\ndocs/** @bob\n",
    })
    const dataDir = temp("pr-review-setup-data-")
    mkdirSync(path.join(dataDir, "pr-review"), { recursive: true })
    writeFileSync(path.join(dataDir, "pr-review", "watches.json"), JSON.stringify({ version: 1, watches: [{ directory: dir, sessionId: "ses_1", createdAt: 1, seen: {}, role: "all", login: "alice", publish: "allowed", repo: "acme/widgets" }] }))
    writeFileSync(path.join(dataDir, "pr-review", "device.json"), JSON.stringify({ version: 1, id: "desk-1", label: "desk", createdAt: 1 }))
    const now = 1_800_000_000_000
    const claim = (owner: string, number: number) => claimMarker({ key: prClaimKey({ repo: "acme/widgets", number, reviewer: "alice" }), owner, fence: 1, acquiredAt: now - 1_000, expiresAt: now + 3_600_000 }, "alice")
    const comments = [{ body: `MendCode is reviewing.\n${claim("laptop-2", 7)}`, user: { login: "alice" } }, { body: claim("desk-1", 8), user: { login: "alice" } }]
    const gh = github("alice", { permission: "admin", role_name: "maintain" }, {
      "pr list --repo acme/widgets --state all --author alice": JSON.stringify([{ number: 1 }, { number: 2 }, { number: 3 }]),
      "pr list --repo acme/widgets --state all --search reviewed-by:alice": JSON.stringify([{ number: 4 }, { number: 5 }]),
      "api repos/acme/widgets/issues/comments": JSON.stringify(comments),
    })
    const { report, text } = await createReviewSetup({ dataDir, gh, now: () => now }).run(dir)

    expect(report.permission).toBe("maintain")
    expect(report.base.review).toMatchObject({ exists: true, enabled: true, fixMode: "fix-once", push: true, tokensPerPr: 500_000 })
    expect(report.base.workingTreeDiffers).toBe(false)
    expect(report.base.registry).toMatchObject({ exists: true, routing: "default team, global always" })
    expect(report.base.registry.reviewers).toEqual([{ id: "team", scope: "global", login: "acme-review-bot", areas: [] }, { id: "alice", scope: "personal", login: "alice", areas: ["src/api/**"] }])
    expect(report.watches).toEqual([{ directory: dir, role: "all", login: "alice", state: "active", publish: "posting allowed" }])
    expect(report.claims.others).toEqual([{ number: 7, reviewer: "alice", device: "laptop-2", expiresAt: now + 3_600_000 }])
    expect(report.codeowners).toEqual({ file: ".github/CODEOWNERS", patterns: ["src/api/**"] })
    expect(report.activity).toEqual({ authored: 3, reviewed: 2, limit: 30 })
    expect(report.role.inferred).toBe("maintainer")
    expect(report.role.basis).toEqual([
      "alice has maintain permission on acme/widgets",
      ".github/CODEOWNERS lists @alice for src/api/**",
      ".mendcode/reviewers.yaml lists alice as reviewer alice (personal, areas src/api/**)",
      "recent PRs: authored 3, reviewed 2",
    ])
    expect(report.missing.some((line) => line.startsWith("nothing reviews PRs"))).toBe(false)
    expect(report.missing.some((line) => line.includes(`no ${CONFIG_PATH}`))).toBe(false)
    expect(report.missing).toEqual(["your role is inferred, not confirmed: confirm it with the developer"])
    expect(report.questions[1]).toContain("configure the global reviewer (shared by everyone")
    expect(report.questions[6]).toContain("500,000 tokens per PR head")
    expect(text).toContain(`watch ${dir}: active, reviewers all as @alice, posting allowed`)
    expect(text).toContain("#7 alice on device laptop-2 until")
    expect(text).not.toContain("#8 alice")
  })

  test("an uncommitted working-tree change and a watch without posting consent are named as missing", async () => {
    const dir = await checkout({ [CONFIG_PATH]: "enabled: false\n" })
    writeFileSync(path.join(dir, CONFIG_PATH), "enabled: true\n")
    const dataDir = temp("pr-review-setup-data-")
    mkdirSync(path.join(dataDir, "pr-review"), { recursive: true })
    writeFileSync(path.join(dataDir, "pr-review", "watches.json"), JSON.stringify({ version: 1, watches: [{ directory: dir, sessionId: "ses_1", createdAt: 1, seen: {} }] }))
    const { report } = await createReviewSetup({ dataDir, gh: github("alice", { permission: "write" }) }).run(dir)
    expect(report.missing).toContain(`${CONFIG_PATH} on the base branch does not say enabled: true, so nothing is posted`)
    expect(report.missing).toContain(`the working tree's ${CONFIG_PATH} differs from the base branch: it counts only once committed and merged there`)
    expect(report.missing).toContain(`the watch of ${dir} has no posting consent yet (/pr publish on)`)
  })
})

describe("review setup: role from memory", () => {
  const entries: Array<Partial<MemoryEntry>> = [
    { memoryId: "mem_role" as MemoryEntry["memoryId"], scope: "project", category: "preferences", status: "saved", updatedAt: 2, text: "Dana is the tech lead of acme/widgets and decides the reviewer settings." },
    { memoryId: "mem_cmd" as MemoryEntry["memoryId"], scope: "project", category: "commands", status: "saved", updatedAt: 3, text: "Run bun test before committing." },
    { memoryId: "mem_pending" as MemoryEntry["memoryId"], scope: "user", category: "preferences", status: "pending", updatedAt: 4, text: "I am a maintainer everywhere." },
    { memoryId: "mem_user" as MemoryEntry["memoryId"], scope: "user", category: "preferences", status: "saved", updatedAt: 1, text: "As dana I review PRs in Spanish; token sk-abcdefghijklmnopqrstuvwxyz0123456789 is old." },
  ]

  test("a saved memory stating the user's role is surfaced with its id and scope, redacted; pending and unrelated ones are not", async () => {
    const dir = await checkout()
    const dataDir = temp("pr-review-setup-data-")
    const { report, text } = await createReviewSetup({ dataDir, gh: github("dana", { permission: "write" }), memory: memoryOf(entries) }).run(dir)
    expect(report.role.remembered.map((line) => line.id)).toEqual(["mem_role", "mem_user"])
    expect(report.role.remembered[0]).toEqual({ id: "mem_role", scope: "project", category: "preferences", text: "Dana is the tech lead of acme/widgets and decides the reviewer settings." })
    expect(report.role.remembered[1]!.scope).toBe("global")
    expect(report.role.remembered[1]!.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789")
    expect(text).toContain(`project memory mem_role: "Dana is the tech lead of acme/widgets`)
    expect(report.missing.some((line) => line.includes("your role"))).toBe(false)
  })

  test("memory turned off is not read; a new user with nothing known is asked", async () => {
    const dir = await checkout()
    const dataDir = temp("pr-review-setup-data-")
    const { report } = await createReviewSetup({ dataDir, gh: fakeGh({}), memory: memoryOf(entries), memoryEnabled: () => false }).run(dir)
    expect(report.role).toEqual({ inferred: "unknown", basis: [], remembered: [], known: false })
    expect(report.permission).toBe("unknown")
    expect(report.missing).toContain("your role on this repository is unknown: ask the developer")
    expect(report.missing).toContain("your login: gh could not say the login (gh auth status)")
    expect(report.questions[0]).toContain("nothing tells me your role on acme/widgets yet")
  })

  test("outside a checkout the report says so and still asks", async () => {
    const dir = temp("pr-review-setup-plain-")
    const { report, text } = await createReviewSetup({ dataDir: temp("pr-review-setup-data-"), gh: fakeGh({}) }).run(dir)
    expect(report.missing).toEqual([`${dir} is not a git checkout: open the session in a clone of the repository first`])
    expect(text).toContain("(not a git checkout)")
  })
})

describe("review_config setup action", () => {
  const context = (cwd: string) => ({ cwd, signal: new AbortController().signal })

  test("setup is read only, needs no scope or approval; apply still asks; the description carries the no-self-mention rule", async () => {
    const dir = await checkout()
    const dataDir = temp("pr-review-setup-data-")
    const control = createConfigControl({ dataDir, git: gitRun, repo: async () => "acme/widgets", login: async () => "carol" })
    const tool = createReviewConfigTool({ control, enabled: () => true, setup: createReviewSetup({ dataDir, gh: github("carol", { permission: "read" }) }) })
    expect(tool.permissionFor!({ action: "setup" })).toBe("read")
    expect(tool.approvalFor!({ action: "setup" })).toBe(false)
    expect(tool.approvalFor!({ action: "apply", scope: "global", patch: { enabled: true } })).toBe(true)
    expect(await tool.preview!({ action: "setup" }, context(dir))).toBeUndefined()
    const result = await tool.execute({ action: "setup" }, context(dir))
    expect(result.isError).toBe(false)
    expect(result.output).toContain("PR reviewer setup for acme/widgets")
    expect(existsSync(path.join(dir, CONFIG_PATH))).toBe(false)
    expect(readdirSync(dataDir)).toEqual([])
    expect(tool.description).toContain("call setup first")
    expect(tool.description).toContain(NO_SELF_MENTION)
    expect(NO_SELF_MENTION).toContain("never post an @mendcode comment")
    expect(NO_SELF_MENTION).toContain("/pr review <n>")
  })

  test("a Claude Code session with review_config is told to start with setup and never to mention @mendcode itself", () => {
    const told = hostInstructions([{ name: "review_config", description: "Configure the PR reviewer", parameters: { type: "object", properties: {} } }])
    expect(told).toContain("call action setup first")
    expect(told).toContain("Never post an @mendcode comment from the user's account to start a review: the user runs /pr review <n>.")
    const both = hostInstructions(["review_config", "pr_review"].map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })))
    expect(both).toContain("Review one PR now: mcp__mendcode__pr_review with action review")
    expect(both).toContain("Never post an @mendcode comment, or anything else, from the user's account to start a review.")
  })

  test("setup is refused while the reviewer is off, and says so when the session has no setup port", async () => {
    const dir = await checkout()
    const dataDir = temp("pr-review-setup-data-")
    const control = createConfigControl({ dataDir, git: gitRun, repo: async () => "acme/widgets", login: async () => "carol" })
    expect((await createReviewConfigTool({ control, enabled: () => false, setup: createReviewSetup({ dataDir, gh: fakeGh({}) }) }).execute({ action: "setup" }, context(dir))).output).toContain("/pr on")
    const bare = await createReviewConfigTool({ control, enabled: () => true }).execute({ action: "setup" }, context(dir))
    expect(bare.isError).toBe(true)
    expect(bare.output).toContain("not available")
  })
})
