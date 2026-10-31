import { describe, expect, test } from "bun:test"
import type { CommandRun } from "../src/pr-review/contracts"
import { createGitlabProvider, gitlabLineMap } from "../src/pr-review/providers/gitlab"
import { createProvider } from "../src/pr-review/providers/index"

/**
 * Regressions found by the live run of scripts/live-forges.ts against GitLab CE 19.5.3 and glab 1.126.0 (2026-10-30):
 * - `glab api --hostname 127.0.0.1:8929` fails ("invalid hostname") although `glab auth login --hostname host:port` works; a
 *   `baseUrl` makes every call a full API URL, which glab accepts with that host's login.
 * - The project merge request list is cached up to 8 hours on the MR's `updated_at`, which a push does not change: its `sha`
 *   stayed on the old head. `with_labels_details=true` makes GitLab skip that cache.
 * - A diff note on an unchanged context line given by `new_line` alone is refused (400 `line_code can't be blank`); it needs the
 *   line's `old_line` too, and a renamed file needs its old path.
 * The fakes below replay those request shapes; the live evidence is the harness's own output.
 */

const HEAD = "35d6f417bd3927549c9031bc96e023f3a777deec", BASE = "b35b245a9bb79f37ef319d0102e5496fbee80025"
const MARKER = "<!-- mendcode:review head=35d6f41 -->"
const PROJECT = "projects/grp%2Fteam%2Fdemo"
const ORIGIN = "http://127.0.0.1:8929"

const mr = (iid: number, extra: Record<string, unknown> = {}) => ({
  id: 100 + iid, iid, title: `MR ${iid}`, draft: false, labels: [{ id: 1, name: "bug", color: "#fff" }], author: { username: "root", bot: false },
  source_branch: "feature", target_branch: "main", source_project_id: 2, target_project_id: 2, sha: HEAD, reviewers: [], assignees: [],
  diff_refs: { base_sha: BASE, start_sha: BASE, head_sha: HEAD }, ...extra,
})
/** One file of `GET …/merge_requests/:iid/diffs`, shaped as GitLab 19.5.3 returned it for the live MR. */
const diffFile = (extra: Record<string, unknown> = {}) => ({
  old_path: "math.js", new_path: "math.js", new_file: false, renamed_file: false, deleted_file: false,
  diff: "@@ -5,3 +5,7 @@ export function add(a, b) {\n export function sub(a, b) {\n   return a - b\n }\n+\n+export function div(a, b) {\n+  return a / b\n+}\n", ...extra,
})

type Call = { argv: string[]; body: any }
function fakeGlab(answer: (endpoint: string, method: string, body: any) => { code: number; out: string; err?: string } | undefined) {
  const calls: Call[] = []
  const run: CommandRun = async ({ argv, stdin }) => {
    const body = stdin ? JSON.parse(stdin) : undefined
    calls.push({ argv, body })
    const method = argv[argv.indexOf("--method") + 1] ?? "GET"
    const given = answer(argv[1]!, method, body)
    return given ? { err: "", ...given } : { code: 1, out: "", err: `glab: 404 Not Found (unexpected ${method} ${argv[1]})` }
  }
  return { run, calls }
}
const ok = (value: unknown) => ({ code: 0, out: JSON.stringify(value) })

describe("GitLab on a self-hosted instance with a port", () => {
  test("baseUrl turns every call into a full API URL and never passes --hostname", async () => {
    const fake = fakeGlab((endpoint) => endpoint.startsWith(`${ORIGIN}/api/v4/${PROJECT}/merge_requests?`) ? ok([mr(1)]) : endpoint === `${ORIGIN}/api/v4/${PROJECT}/merge_requests/1` ? ok(mr(1)) : undefined)
    const provider = createGitlabProvider({ run: fake.run, baseUrl: `${ORIGIN}/` })
    const listed = await provider.listOpen({ directory: "/checkout", repo: "grp/team/demo" })
    expect(listed).toMatchObject({ ok: true, prs: [{ number: 1, head: HEAD, labels: ["bug"] }] })
    expect((await provider.view({ directory: "/checkout", repo: "grp/team/demo", number: 1 })).base).toBe(BASE)
    expect(fake.calls.every((call) => call.argv[1]!.startsWith(`${ORIGIN}/api/v4/`) && !call.argv.includes("--hostname"))).toBe(true)
  })

  test("a hostname with a port becomes an https origin; a bare hostname still goes through --hostname", async () => {
    const ported = fakeGlab(() => ok([]))
    await createGitlabProvider({ run: ported.run, hostname: "git.example.com:8443" }).listOpen({ directory: "/c", repo: "g/p" })
    expect(ported.calls[0]!.argv[1]).toStartWith("https://git.example.com:8443/api/v4/projects/g%2Fp/merge_requests?")
    expect(ported.calls[0]!.argv).not.toContain("--hostname")
    const bare = fakeGlab(() => ok([]))
    await createGitlabProvider({ run: bare.run, hostname: "gitlab.example.com" }).listOpen({ directory: "/c", repo: "g/p" })
    expect(bare.calls[0]!.argv.slice(-2)).toEqual(["--hostname", "gitlab.example.com"])
  })

  test("createProvider hands GitLab the detected base URL, and a malformed one is refused", () => {
    const fake = fakeGlab(() => ok([]))
    expect(createProvider("gitlab", { run: fake.run, baseUrl: ORIGIN }).kind).toBe("gitlab")
    expect(() => createGitlabProvider({ run: fake.run, baseUrl: "127.0.0.1:8929" })).toThrow(TypeError)
  })

  test("the open list asks for label details, which is what makes GitLab skip its cached (stale-head) list", async () => {
    const fake = fakeGlab(() => ok([]))
    await createGitlabProvider({ run: fake.run, baseUrl: ORIGIN }).listOpen({ directory: "/c", repo: "grp/team/demo" })
    expect(fake.calls[0]!.argv[1]).toContain("with_labels_details=true")
  })
})

