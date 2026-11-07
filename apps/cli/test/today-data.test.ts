import { describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { SLASH_COMMANDS, parseSlash } from "../src/view/commands"
import { FIRST_VISIT_WINDOW_MS, loadTodayData, type TodaySource } from "../src/view/today-data"
import { slashPage } from "../src/ui/lazy-pages"

const NOW = Date.UTC(2026, 10, 6, 15, 0, 0)
const H = 3_600_000
const session = (id: string, patch: Record<string, unknown> = {}) => ({ sessionId: `ses_${id}`, title: `Session ${id}`, directory: "/work/shop-api", createdAt: NOW - 30 * H, updatedAt: NOW - 2 * H, lastSeq: 9, state: "idle", queued: 0, status: "idle", ...patch })
const job = (id: string, patch: Record<string, unknown> = {}) => ({ id, provider: "github", repo: "acme/shop", number: 41, title: "Coupons", reviewer: "global", trigger: "push", state: "done", coverage: "full", base: "main", head: "feat", attempts: 1, createdAt: NOW - 5 * H, updatedAt: NOW - 3 * H, findings: { confirmed: 3, plausible: 0, candidates: 0, resolved: 1 }, ...patch })
const memory = (id: string, patch: Record<string, unknown> = {}) => ({ memoryId: `mem_${id}`, scope: "project", text: `memory ${id}`, category: "testing", status: "saved", source: "agent", createdAt: NOW - 4 * H, updatedAt: NOW - 4 * H, ...patch })

type Replies = Partial<Record<CommandInput["type"], Record<string, unknown> | Error>>
function fake(replies: Replies, patch: Partial<TodaySource> = {}) {
  const asked: CommandInput[] = []
  const source: TodaySource = {
    send: async (command) => {
      asked.push(command)
      const answer = replies[command.type]
      if (answer instanceof Error) return { ok: false, error: { code: "invalid_command", message: `[DAEMON]: ${answer.message}` } } as CommandReply
      return { ok: true, result: answer ?? {} } as CommandReply
    },
    directory: "/work/shop-api",
    sessionId: "ses_main",
    reviews: true,
    now: NOW,
    ...patch,
  }
  return { source, asked, types: () => asked.map((command) => command.type) }
}

describe("loadTodayData", () => {
  test("Attention lists waiting sessions, reviews with open findings, workflows needing input and conflicting memories, longest waiting first", async () => {
    const { source } = fake({
      "session.list": { sessions: [session("a", { status: "waiting_for_approval", pending: "Run bun test", since: NOW - 3 * H }), session("q", { status: "waiting_for_input", pending: "Which database?", since: NOW - H }), session("idle")] },
      "pr.review": { dashboard: { jobs: [job("rev_1", { number: 7, updatedAt: NOW - 3.5 * H, findings: { confirmed: 3, plausible: 0, candidates: 0, resolved: 1, blocking: 1 } }), job("rev_2", { number: 8, findings: { confirmed: 1, plausible: 0, candidates: 0, resolved: 1 } }), job("rev_3", { updatedAt: NOW - 2 * H, state: "waiting", sessionId: "ses_rv", findings: { confirmed: 0, plausible: 0, candidates: 0, resolved: 0 } })], watches: [], reviewers: [], metrics: {} } },
      "workflow.list": { workflows: [{ workflowId: "wf_1", name: "Migrate", directory: "/work/shop-api", objective: "move", state: "needs_input", tasks: [{ id: "t", title: "Pick region", state: "needs_input" }], rounds: 1, startedAt: NOW - 8 * H, updatedAt: NOW - 6 * H }, { workflowId: "wf_2", name: "Done", directory: "/work", objective: "x", state: "completed", tasks: [], rounds: 0, startedAt: 1, updatedAt: 2 }] },
      "memory.graph": { nodes: [memory("1", { text: "Use tabs" }), memory("2", { text: "Use spaces" })], links: [{ from: "mem_1", to: "mem_2", kind: "conflicts", createdAt: NOW - 20 * H }, { from: "mem_1", to: "mem_2", kind: "related", createdAt: NOW }], health: {} },
    })
    const { attention } = await loadTodayData(source)
    expect(attention.map((item) => [item.kind, item.title])).toEqual([
      ["contradiction", `"Use tabs" vs "Use spaces"`],
      ["decision", "Migrate"],
      ["review", "acme/shop#7 Coupons"],
      ["approval", "Session a"],
      ["review", "acme/shop#41 Coupons"],
      ["decision", "Session q"],
    ])
    expect(attention.find((item) => item.kind === "approval")).toMatchObject({ why: "waiting for your approval: Run bun test", link: { command: "session", sessionId: "ses_a" } })
    expect(attention.find((item) => item.id === "pr:github:acme/shop#7")).toMatchObject({ why: "1 blocking finding of 2 open", link: { command: "/reviews", ref: "rev_1" } })
    expect(attention.find((item) => item.id === "pr:github:acme/shop#7")?.link.sessionId).toBeUndefined()
    expect(attention.find((item) => item.id === "pr:github:acme/shop#41")?.link).toMatchObject({ command: "/reviews", ref: "rev_3", sessionId: "ses_rv" })
    expect(attention.find((item) => item.id === "wf_1")).toMatchObject({ why: `task "Pick region" needs your input`, link: { command: "/workflows" } })
    // Open findings with none blocking wait on nobody: the PR is not in Attention.
    expect(attention.find((item) => item.id === "pr:github:acme/shop#8")).toBeUndefined()
  })

  test("a pull request is one row from its newest head: earlier heads and re-reviews fold in; merged, closed, re-reviewing and answered PRs drop out", async () => {
    const blocking = (count: number) => ({ confirmed: count, plausible: 0, candidates: 0, resolved: 0, ...(count ? { blocking: count } : {}) })
    const at = (hours: number) => ({ createdAt: NOW - hours * H - H, updatedAt: NOW - hours * H })
    const jobs = [
      // #22: three heads, the stale one superseded, a failed one, the newest with a blocking finding.
      job("a1", { number: 22, head: "aaa1111", state: "stale", ...at(80), findings: blocking(1) }),
      job("a2", { number: 22, head: "bbb2222", state: "failed", ...at(60), findings: blocking(0) }),
      job("a3", { number: 22, head: "bbb2222", ...at(50), findings: blocking(2) }),
      job("a4", { number: 22, head: "ccc3333", ...at(30), findings: blocking(1) }),
      job("a5", { number: 22, head: "ccc3333", trigger: "comment", ...at(20), findings: blocking(1) }),
      // #87: blocking findings on old heads, none on the newest: answered.
      job("b1", { number: 87, head: "d1", ...at(90), findings: blocking(3) }),
      job("b2", { number: 87, head: "d2", ...at(40), findings: blocking(0) }),
      // #90: GitHub says merged.
      job("c1", { number: 90, head: "e1", ...at(10), findings: blocking(2), pullRequest: { state: "merged", draft: false, mergeable: "unknown", checks: "none" } }),
      // #91: closed.
      job("c2", { number: 91, head: "e2", ...at(10), findings: blocking(2), pullRequest: { state: "closed", draft: false, mergeable: "unknown", checks: "none" } }),
      // #103: the newest head is being reviewed now; the old findings are about to be replaced.
      job("d1", { number: 103, head: "f1", ...at(12), findings: blocking(3) }),
      job("d2", { number: 103, head: "f2", state: "running", ...at(1), findings: blocking(0) }),
      // #104: the newest head's review failed; nothing is known about it.
      job("e1", { number: 104, head: "g1", ...at(12), findings: blocking(1) }),
      job("e2", { number: 104, head: "g2", state: "failed", ...at(2), findings: blocking(0) }),
      // The same number in another repository is another pull request.
      job("f1", { repo: "acme/web", number: 22, head: "h1", ...at(5), findings: blocking(1), pullRequest: { state: "open", draft: false, mergeable: "mergeable", checks: "passing" } }),
    ]
    const { source, asked } = fake({ "pr.review": { dashboard: { jobs } } })
    const { attention } = await loadTodayData(source)
    expect(asked.find((command) => command.type === "pr.review")).toMatchObject({ action: "status", pullRequests: "cached" })
    expect(attention.map((item) => item.id)).toEqual(["pr:github:acme/shop#22", "pr:github:acme/web#22"])
    const row = attention[0]!
    expect(row).toMatchObject({ since: NOW - 20 * H, why: "1 blocking finding", link: { ref: "a5" } })
    expect(row.explain).toContain("newest head (ccc3333)")
    expect(row.evidence).toContain("4 earlier reviews of 2 older heads folded in")
    expect(row.history[0]!.text).toContain("head ccc3333")
    expect(row.older).toBeUndefined()
  })

  test("a review row nobody touched for a week is marked older, and the cap keeps the newest of those", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) => job(`old_${i}`, { number: 100 + i, createdAt: NOW - (8 * 24 + i) * H - H, updatedAt: NOW - (8 * 24 + i) * H, findings: { confirmed: 1, plausible: 0, candidates: 0, resolved: 0, blocking: 1 } }))
    jobs.push(job("fresh", { number: 1, updatedAt: NOW - H, findings: { confirmed: 1, plausible: 0, candidates: 0, resolved: 0, blocking: 1 } }))
    const { source } = fake({ "pr.review": { dashboard: { jobs } } })
    const { attention } = await loadTodayData(source)
    expect(attention.filter((item) => !item.older).map((item) => item.id)).toEqual(["pr:github:acme/shop#1"])
    const older = attention.filter((item) => item.older)
    expect(older).toHaveLength(40)
    expect(older.at(-1)!.id).toBe("pr:github:acme/shop#100")
  })

  test("Pick up lists interrupted, failed and paused sessions and finished ones with changes nobody committed", async () => {
    const { source, asked } = fake({
      "session.list": {
        sessions: [
          session("i", { status: "interrupted", summary: "Added the coupon route", updatedAt: NOW - H }),
          session("f", { status: "failed", updatedAt: NOW - 2 * H, draft: { preview: "retry with the smaller batch", chars: 28, attachments: 0, images: 0, updatedAt: NOW } }),
          session("p", { status: "idle", paused: true, updatedAt: NOW - 3 * H }),
          session("dirty", { status: "completed", directory: "/work/dirty", updatedAt: NOW - 4 * H }),
          session("clean", { status: "completed", directory: "/work/clean", updatedAt: NOW - 5 * H }),
          session("linked", { status: "completed", directory: "/work/dirty", lifecycle: { pr: { number: 7, url: "u", title: "t", state: "OPEN", branch: "b", checkedAt: 1 } } }),
          session("cancelled", { status: "cancelled" }),
          session("old", { status: "interrupted", archivedAt: NOW }),
        ],
      },
    })
    const git = (directory: string) => ({ "/work/dirty": { dirty: 3, ahead: 1 }, "/work/clean": { dirty: 0, ahead: 0 } })[directory]
    const wrapped = { ...source, send: async (command: CommandInput) => { if (command.type !== "git.status") return source.send(command); asked.push(command); return { ok: true, result: git(command.directory) ?? {} } as CommandReply } }
    const { pickup } = await loadTodayData(wrapped)
    expect(pickup.map((item) => [item.sessionId, item.state])).toEqual([["ses_i", "interrupted"], ["ses_f", "failed"], ["ses_p", "blocked"], ["ses_dirty", "awaiting-review"]])
    expect(pickup[0]).toMatchObject({ leftOff: "Added the coupon route", next: "Open it and ask the agent to continue.", link: { sessionId: "ses_i" } })
    expect(pickup[1]!.next).toBe("Send or finish the draft you were writing.")
    expect(pickup[3]!.why).toBe("finished, 3 files with uncommitted changes, 1 commit not pushed in dirty")
    // One git.status per folder of a finished session without a pull request, never per session.
    expect(asked.filter((command) => command.type === "git.status").map((command) => (command as { directory: string }).directory).sort()).toEqual(["/work/clean", "/work/dirty"])
  })

  test("Memory shows Dream's last run and each pending proposal with the memory before and after", async () => {
    const { source } = fake({
      "memory.list": { memories: [memory("old", { text: "Tests need fixed dates" }), memory("u", { status: "pending", kind: "update", targetId: "mem_old", text: "Tests freeze the clock", reason: "newer sessions say so" }), memory("a", { status: "pending", kind: "archive", text: "Use moment.js", createdAt: NOW - 2 * H }), memory("n", { status: "pending", text: "Prefer bun", source: "user", createdAt: NOW - 6 * H })] },
      "dream.list": { runs: [{ runId: 12, directory: "/work/shop-api", status: "done", startedAt: NOW - 5 * H, endedAt: NOW - 4 * H + 60_000, proposed: 3, report: { consolidation: { applied: 1, archived: 2 } } }] },
    })
    const data = await loadTodayData(source)
    expect(data.dream).toEqual({ run: "#12", at: NOW - 4 * H + 60_000, summary: "proposed 3 changes · applied 1 · archived 2" })
    expect(data.memory.map((item) => [item.kind, item.before, item.after])).toEqual([
      ["drop", ["Use moment.js"], undefined],
      ["fix", ["Tests need fixed dates"], "Tests freeze the clock"],
      ["new", [], "Prefer bun"],
    ])
    expect(data.memory[1]).toMatchObject({ run: "#12", why: "newer sessions say so", link: { command: "/memory" } })
    expect(data.memory[2]!.run).toBeUndefined()
  })

  test("a read-only remote client asks for no memory and no reviews and says they are not listed", async () => {
    const { source, types } = fake({ "session.list": { sessions: [] } }, { remote: { host: "box", readOnly: true } })
    const data = await loadTodayData(source)
    expect(types()).toEqual(["session.list", "session.list", "workflow.list", "dream.list"])
    expect(data.notes).toEqual(["PR reviews are local-only and are not listed here.", "This client is read-only: memory proposals and contradictions are not listed."])
    expect([data.attention, data.pickup, data.memory]).toEqual([[], [], []])
  })

  test("a full-access remote client reads memory but never PR reviews", async () => {
    const { source, types } = fake({}, { remote: { host: "box", readOnly: false } })
    await loadTodayData(source)
    expect(types()).toEqual(["session.list", "session.list", "workflow.list", "memory.list", "memory.graph", "dream.list"])
  })

  test("a session waiting for the user stays in Attention past the pickup window and behind a hundred newer sessions", async () => {
    const asked: CommandInput[] = []
    const newer = Array.from({ length: 100 }, (_, index) => session(`n${index}`, { updatedAt: NOW - H }))
    const old = session("old", { status: "waiting_for_approval", pending: "Run the migration", since: NOW - 9 * 24 * H, updatedAt: NOW - 9 * 24 * H })
    const source: TodaySource = { ...fake({}).source, send: async (command) => {
      asked.push(command)
      if (command.type !== "session.list") return { ok: true, result: {} } as CommandReply
      return { ok: true, result: { sessions: command.state === "waiting" ? [old] : newer } } as CommandReply
    } }
    const data = await loadTodayData(source)
    expect(asked.find((command) => command.type === "session.list" && command.state === "waiting")).not.toMatchObject({ since: expect.anything() })
    expect(data.attention.map((item) => item.title)).toEqual(["Session old"])
    expect(data.pickup.some((item) => item.title === "Session old")).toBe(false)
  })

  test("PR reviews are not read with the feature off, or without a session to ask through", async () => {
    expect(fake({}, { reviews: false }).types()).toEqual([])
    const off = fake({}, { reviews: false })
    await loadTodayData(off.source)
    expect(off.types()).not.toContain("pr.review")
    const none = fake({}, { sessionId: undefined })
    const data = await loadTodayData(none.source)
    expect(none.types()).not.toContain("pr.review")
    expect(data.notes).toEqual(["PR reviews are listed once the session has started."])
  })

  test("a source that fails leaves its rows out, names the failure and keeps the others", async () => {
    const { source } = fake({ "session.list": new Error("busy"), "dream.list": { runs: [] }, "memory.list": { memories: [memory("n", { status: "pending" })] } })
    const data = await loadTodayData(source)
    expect(data.notes).toEqual(["Sessions could not be read: busy."])
    expect(data.attention).toEqual([])
    expect(data.memory).toHaveLength(1)
  })

  test("a send that throws is a note, not a crash", async () => {
    const source: TodaySource = { ...fake({}).source, send: async () => { throw new Error("socket closed") } }
    const data = await loadTodayData(source)
    expect(data.notes?.length).toBeGreaterThan(0)
    expect(data.notes?.[0]).toContain("socket closed")
  })

  test("since is the last visit, or the last day when there was none, and the counts come from the sessions after it", async () => {
    const sessions = [session("a", { status: "completed", updatedAt: NOW - 2 * H }), session("b", { status: "idle", directory: "/work/other", updatedAt: NOW - 3 * H }), session("c", { status: "completed", updatedAt: NOW - 40 * H })]
    const first = await loadTodayData(fake({ "session.list": { sessions } }).source)
    expect(first.summary).toMatchObject({ lastVisit: NOW - FIRST_VISIT_WINDOW_MS, sessionsRan: 2, sessionsFinished: 1, projects: 2 })
    const returning = await loadTodayData(fake({ "session.list": { sessions } }, { lastVisit: NOW - 2.5 * H }).source)
    expect(returning.summary).toMatchObject({ lastVisit: NOW - 2.5 * H, sessionsRan: 1, sessionsFinished: 1, projects: 1 })
  })

  test("nothing at all gives honest empty tabs and no notes", async () => {
    const data = await loadTodayData(fake({}).source)
    expect([data.attention, data.pickup, data.memory, data.dream, data.notes]).toEqual([[], [], [], undefined, undefined])
  })

  test("lists are capped so a busy machine cannot grow the page", async () => {
    const many = Array.from({ length: 100 }, (_, i) => session(`w${i}`, { status: "interrupted", updatedAt: NOW - i * 1000 }))
    const proposals = Array.from({ length: 80 }, (_, i) => memory(`p${i}`, { status: "pending" }))
    const data = await loadTodayData(fake({ "session.list": { sessions: many }, "memory.list": { memories: proposals } }).source)
    expect(data.pickup).toHaveLength(30)
    expect(data.memory).toHaveLength(40)
  })
})

describe("the /today command", () => {
  test("is registered in the slash list with a summary, no alias and no feature gate", () => {
    const command = SLASH_COMMANDS.find((entry) => entry.name === "today")
    expect(command).toMatchObject({ group: "session", aliases: [] })
    expect(command?.summary.length).toBeGreaterThan(10)
    expect(command?.feature).toBeUndefined()
    expect(parseSlash("/today")?.command.name).toBe("today")
  })

  test("loads its page modules with the first command and not before", () => {
    expect(slashPage("today")).toBe("today")
  })
})
