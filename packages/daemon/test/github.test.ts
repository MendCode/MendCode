import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, GithubContext, GithubRunInput } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"
import { createGithub, githubLocalOnly, githubPrompt, githubToolSummary, parseGithubRemote } from "../src/github"
import { fakeGithub, githubEvent } from "./github-fake"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function temp() { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b48-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }
function fixture() { const directory = temp(), fake = fakeGithub(directory), service = createGithub({ process: fake.process }); cleanup.push(() => service.dispose()); return { directory, fake, service } }
const input = (event = githubEvent(), publish = false) => ({ event, token: "local-test-token", publish })

test("GitHub protocol is additive and no operation is classified read-only", () => {
  for (const type of ["github.install", "github.run", "github.finish", "pr.checkout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  expect(githubLocalOnly()).toBe(true)
  expect(githubLocalOnly("127.0.0.1")).toBe(false)
  expect(githubLocalOnly("::1")).toBe(false)
  expect(GithubRunInput.safeParse({ ...input(), token: "invalid\nsecret" }).success).toBe(false)
  expect(GithubRunInput.safeParse({ ...input(), event: "x".repeat(256001) }).success).toBe(false)
  expect(Command.safeParse({ id: "cmd_test", clientId: "cli_test", type: "pr.checkout", directory: "/tmp", number: -1 }).success).toBe(false)
  for (const url of ["https://github.com/acme/project.git", "git@github.com:acme/project.git", "ssh://git@github.com/acme/project"]) expect(parseGithubRemote(url)).toBe("acme/project")
  for (const url of ["https://github.com.evil/acme/project", "https://user:secret@github.com/acme/project", "https://github.com/acme/project/extra", "https://gitlab.com/acme/project"]) expect(parseGithubRemote(url)).toBeUndefined()
})

test("workflow preview is local, writing is opt-in and existing/symlinked workflows are preserved", async () => {
  const h = fixture(), model = "openai/model"
  const preview = await h.service.install(h.directory, { model })
  expect(preview.written).toBe(false)
  expect(existsSync(path.join(h.directory, ".github"))).toBe(false)
  expect(preview.workflow).toContain("workflow_dispatch:")
  expect(preview.workflow).toContain("default: false")
  expect(preview.workflow).toContain("persist-credentials: false")
  expect(preview.workflow).not.toContain("opencode")
  expect(await h.service.install(h.directory, { model, write: true })).toMatchObject({ written: true })
  const file = path.join(h.directory, preview.file)
  expect(await h.service.install(h.directory, { model, write: true })).toMatchObject({ written: false })
  writeFileSync(file, "user workflow")
  await expect(h.service.install(h.directory, { model, write: true })).rejects.toThrow("preserved")
  expect(readFileSync(file, "utf8")).toBe("user workflow")
  const other = fixture(), outside = temp()
  symlinkSync(outside, path.join(other.directory, ".github"))
  await expect(other.service.install(other.directory, { model, write: true })).rejects.toThrow("inside")
  expect(existsSync(path.join(outside, "workflows"))).toBe(false)
})

test("PR checkout preserves dirty work and existing remotes, sets fork tracking and skips donor import", async () => {
  const h = fixture()
  h.fake.state.dirty = true
  await expect(h.service.checkout(h.directory, 42)).rejects.toThrow("clean")
  expect(h.fake.calls.some((call) => call.argv[0] === "gh")).toBe(false)
  h.fake.state.dirty = false
  h.fake.state.fork = true
  expect(await h.service.checkout(h.directory, 42, "private-token")).toMatchObject({ number: 42, branch: "pr/42", forkRemote: "forker", donorSession: "skipped" })
  expect(h.fake.calls.some((call) => call.argv.includes("--force"))).toBe(false)
  expect(h.fake.calls.some((call) => call.argv.includes("--set-upstream-to=forker/feature"))).toBe(true)
  expect(h.fake.calls.some((call) => call.argv.join(" ").includes("private-token"))).toBe(false)
  h.fake.remotes.set("forker", "https://github.com/other/repo.git")
  await expect(h.service.checkout(h.directory, 42)).rejects.toThrow("another repository")
})

test("all six v1 event categories route to bounded issue/PR context; review locations and mention defaults survive", async () => {
  const h = fixture()
  for (const event of ["issue_comment", "issues", "pull_request_review_comment", "pull_request", "schedule", "workflow_dispatch"]) {
    const prepared = await h.service.prepare(h.directory, { ...input(githubEvent(event)), ...(["issues", "schedule", "workflow_dispatch"].includes(event) ? { prompt: "Fix parser" } : {}) }, "owner")
    expect(prepared.prompt).toContain("Publication is off")
    if (event !== "schedule" && event !== "workflow_dispatch") expect(prepared.prompt).toContain("Keep empty input valid")
    if (event === "issue_comment" || event === "pull_request_review_comment") expect(prepared.prompt).not.toContain("trigger excluded")
    if (event === "pull_request_review_comment") { expect(prepared.prompt).toContain("File: source.ts"); expect(prepared.prompt).toContain("Line: 4"); expect(prepared.prompt).toContain("CHANGES_REQUESTED"); expect(prepared.prompt).toContain("Commit: abcd") }
    await h.service.finish(prepared.runId, "owner", "completed", "Fixed parser")
  }
  const bare = GithubContext.parse(JSON.parse(githubEvent()))
  bare.payload.comment!.body = "/mc"
  expect(githubPrompt(bare)).toBe("Summarize this thread")
  bare.payload.comment!.body = "text /mcx"
  expect(() => githubPrompt(bare)).toThrow("mention")
  expect(h.fake.calls.some((call) => call.argv.includes("push") || call.stdin?.includes('"content":"eyes"'))).toBe(false)
})

test("invalid events, mismatched repositories, missing prompts and unauthorized actors stop before branch/session changes", async () => {
  const h = fixture()
  for (const event of ["not json", githubEvent("push"), githubEvent().replace('"acme"', '"other"'), githubEvent("issues"), githubEvent("schedule")]) await expect(h.service.prepare(h.directory, input(event), "owner")).rejects.toThrow()
  h.fake.state.permission = "read"
  await expect(h.service.prepare(h.directory, input(), "owner")).rejects.toThrow("write permission")
  expect(h.fake.calls.some((call) => call.argv.includes("checkout"))).toBe(false)
})

test("tool-only turns get a bounded tool-call summary instead of an empty reply", () => {
  const started = (itemId: string, tool: string, extra: Record<string, unknown> = {}) => ({ type: "item.started", itemId, kind: "tool_call", meta: { tool, ...extra } })
  const events = [started("a", "Edit src/parser.ts"), { type: "item.completed", itemId: "a", status: "ok" }, started("b", "Bash  bun   test"), { type: "item.completed", itemId: "b", status: "error" }, started("c", "child", { parentItemId: "b" })]
  expect(githubToolSummary(events)).toBe("Agent completed without a text response. Tool calls (2):\n- Edit src/parser.ts\n- Bash bun test (error)")
  expect(githubToolSummary([])).toBe("Agent completed without a text response")
  const many = Array.from({ length: 25 }, (_, index) => started(`t${index}`, `Read file${index}`))
  expect(githubToolSummary(many)).toContain("- … 5 more")
  expect(githubToolSummary(many).split("\n")).toHaveLength(22)
})

test("attachment links are downloaded only with --attachments, from GitHub hosts, with bounded files and no token on redirects", async () => {
  const link = "https://github.com/user-attachments/assets/aaaa-bbbb"
  const off = fixture()
  const plain = await off.service.prepare(off.directory, { ...input(githubEvent("issues")), prompt: `See ${link}` }, "owner")
  expect(plain.blocked.join()).toContain("--attachments")
  expect(plain.prompt).toContain(link)

  const requests: Array<{ url: string; authorization: string | null }> = []
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, authorization: new Headers(init.headers).get("authorization") })
    if (url === link) return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/blob?sig=x" } })
    if (url.startsWith("https://objects.githubusercontent.com/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
    throw new Error("must not request")
  }
  const h = fixture()
  const service = createGithub({ process: h.fake.process, fetch: fetcher })
  cleanup.push(() => service.dispose())
  const prepared = await service.prepare(h.directory, { ...input(githubEvent("issues")), prompt: `See ${link} and https://evil.example/user-attachments/assets/x`, attachments: true }, "owner")
  const saved = /\[attachment saved at ([^\]]+)\]/.exec(prepared.prompt)?.[1]
  expect(saved).toMatch(/attachment-1\.png$/)
  expect(prepared.prompt).not.toContain(link)
  expect([...readFileSync(saved!)]).toEqual([1, 2, 3])
  expect(requests).toEqual([{ url: link, authorization: "Bearer local-test-token" }, { url: "https://objects.githubusercontent.com/blob?sig=x", authorization: null }])
  await service.finish(prepared.runId, "owner", "failed", "")
  expect(existsSync(saved!)).toBe(false)

  const hostile = createGithub({ process: fixture().fake.process, fetch: async (url) => url === link ? new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }) : new Response("x".repeat(6 * 1024 * 1024)) })
  const refused = await hostile.prepare(h.directory, { ...input(githubEvent("issues")), prompt: `See ${link}`, attachments: true }, "owner2")
  expect(refused.prompt).toContain(link)
  expect(refused.blocked.join()).toContain("1 attachment not downloaded")
  await hostile.dispose()
})