describe("GitLab diff positions", () => {
  test("the line map keeps added lines without an old line and context lines with theirs; a deleted file has none", () => {
    const map = gitlabLineMap([diffFile(), diffFile({ old_path: "gone.js", new_path: "gone.js", deleted_file: true, diff: "@@ -1 +0,0 @@\n-x\n" }), { junk: true }])
    expect([...map.keys()]).toEqual(["math.js"])
    expect([...map.get("math.js")!.lines]).toEqual([[5, 5], [6, 6], [7, 7], [8, undefined], [9, undefined], [10, undefined], [11, undefined]])
  })

  const publishFake = (files: unknown[] | undefined) => fakeGlab((endpoint, method, body) => {
    if (endpoint === `${PROJECT}/merge_requests/1` && method === "GET") return ok(mr(1))
    if (endpoint.startsWith(`${PROJECT}/merge_requests/1/notes?`)) return ok([])
    if (endpoint.startsWith(`${PROJECT}/merge_requests/1/diffs?`)) return files ? ok(files) : undefined
    if (endpoint === `${PROJECT}/merge_requests/1/discussions` && method === "POST") return body.position.new_line === 9999 || (body.position.old_line === undefined && body.position.new_line <= 7) ? { code: 1, out: "", err: "glab: 400 Bad request - Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}" } : ok({ id: "4edf0582f78fcf7212437ba7bd20f1ffe8250d4d" })
    if (endpoint === `${PROJECT}/merge_requests/1/notes` && method === "POST") return ok({ id: 3 })
    return undefined
  })
  const input = (comments: Array<{ path: string; line: number; endLine?: number; body: string }>) => ({ repo: "grp/team/demo", number: 1, head: HEAD, body: "Summary.", comments, marker: MARKER })

  test("a context line carries its old line, an added line only its new one, and a line outside the diff is never sent", async () => {
    const fake = publishFake([diffFile()])
    const done = await createGitlabProvider({ run: fake.run }).publish(input([{ path: "math.js", line: 8, body: "Added." }, { path: "math.js", line: 5, body: "Context." }, { path: "math.js", line: 9999, body: "Outside." }, { path: "other.js", line: 1, body: "Not in the MR." }]))
    expect(done).toEqual({ ok: true, remote: "note:3", comments: 2, movedToBody: 2 })
    const positions = fake.calls.filter((call) => call.argv[1] === `${PROJECT}/merge_requests/1/discussions`).map((call) => call.body.position)
    expect(positions).toEqual([
      expect.objectContaining({ new_line: 8, old_path: "math.js", new_path: "math.js" }),
      expect.objectContaining({ new_line: 5, old_line: 5 }),
    ])
    expect(positions[0]).not.toHaveProperty("old_line")
    const summary = fake.calls.find((call) => call.argv[1] === `${PROJECT}/merge_requests/1/notes`)!.body.body
    expect(summary).toContain("`math.js` line 9999")
    expect(summary).toContain("`other.js` line 1")
  })

  test("a renamed file is anchored with its old path", async () => {
    const fake = publishFake([diffFile({ old_path: "calc.js", renamed_file: true })])
    await createGitlabProvider({ run: fake.run }).publish(input([{ path: "math.js", line: 9, body: "Renamed." }]))
    expect(fake.calls.find((call) => call.argv[1] === `${PROJECT}/merge_requests/1/discussions`)!.body.position).toMatchObject({ old_path: "calc.js", new_path: "math.js", new_line: 9 })
  })

  test("an unreadable diff list tries every comment as it is and moves a refused one into the summary", async () => {
    const fake = publishFake(undefined)
    const done = await createGitlabProvider({ run: fake.run }).publish(input([{ path: "math.js", line: 8, body: "Added." }, { path: "math.js", line: 9999, body: "Outside." }]))
    expect(done).toEqual({ ok: true, remote: "note:3", comments: 1, movedToBody: 1 })
  })
})
