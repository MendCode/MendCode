import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GhRun } from "../src/pr-watch"
import { MAINTAINERS_ONLY } from "../src/pr-review/commands"
import { gitRun } from "../src/pr-review/context"
import type { ForgeComment, ForgeMarker, PrFacts, ReviewProvider } from "../src/pr-review/contracts"
import type { ReviewSessionFactory } from "../src/pr-review/engine"
import { findingId } from "../src/pr-review/findings"
import { DAEMON_FEATURES, PROVIDER_CAPABILITIES, checkoutForge } from "../src/pr-review/providers"
import type { GhCall } from "../src/pr-review/publish"
import { createPrReviewService } from "../src/pr-review/service"

/**
 * The daemon on GitLab and Gitea checkouts (docs/pr-review.md, providers): watch → job → review post → dedupe on the same head →
 * `@mendcode` mention → fix push, through `createPrReviewService` with the real review run, against a fake adapter per forge
 * whose PR heads are a bare git origin's branches. The checkout's origin names the forge's host (`remote.origin.url`), and
 * `url.<bare>.insteadOf` sends git's own fetches and pushes to the bare origin. `gh` is a fake that fails every call and records
 * it: a GitLab or Gitea checkout must never reach it. Nothing reaches the network, and nothing here is live evidence.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
const until = async (check: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out waiting"); await Bun.sleep(10) } }
const git = async (cwd: string, ...args: string[]) => { const done = await gitRun(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd); if (done.code) throw new Error(`git ${args.join(" ")}: exit ${done.code} ${done.out}`); return done.out.trim() }

type Kind = "gitlab" | "gitea"
const HOST: Record<Kind, string> = { gitlab: "https://gitlab.example.com", gitea: "https://gitea.example.com" }
const HEAD_REF = (kind: Kind, number: number) => kind === "gitlab" ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`

/** A bare origin and a clone whose origin URL names the forge's host; git itself reaches the bare origin through `insteadOf`. */
async function repository(kind: Kind, yaml: string) {
  const origin = temp(`forge-origin-${kind}-`), dir = temp(`forge-clone-${kind}-`)
  const url = `${HOST[kind]}/acme/app.git`
  await git(origin, "init", "-q", "--bare", "-b", "main")
  await git(dir, "init", "-q", "-b", "main")
  await git(dir, "config", "commit.gpgsign", "false")
  await git(dir, "config", "user.name", "t")
  await git(dir, "config", "user.email", "t@example.invalid")
  await git(dir, "config", `url.${origin}.insteadOf`, url)
  mkdirSync(path.join(dir, ".mendcode"))
  writeFileSync(path.join(dir, ".mendcode", "review.yaml"), yaml)
  writeFileSync(path.join(dir, "a.ts"), "export const one = 1\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "base")
  const main = await git(dir, "rev-parse", "HEAD")
  await git(dir, "remote", "add", "origin", url)
  await git(dir, "push", "-q", "origin", "main")
  async function push(number: number, branch: string, content: string) {
    const exists = (await gitRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], dir)).code === 0
    await git(dir, "checkout", "-q", ...(exists ? [branch] : ["-b", branch, "main"]))
    writeFileSync(path.join(dir, `${branch}.ts`), content)
    await git(dir, "add", "-A")
    await git(dir, "commit", "-q", "-m", `${branch}: ${content.trim()}`)
    await git(dir, "push", "-q", "-f", "origin", `${branch}:refs/heads/${branch}`, `${branch}:${HEAD_REF(kind, number)}`)
    const sha = await git(dir, "rev-parse", "HEAD")
    await git(dir, "checkout", "-q", "main")
    return sha
  }
  return { origin, dir, main, url, push }
}

/**
 * The forge as the adapter shows it: PRs from the bare origin's branches (the forge's head ref follows its branch, as GitLab's and
 * Gitea's do), conversation and diff comments with authors, posts (Gitea reviews, GitLab notes) idempotent by marker, permissions.
 */