test("an attachment link that climbs out of /user-attachments/ is never requested, so the token cannot reach other github.com paths", async () => {
  const climbing = "https://github.com/user-attachments/assets/../../settings/tokens"
  const requests: string[] = []
  const h = fixture()
  const service = createGithub({ process: h.fake.process, fetch: async (url) => { requests.push(url); return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }) } })
  cleanup.push(() => service.dispose())
  const prepared = await service.prepare(h.directory, { ...input(githubEvent("issues")), prompt: `See ${climbing}`, attachments: true }, "owner")
  expect(requests).toEqual([])
  expect(prepared.blocked.join()).toContain("1 attachment not downloaded")
})

test("publication is explicit: commits/push/PR/comment, fork target, duplicate PR reuse, no-commit and branch-switch guards", async () => {
  const h = fixture()
  for (const scenario of ["issue", "fork", "switched", "no-commits", "existing"]) {
    h.fake.state.fork = scenario === "fork"
    h.fake.state.commits = scenario === "no-commits" ? 0 : 1
    h.fake.state.existingPr = scenario === "existing"
    const prepared = await h.service.prepare(h.directory, input(githubEvent("issue_comment", scenario === "fork"), true), "owner")
    h.fake.state.dirty = true
    h.fake.state.switched = scenario === "switched"
    const before = h.fake.calls.length
    const report = await h.service.finish(prepared.runId, "owner", "completed", "Fix parser\nDetails local-test-token")
    expect(report.published).toBe(true)
    const calls = h.fake.calls.slice(before)
    expect(calls.some((call) => call.argv.includes("push"))).toBe(scenario !== "switched")
    if (scenario === "fork") expect(calls.find((call) => call.argv.includes("push"))?.argv).toContain("https://github.com/forker/project.git")
    if (scenario === "existing") expect(calls.some((call) => call.argv[2] === "repos/acme/project/pulls" && call.stdin)).toBe(false)
    if (scenario === "no-commits" || scenario === "switched" || scenario === "fork") expect(report.pullRequest).toBeUndefined()
    else expect(report.pullRequest).toBe(77)
    expect(calls.some((call) => call.argv.includes("DELETE"))).toBe(true)
    expect(calls.some((call) => call.stdin?.includes("local-test-token"))).toBe(false)
    h.fake.state.switched = false
    h.fake.state.dirty = false
  }
})

