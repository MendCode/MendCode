import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { gitRun } from "../src/pr-review/context"
import type { PrFacts } from "../src/pr-review/contracts"
import { DEFAULT_REGISTRY, lacksText, mayDo, parseRegistry, readRegistry, resolveReviewer, route, runsHere, type ReviewerRegistry } from "../src/pr-review/registry"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function repo(base: Record<string, string>, head: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-review-registry-")))
  temps.push(dir)
  const git = async (...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], dir); if (done.code) throw new Error(args.join(" ")) }
  const write = (files: Record<string, string>) => { for (const [file, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text) } }
  await git("init", "-q", "-b", "main")
  write({ "README.md": "x\n", ...base })
  await git("add", "-A")
  await git("commit", "-q", "-m", "base")
  await git("checkout", "-q", "-b", "feature")
  write({ "change.txt": "y\n", ...head })
  await git("add", "-A")
  await git("commit", "-q", "-m", "head")
  return dir
}

const facts = (patch: Partial<PrFacts> = {}): PrFacts => ({ number: 7, head: "a".repeat(40), base: "b".repeat(40), baseRef: "main", headRef: "feature", draft: false, labels: [], author: "carol", authorIsBot: false, fork: false, requested: [], assignees: [], ...patch })

const TEAM = `
version: 1
reviewers:
  - id: global
    scope: global
    capabilities: [review, fix, publish]
  - id: sec
    scope: global
    areas: ["**/auth/**"]
  - id: backend
    scope: personal
    login: Alice
    areas: ["src/api/**", "packages/daemon/**"]
    capabilities: [review, fix]
  - id: frontend
    scope: personal
    login: bob
    areas: ["web/**"]
  - id: docs-bot
    scope: personal
    login: dana
    areas: ["docs/**"]
    capabilities: [publish]
routing:
  labels:
    security: sec
`
const team = (): ReviewerRegistry => { const parsed = parseRegistry(TEAM); expect(parsed.problems).toEqual([]); return parsed.registry }