function fakeForge(kind: Kind, repo: Awaited<ReturnType<typeof repository>>, levels: Record<string, "admin" | "write" | "read">) {
  const prs: Array<{ number: number; branch: string; body?: string }> = []
  const comments = new Map<number, ForgeComment[]>()
  const posts = new Map<number, ForgeMarker[]>()
  const writes: string[] = []
  const resolved: string[] = []
  let ids = 100
  const tip = async (branch: string) => (await gitRun(["rev-parse", `refs/heads/${branch}`], repo.origin)).out.trim()
  const facts = async (pr: { number: number; branch: string; body?: string }): Promise<PrFacts> => {
    const head = await tip(pr.branch)
    await gitRun(["update-ref", HEAD_REF(kind, pr.number), head], repo.origin)
    return { number: pr.number, title: `PR ${pr.number}`, ...(pr.body ? { body: pr.body } : {}), head, base: repo.main, baseRef: "main", headRef: pr.branch, draft: false, labels: [], author: "bob", authorIsBot: false, fork: false, maintainerCanModify: true, requested: [], assignees: [], url: `${HOST[kind]}/acme/app/pulls/${pr.number}`, open: true }
  }
  const find = (number: number) => { const pr = prs.find((item) => item.number === number); if (!pr) throw new Error(`[PR_REVIEW]: no pull request #${number}`); return pr }
  const add = (number: number, comment: Omit<ForgeComment, "id" | "createdAt">) => { const item = { ...comment, id: ++ids, createdAt: new Date().toISOString() }; comments.set(number, [...comments.get(number) ?? [], item]); return item }
  const provider: ReviewProvider = {
    kind, capabilities: PROVIDER_CAPABILITIES[kind],
    repoOf: async () => "acme/app",
    headRef: (number) => HEAD_REF(kind, number),
    listOpen: async () => ({ ok: true, prs: await Promise.all(prs.map(facts)) }),
    view: async ({ number }) => facts(find(number)),
    permission: async ({ login }) => levels[login] ?? "none",
    self: async () => "mendbot",
    files: async ({ number }) => [`${find(number).branch}.ts`],
    async publish({ number, head, body, comments: inline, marker }) {
      if ((await facts(find(number))).head !== head) return { ok: false, reason: "the head moved; nothing was posted", retryable: false }
      const earlier = (posts.get(number) ?? []).find((post) => post.body.includes(marker))
      if (earlier) return { ok: true, remote: `review:${earlier.id}`, comments: 0, movedToBody: 0, duplicate: true }
      writes.push(`publish #${number}`)
      const post = { id: ++ids, author: "mendbot", body, ...(kind === "gitea" ? { commit: head, state: "COMMENT" } : {}) }
      posts.set(number, [...posts.get(number) ?? [], post])
      for (const comment of inline) add(number, { author: "mendbot", body: comment.body, surface: "review", path: comment.path, line: comment.line, discussion: `d${ids}` })
      return { ok: true, remote: `review:${post.id}`, comments: inline.length, movedToBody: 0 }
    },
    async findMarker({ number, marker }) { const post = (posts.get(number) ?? []).find((item) => item.body.includes(marker)); return post ? { found: true, remote: `review:${post.id}` } : { found: false } },
    comments: async ({ number }) => ({ ok: true, comments: [...comments.get(number) ?? []] }),
    async comment({ number, body, edit }) {
      writes.push(edit === undefined ? `comment #${number}` : `edit ${edit}`)
      if (edit !== undefined) { const item = (comments.get(number) ?? []).find((entry) => entry.id === edit); if (!item) return { ok: false, reason: "404" }; item.body = body; item.updatedAt = new Date().toISOString(); return { ok: true, id: edit } }
      return { ok: true, id: add(number, { author: "mendbot", body, surface: "issue" }).id }
    },
    async reply({ number, to, body }) { writes.push(`reply #${number} to ${to.id}`); return { ok: true, id: add(number, { author: "mendbot", body, surface: to.surface, ...(to.discussion ? { discussion: to.discussion } : {}) }).id } },
    markers: async ({ number }) => ({ ok: true, posts: [...posts.get(number) ?? []] }),
    pushTarget: async ({ number }) => { const pr = await facts(find(number)); return { branch: pr.headRef, head: pr.head, base: pr.base, baseRef: "main", repo: "acme/app", fork: false, pushable: true } },
    ...(kind === "gitlab" ? {
      threads: async ({ number }: { number: number }) => (comments.get(number) ?? []).filter((item) => item.surface === "review" && item.discussion).map((item) => ({ id: item.discussion!, resolved: resolved.includes(item.discussion!), body: item.body })),
      resolve: async ({ discussion }: { discussion: string }) => { resolved.push(discussion); return true },
    } : {}),
  }
  /** Someone else writes a conversation comment (an `@mendcode` command the watch polls). */
  const mention = (number: number, author: string, body: string) => add(number, { author, body, surface: "issue" })
  return { provider, prs, comments, posts, writes, mention, tip }
}