test("failed/stopped runs never publish, errors omit credentials and cleanup releases ownership/locks/reactions", async () => {
  const h = fixture()
  const prepared = await h.service.prepare(h.directory, input(undefined, true), "owner")
  await expect(h.service.finish(prepared.runId, "other", "completed", "private")).rejects.toThrow("Unknown")
  await expect(h.service.prepare(h.directory, input(), "owner")).rejects.toThrow("active")
  await expect(h.service.checkout(h.directory, 42)).rejects.toThrow("active")
  const before = h.fake.calls.length
  expect(await h.service.finish(prepared.runId, "owner", "failed", "private")).toMatchObject({ published: false })
  expect(h.fake.calls.slice(before).some((call) => call.argv.includes("push") || call.stdin)).toBe(false)
  h.fake.state.fail = "collaborators"
  await expect(h.service.prepare(h.directory, input(), "owner")).rejects.toThrow("gh api failed")
  h.fake.state.fail = ""
  const next = await h.service.prepare(h.directory, input(), "owner")
  expect(await h.service.finish(next.runId, "owner", "stopped", "private")).toMatchObject({ published: false, status: "stopped" })
})

test("daemon/client round trip owns sessions, forces ask and verifies completion before publishing", async () => {
  const dir = temp(), directory = temp(), fake = fakeGithub(directory)
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), githubProcess: fake.process, log: () => {}, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 0 }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b48" })
  await client.connect()
  cleanup.push(() => client.close())
  await client.send({ type: "settings.set", patch: { defaultPermission: "full" } })
  const installed = await client.installGithub(directory, { model: "openai/model" })
  expect(installed).toMatchObject({ ok: true, report: { written: false } })
  const prepared = await client.runGithub(directory, input())
  if (!prepared.ok) throw new Error(prepared.error.message)
  expect(await client.send({ type: "session.get", sessionId: prepared.report.sessionId as import("@mendcode/protocol").SessionId })).toMatchObject({ ok: true, result: { session: { permission: "ask" } } })
  expect(await client.finishGithub(prepared.report.runId, "completed")).toMatchObject({ ok: false })
  expect(await client.finishGithub(prepared.report.runId, "stopped")).toMatchObject({ ok: true, report: { published: false } })
  expect(await client.checkoutPr(directory, 42)).toMatchObject({ ok: true, report: { branch: "pr/42" } })
}, 15_000)