describe("reviewer registry", () => {
  test("no reviewers.yaml (or an empty reviewer list) is a single implicit global reviewer", () => {
    expect(parseRegistry(undefined)).toEqual({ registry: DEFAULT_REGISTRY, problems: [], source: "default" })
    expect(parseRegistry("reviewers: []\n")).toEqual({ registry: DEFAULT_REGISTRY, problems: [], source: "default" })
    expect(DEFAULT_REGISTRY.reviewers).toEqual([{ id: "global", scope: "global", areas: [], capabilities: ["review", "fix", "publish"] }])
  })

  test("a listed team parses with defaults filled: areas empty, every capability (review, fix, publish, as before they were enforced), the first area-less global reviewer as the default", () => {
    const registry = team()
    expect(registry.routing).toEqual({ default: "global", global: "always", labels: { security: "sec" } })
    expect(registry.reviewers.find((entry) => entry.id === "frontend")).toEqual({ id: "frontend", scope: "personal", login: "bob", areas: ["web/**"], capabilities: ["review", "fix", "publish"] })
    expect(registry.reviewers.find((entry) => entry.id === "backend")!.capabilities).toEqual(["review", "fix"])
  })

  test("mayDo: a listed capability or no entry at all (an unlisted reviewer keeps today's behaviour); lacksText names the reviewer, the capability and the file", () => {
    const registry = team()
    const backend = registry.reviewers.find((entry) => entry.id === "backend")!
    expect(mayDo(backend, "fix")).toBe(true)
    expect(mayDo(backend, "publish")).toBe(false)
    expect(mayDo(undefined, "publish")).toBe(true)
    expect(lacksText(backend, "publish")).toBe("reviewer `backend` has no `publish` capability in `.mendcode/reviewers.yaml` on the base branch")
  })

  test("a login follows the checkout's forge: GitLab and Gitea usernames may hold '.' and '_' (never a trailing '.'); GitHub keeps its own syntax", () => {
    const text = (login: string) => `reviewers:\n  - { id: global, scope: global }\n  - { id: ana, scope: personal, login: ${login}, areas: ['src/**'] }\n`
    for (const forge of ["gitlab", "gitea"] as const) {
      for (const login of ["ana.lopez_dev", "_ana", "ana-", "a", "ana.lopez.2"]) {
        const parsed = parseRegistry(text(login), forge)
        expect(parsed.problems).toEqual([])
        expect(parsed.registry.reviewers[1]).toMatchObject({ id: "ana", login })
      }
      for (const login of ["ana.", "-ana", "ana lopez", "ana@x"]) expect(parseRegistry(text(JSON.stringify(login)), forge).problems[0]).toContain("reviewers.1.login")
    }
    // A GitHub checkout (and one whose forge is not known) refuses what GitHub would never call a login.
    expect(parseRegistry(text("ana.lopez_dev")).problems[0]).toContain("reviewers.1.login: a GitHub login")
    expect(parseRegistry(text("ana.lopez_dev"), "github").problems[0]).toContain("reviewers.1.login: a GitHub login")
    expect(parseRegistry(text("ana-lopez"), "github").problems).toEqual([])
    // The routing of a dotted username works like any other login, case-insensitively.
    const gitlab = parseRegistry(text("Ana.Lopez"), "gitlab").registry
    expect(route({ facts: facts({ requested: ["ana.lopez"] }), files: [], registry: gitlab }).map((assignment) => assignment.reviewer)).toEqual(["global", "ana"])
    expect(runsHere(gitlab.reviewers[1]!, { device: "d", login: "ana.lopez" })).toBe(true)
  })

  test("readRegistry reads a GitLab checkout's registry with GitLab's username syntax", async () => {
    const dir = await repo({ ".mendcode/reviewers.yaml": "reviewers:\n  - { id: global, scope: global }\n  - { id: ana, scope: personal, login: ana.lopez }\n" }, {})
    expect((await readRegistry({ directory: dir, ref: "main", git: gitRun, forge: "gitlab" })).registry.reviewers.map((entry) => entry.login)).toEqual([undefined, "ana.lopez"])
    expect((await readRegistry({ directory: dir, ref: "main", git: gitRun })).source).toBe("default")
  })

  test("readRegistry reads the base ref, so a pull request cannot add itself as a reviewer", async () => {
    const dir = await repo({ ".mendcode/reviewers.yaml": TEAM }, { ".mendcode/reviewers.yaml": "reviewers:\n  - id: mallory\n    scope: personal\n    login: mallory\n    areas: ['**']\n" })
    const fromBase = await readRegistry({ directory: dir, ref: "main", git: gitRun })
    expect(fromBase.source).toBe("file")
    expect(fromBase.registry.reviewers.map((entry) => entry.id)).toEqual(["global", "sec", "backend", "frontend", "docs-bot"])
    const missing = await readRegistry({ directory: await repo({}, {}), ref: "main", git: gitRun })
    expect(missing).toEqual({ registry: DEFAULT_REGISTRY, problems: [], source: "default" })
  })

  test("a YAML syntax error names its line and falls back to the implicit global reviewer", () => {
    const parsed = parseRegistry("version: 1\nreviewers:\n  - id: global\n    scope: [global\n")
    expect(parsed.registry).toEqual(DEFAULT_REGISTRY)
    expect(parsed.source).toBe("default")
    expect(parsed.problems[0]).toMatch(/^\[PR_REVIEW\]: \.mendcode\/reviewers\.yaml line \d+: .*; the implicit global reviewer used$/)
  })

  test("a schema problem names the field", () => {
    const parsed = parseRegistry("reviewers:\n  - id: global\n    scope: everyone\n")
    expect(parsed.registry).toEqual(DEFAULT_REGISTRY)
    expect(parsed.problems[0]).toContain("reviewers.0.scope")
  })

  test("the registry holds shared facts only: memory, profile or notes keys are refused, never carried along", () => {
    for (const text of [
      "reviewers:\n  - id: global\n    scope: global\n    memory: 'alice prefers terse reviews'\n",
      "reviewers:\n  - id: alice\n    scope: personal\n    login: alice\n    profile: { tone: blunt }\n",
      "memory: [x]\nreviewers:\n  - id: global\n    scope: global\n",
    ]) {
      const parsed = parseRegistry(text)
      expect(parsed.registry).toEqual(DEFAULT_REGISTRY)
      expect(parsed.problems.length).toBeGreaterThan(0)
      expect(parsed.problems[0]).toMatch(/Unrecognized key/)
    }
  })

  test("unknown reviewer ids in routing are refused with the field that names them", () => {
    expect(parseRegistry("reviewers:\n  - id: global\n    scope: global\nrouting:\n  labels: { security: sec }\n").problems).toEqual(['[PR_REVIEW]: .mendcode/reviewers.yaml routing.labels.security: unknown reviewer "sec"; the implicit global reviewer used'])
    expect(parseRegistry("reviewers:\n  - id: global\n    scope: global\nrouting:\n  default: nobody\n").problems[0]).toContain('routing.default: unknown reviewer "nobody"')
    expect(parseRegistry("reviewers:\n  - id: global\n    scope: global\nrouting:\n  fallback: ghost\n").problems[0]).toContain('routing.fallback: unknown reviewer "ghost"')
  })

  test("duplicate ids, a personal reviewer without a login and a personal default are problems", () => {
    expect(parseRegistry("reviewers:\n  - { id: a, scope: global }\n  - { id: a, scope: global }\n").problems[0]).toContain('reviewers.1.id: duplicate reviewer "a"')
    expect(parseRegistry("reviewers:\n  - { id: a, scope: personal }\n").problems[0]).toContain("reviewers.0.login: a personal reviewer needs the login")
    expect(parseRegistry("reviewers:\n  - { id: a, scope: personal, login: al }\nrouting: { default: a }\n").problems[0]).toContain("the default must be global")
  })

  test("resolveReviewer finds a listed reviewer by id or login (any case, with or without @) and refuses anyone else", () => {
    const registry = team()
    expect(resolveReviewer(registry, "backend")).toMatchObject({ ok: true, reviewer: { id: "backend" } })
    expect(resolveReviewer(registry, "@alice")).toMatchObject({ ok: true, reviewer: { id: "backend" } })
    const unknown = resolveReviewer(registry, "mallory")
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toBe('[PR_REVIEW]: "mallory" is not a reviewer in .mendcode/reviewers.yaml')
  })
})