const FINDING = { path: "feature.ts", line: 1, severity: "major", category: "correctness", summary: "one is now 2", detail: "Callers expect 1.", evidence: ["feature.ts:1"] }
const FINDING_ID = findingId({ path: FINDING.path, line: FINDING.line, category: FINDING.category, summary: FINDING.summary })
/** Scripted review children: a review turn reports `FINDING`, a verify turn confirms it. */
function model() {
  const asked: string[] = []
  /** The language each review child was pinned to. */
  const languages: Array<string | undefined> = []
  const factory = (): ReviewSessionFactory => async ({ purpose, language }) => ({
    id: `ses_${purpose}`,
    async send() {
      asked.push(purpose)
      languages.push(language)
      const text = purpose === "review" ? JSON.stringify({ summary: "Changes one.", findings: [FINDING] }) : JSON.stringify({ verdicts: [{ id: FINDING_ID, verdict: "confirmed", evidence: ["feature.ts:1 exports 2"] }] })
      return { text, tokens: { input: 1_000, output: 100 } }
    },
    async close() {},
  }) as never
  return { factory, asked, languages }
}
const fixer = (_owner: string, worktree: string): ReviewSessionFactory => async () => ({ id: "ses_fix", async send() { writeFileSync(path.join(worktree, "feature.ts"), "export const one = 1\n"); return { text: "fixed", tokens: { input: 5, output: 5 } } }, async close() {} }) as never

function daemon(kind: Kind, repo: Awaited<ReturnType<typeof repository>>, forge: ReturnType<typeof fakeForge>) {
  const ghCalls: string[][] = []
  const run: GhRun = async ({ argv }) => { ghCalls.push(argv); return { code: 1, out: "", err: "gh must not be used for this checkout" } }
  const call: GhCall = async ({ argv }) => { ghCalls.push(argv); return { code: 1, out: "", err: "gh must not be used for this checkout" } }
  const brain = model()
  const notices: string[] = []
  const asked: Array<{ kind: string; baseUrl: string; repo: string }> = []
  const service = createPrReviewService({
    dir: temp(`forge-data-${kind}-`), run, call, intervalMs: 3_600_000, enabled: () => true, graphOn: () => false,
    sessionDirectory: () => repo.dir, sessionExists: () => true, notify: (_session, text) => notices.push(text),
    sessions: brain.factory, editor: fixer, schedule: async (job) => { await job() }, random: () => 0.5,
    providers: (input) => { asked.push({ kind: input.kind, baseUrl: input.baseUrl, repo: input.repo }); return forge.provider },
  })
  cleanups.push(() => service.stop())
  return { service, notices, ghCalls, brain, asked, jobs: () => service.platform.jobs.all() }
}

for (const kind of ["gitlab", "gitea"] as const) {
  const name = kind === "gitlab" ? "GitLab" : "Gitea"
  describe(`${name} through its adapter`, () => {
    test("watch → job → one review post → no second post of the same head → mentions answered and refused → a fix pushed to the branch; gh is never used", async () => {
      const repo = await repository(kind, "enabled: true\nfixes: true\n")
      const forge = fakeForge(kind, repo, { mendbot: "admin", ana: "write", eve: "read" })
      const d = daemon(kind, repo, forge)
      expect((await d.service.control({ sessionId: "ses_a", action: "publish-on" })).ok).toBe(true)
      const watched = await d.service.control({ sessionId: "ses_a", action: "watch-repo" })
      expect(watched.ok).toBe(true)
      // What the daemon does not do on this forge is said when the watch starts.
      expect(watched.ok && watched.text).toContain(`(${name}, acme/app)`)
      expect(watched.ok && watched.text).toContain("failing checks are not explained")
      if (kind === "gitea") expect(watched.ok && watched.text).toContain("thread is not resolved")
      expect(d.asked).toEqual([{ kind, baseUrl: HOST[kind], repo: "acme/app" }])

      // A new PR is reviewed once, as a durable job of this forge, and the review is posted through the adapter.
      const head = await repo.push(12, "feature", "export const one = 2\n")
      forge.prs.push({ number: 12, branch: "feature" })
      await d.service.tick()
      await until(() => d.jobs().some((job) => job.state === "done"))
      const [job] = d.jobs()
      expect(job).toMatchObject({ provider: kind, repo: "acme/app", number: 12, head, base: repo.main, state: "done" })
      expect(d.brain.asked).toEqual(["review", "verify"])
      const posted = forge.posts.get(12) ?? []
      expect(posted).toHaveLength(1)
      expect(posted[0]!.body).toContain(`<!-- mendcode:review head=${head} -->`)
      expect(posted[0]!.body).toMatch(/<!-- mendcode:reviewer=global config=\S+ effect=[0-9a-f]{16} -->/)
      expect(forge.comments.get(12)!.filter((item) => item.surface === "review").map((item) => item.path)).toEqual(["feature.ts"])
      // The job claimed the PR with a marker comment (visible: posting is allowed) and released it by editing that comment.
      const claims = forge.comments.get(12)!.filter((item) => item.surface === "issue" && item.body.includes("mendcode:claim"))
      expect(claims).toHaveLength(1)
      expect(claims[0]!.body).toContain("released")

      // The same head again: no new event, and a manual review of it posts nothing new.
      await d.service.tick()
      expect((await d.service.control({ sessionId: "ses_a", action: "review", pr: "12" })).ok).toBe(true)
      await until(() => d.jobs().filter((item) => item.state === "done").length === 2)
      expect(forge.posts.get(12)).toHaveLength(1)
      expect(forge.writes.filter((write) => write.startsWith("publish"))).toEqual(["publish #12"])

      // A read-only commenter is refused in the thread; a writer's `@mendcode review` of a reviewed head is not reviewed again.
      const refused = forge.mention(12, "eve", "@mendcode pause")
      const again = forge.mention(12, "ana", "@mendcode review")
      await d.service.tick()
      await until(() => forge.writes.some((write) => write === `reply #12 to ${refused.id}`))
      const answer = forge.comments.get(12)!.find((item) => item.body.includes(`<!-- mendcode:answers=${refused.id} -->`))
      expect(answer?.body).toContain(MAINTAINERS_ONLY)
      // Reviewed before anyone asked: one reply in the thread names that review, and nothing is reviewed again.
      await until(() => d.notices.some((text) => text.includes("already reviewed this head")))
      expect(forge.writes.filter((write) => write === `reply #12 to ${again.id}`)).toHaveLength(1)
      expect(forge.comments.get(12)!.find((item) => item.body.includes(`<!-- mendcode:answers=${again.id} -->`))?.body).toContain("already reviewed this head")
      expect(forge.posts.get(12)).toHaveLength(1)

      // `@mendcode fix` from a writer: one commit pushed to the PR's branch, answered in the thread once.
      const fix = forge.mention(12, "ana", "@mendcode fix make one 1 again")
      await d.service.tick()
      await until(() => forge.writes.includes(`reply #12 to ${fix.id}`))
      const tip = await forge.tip("feature")
      expect(tip).not.toBe(head)
      expect(await git(repo.origin, "show", `${tip}:feature.ts`)).toBe("export const one = 1")
      expect(forge.comments.get(12)!.find((item) => item.body.includes(`<!-- mendcode:answers=${fix.id} -->`))?.body).toContain(`Pushed ${tip.slice(0, 12)}`)
      // Answered once: another poll does not answer it again.
      await d.service.tick()
      expect(forge.writes.filter((write) => write === `reply #12 to ${fix.id}`)).toHaveLength(1)

      expect(d.ghCalls).toEqual([])
      const watches = JSON.parse(readFileSync(path.join(d.service.platform.handle.dataDir, "pr-review", "watches.json"), "utf8")) as { watches: Array<{ provider?: string; repo?: string; login?: string; ended?: unknown }> }
      expect(watches.watches.find((item) => !item.ended)).toMatchObject({ provider: kind, repo: "acme/app", login: "mendbot" })
    }, 30_000)

    test("template.language auto reads the PR's description through the adapter, not the title alone", async () => {
      const repo = await repository(kind, "enabled: true\ntemplate:\n  language: auto\n")
      const forge = fakeForge(kind, repo, { mendbot: "admin" })
      const d = daemon(kind, repo, forge)
      await repo.push(7, "feature", "export const one = 2\n")
      forge.prs.push({ number: 7, branch: "feature", body: "Este cambio corrige la validación de los usuarios cuando no hay sesión y también elimina el código que ya no se usa en el servidor." })
      expect((await d.service.control({ sessionId: "ses_a", action: "review", pr: "7" })).ok).toBe(true)
      await until(() => d.jobs()[0]?.state === "done")
      expect(d.brain.languages.length).toBeGreaterThan(0)
      expect(new Set(d.brain.languages)).toEqual(new Set(["Spanish"]))
    }, 30_000)

    test("/pr review N on an unwatched checkout runs as a job of that forge and posts through its adapter", async () => {
      const repo = await repository(kind, "enabled: true\n")
      const forge = fakeForge(kind, repo, { mendbot: "admin" })
      const d = daemon(kind, repo, forge)
      await d.service.control({ sessionId: "ses_a", action: "publish-on" })
      const head = await repo.push(7, "feature", "export const one = 2\n")
      forge.prs.push({ number: 7, branch: "feature" })
      expect((await d.service.control({ sessionId: "ses_a", action: "review", pr: "7" })).ok).toBe(true)
      await until(() => d.jobs()[0]?.state === "done")
      expect(d.jobs()[0]).toMatchObject({ provider: kind, head })
      expect(forge.posts.get(7)).toHaveLength(1)
      expect(DAEMON_FEATURES[kind].resolveThreads).toBe(kind === "gitlab")
      expect(d.ghCalls).toEqual([])
    }, 30_000)
  })
}