describe("routing", () => {
  test("matrix: requested, assigned, label and area routes each give the reviewer and a visible reason, plus the global reviewer", () => {
    const registry = team()
    const cases: Array<{ name: string; facts: PrFacts; files: string[]; expected: Array<{ reviewer: string; reason: string; areas?: string[] }> }> = [
      { name: "nothing matches", facts: facts(), files: ["README.md"], expected: [{ reviewer: "global", reason: "the repository's global reviewer" }] },
      { name: "area", facts: facts(), files: ["src/api/users.ts"], expected: [{ reviewer: "global", reason: "the repository's global reviewer" }, { reviewer: "backend", reason: "touches src/api/** (backend: @Alice)", areas: ["src/api/**"] }] },
      { name: "requested", facts: facts({ requested: ["bob"] }), files: ["README.md"], expected: [{ reviewer: "global", reason: "the repository's global reviewer" }, { reviewer: "frontend", reason: "review requested from @bob" }] },
      { name: "assigned and area together", facts: facts({ assignees: ["ALICE"] }), files: ["packages/daemon/src/x.ts"], expected: [{ reviewer: "global", reason: "the repository's global reviewer" }, { reviewer: "backend", reason: "assigned to @Alice; touches packages/daemon/** (backend: @Alice)", areas: ["packages/daemon/**"] }] },
      { name: "label", facts: facts({ labels: ["security"] }), files: [], expected: [{ reviewer: "global", reason: "the repository's global reviewer" }, { reviewer: "sec", reason: "label security → sec" }] },
      { name: "global area reviewer", facts: facts(), files: ["src/auth/session.ts"], expected: [{ reviewer: "global", reason: "the repository's global reviewer" }, { reviewer: "sec", reason: "touches **/auth/** (sec)", areas: ["**/auth/**"] }] },
    ]
    for (const entry of cases) {
      const got = route({ facts: entry.facts, files: entry.files, registry })
      expect({ name: entry.name, got: got.map(({ reviewer, reason, areas }) => ({ reviewer, reason, ...(areas.length ? { areas } : {}) })) }).toEqual({ name: entry.name, got: entry.expected })
      for (const assignment of got) expect(assignment.reason.length).toBeGreaterThan(0)
    }
  })

  test("a requested login or label the registry does not list routes nowhere", () => {
    const got = route({ facts: facts({ requested: ["mallory"], assignees: ["eve"], labels: ["urgent"] }), files: ["x.ts"], registry: team() })
    expect(got.map((entry) => entry.reviewer)).toEqual(["global"])
  })

  test("a requester can only direct work to a listed reviewer: an unknown target adds nothing", () => {
    const registry = team()
    expect(route({ facts: facts(), files: [], registry, requesterLogin: "carol", target: "frontend" })).toContainEqual({ reviewer: "frontend", scope: "personal", reason: "@carol asked for frontend", areas: [] })
    expect(route({ facts: facts(), files: [], registry, requesterLogin: "mallory", target: "mallory" }).map((entry) => entry.reviewer)).toEqual(["global"])
  })

  test("a reviewer without the review capability is never assigned a review", () => {
    expect(route({ facts: facts({ requested: ["dana"] }), files: ["docs/a.md"], registry: team() }).map((entry) => entry.reviewer)).toEqual(["global"])
  })

  test("personal-only: the global reviewer steps back when a personal reviewer matches and is the fallback otherwise; fallback none routes nowhere", () => {
    const text = TEAM.replace("routing:\n", "routing:\n  global: personal-only\n")
    const registry = parseRegistry(text).registry
    expect(route({ facts: facts(), files: ["web/app.tsx"], registry }).map((entry) => entry.reviewer)).toEqual(["frontend"])
    expect(route({ facts: facts(), files: ["README.md"], registry })).toEqual([{ reviewer: "global", scope: "global", reason: "no personal reviewer matches; fallback", areas: [] }])
    const none = parseRegistry(text.replace("routing:\n", "routing:\n  fallback: none\n"))
    expect(none.problems).toEqual([])
    expect(route({ facts: facts(), files: ["README.md"], registry: none.registry })).toEqual([])
    const toSec = parseRegistry(text.replace("routing:\n", "routing:\n  fallback: sec\n")).registry
    expect(route({ facts: facts(), files: ["README.md"], registry: toSec }).map((entry) => entry.reviewer)).toEqual(["sec"])
  })

  test("a login with two personal reviewers goes to the one whose areas the change touches", () => {
    const registry = parseRegistry("reviewers:\n  - { id: global, scope: global }\n  - { id: alice-api, scope: personal, login: alice, areas: ['src/api/**'] }\n  - { id: alice-web, scope: personal, login: alice, areas: ['web/**'] }\n").registry
    expect(route({ facts: facts({ requested: ["alice"] }), files: ["web/a.tsx"], registry }).map((entry) => entry.reviewer)).toEqual(["global", "alice-web"])
    expect(route({ facts: facts({ requested: ["alice"] }), files: ["README.md"], registry }).map((entry) => entry.reviewer)).toEqual(["global", "alice-api"])
    expect(resolveReviewer(registry, "alice").ok).toBe(false)
  })

  test("routing is deterministic: the order of files, labels and requested logins does not change the result", () => {
    const registry = team()
    const a = route({ facts: facts({ requested: ["bob", "alice"], labels: ["security", "x"] }), files: ["web/a.tsx", "src/api/b.ts", "src/auth/c.ts"], registry })
    const b = route({ facts: facts({ requested: ["alice", "bob"], labels: ["x", "security"] }), files: ["src/auth/c.ts", "src/api/b.ts", "web/a.tsx"], registry })
    expect(a).toEqual(b)
    expect(a.map((entry) => entry.reviewer)).toEqual(["global", "sec", "backend", "frontend"])
  })

  test("the global reviewer's assignment is computed from shared facts only and carries nothing but id, scope, reason and areas", () => {
    for (const assignment of route({ facts: facts({ requested: ["alice"] }), files: ["src/api/x.ts"], registry: team() })) expect(Object.keys(assignment).sort()).toEqual(["areas", "reason", "reviewer", "scope"])
  })

  test("runsHere: a pinned device must be this one; a personal reviewer runs on its login's daemon; an unpinned global one anywhere", () => {
    const registry = team()
    const backend = registry.reviewers.find((entry) => entry.id === "backend")!
    const global = registry.reviewers.find((entry) => entry.id === "global")!
    expect(runsHere(backend, { device: "pc", login: "alice" })).toBe(true)
    expect(runsHere(backend, { device: "pc", login: "bob" })).toBe(false)
    expect(runsHere(global, { device: "vps" })).toBe(true)
    expect(runsHere({ ...backend, device: "vps" }, { device: "pc", login: "alice" })).toBe(false)
    expect(runsHere({ ...backend, device: "vps" }, { device: "vps", login: "alice" })).toBe(true)
  })
})