describe("which checkouts are GitLab or Gitea", () => {
  test("the origin URL as written names the forge; `mendcode.forge` names a self-hosted host; a local path stays gh's", async () => {
    const dir = temp("forge-detect-")
    await git(dir, "init", "-q", "-b", "main")
    expect(await checkoutForge({ directory: dir })).toMatchObject({ kind: undefined })
    await git(dir, "remote", "add", "origin", "http://127.0.0.1:3917/acme/app.git")
    expect((await checkoutForge({ directory: dir })).kind).toBeUndefined()
    await git(dir, "config", "mendcode.forge", "gitea")
    expect(await checkoutForge({ directory: dir })).toMatchObject({ kind: "gitea", repo: "acme/app", baseUrl: "http://127.0.0.1:3917" })
    await git(dir, "remote", "set-url", "origin", "git@127.0.0.1:acme/app.git")
    await git(dir, "config", "mendcode.forge", "gitlab")
    await git(dir, "config", "mendcode.forgeUrl", "http://127.0.0.1:8929/")
    expect(await checkoutForge({ directory: dir })).toMatchObject({ kind: "gitlab", repo: "acme/app", baseUrl: "http://127.0.0.1:8929" })
    await git(dir, "remote", "set-url", "origin", "/tmp/somewhere/app.git")
    expect((await checkoutForge({ directory: dir })).kind).toBeUndefined()
  })
})
