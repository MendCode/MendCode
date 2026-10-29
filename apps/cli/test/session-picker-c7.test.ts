import { afterEach, describe, expect, test } from "bun:test"
import type { SessionSummary } from "@mendcode/protocol"
import { createSessionListState, filterSessions, groupSessions, orderSessions, renderSessionList, sessionListKey, viewOf } from "../src/view/session-list"
import { contentQuery, matchesQuery, nextSort, parseSessionQuery, parseTagDraft } from "../src/view/session-query"
import type { Line } from "../src/ui/theme"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const text = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join("")).join("\n")

function make(over: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId: ids("session"), title: "task", directory: "/tmp/a", createdAt: NOW - 5000, updatedAt: NOW - 1000, lastSeq: 1, queued: 0, state: "idle", ...over }
}

const login = make({ title: "fix login redirect", tags: ["auth", "urgent"], color: "red", named: true })
const billing = make({ title: "billing export", directory: "/tmp/b", createdAt: NOW - 1000, updatedAt: NOW - 9000, tags: ["finance"] })
const docs = make({ title: "write docs", createdAt: NOW - 9000, updatedAt: NOW - 500, color: "green" })
const all = [login, billing, docs]

describe("session query language", () => {
  test("plain words must all match title, directory, tags, agent or model", () => {
    expect(filterSessions(all, "login").map((s) => s.title)).toEqual(["fix login redirect"])
    expect(filterSessions(all, "tmp/b export").map((s) => s.title)).toEqual(["billing export"])
    expect(filterSessions(all, "finance").map((s) => s.title)).toEqual(["billing export"])
    expect(filterSessions(all, "login nothing")).toEqual([])
  })

  test("a quoted phrase keeps its spaces and an unterminated quote still searches", () => {
    expect(filterSessions(all, '"login redirect"').map((s) => s.title)).toEqual(["fix login redirect"])
    expect(filterSessions(all, '"redirect login"')).toEqual([])
    expect(filterSessions(all, '"login').map((s) => s.title)).toEqual(["fix login redirect"])
  })

  test("re: reads the rest of the line as a case-insensitive regular expression", () => {
    expect(filterSessions(all, "re:^FIX.*redirect$").map((s) => s.title)).toEqual(["fix login redirect"])
    expect(filterSessions(all, "re:bill|docs").map((s) => s.title).sort()).toEqual(["billing export", "write docs"])
    expect(parseSessionQuery("re:(").invalid).toBe("invalid regular expression")
    expect(filterSessions(all, "re:(")).toEqual([])
    expect(filterSessions(all, "re:")).toHaveLength(3)
  })

  test("tag: matches a tag prefix and color: the mark, together with words", () => {
    expect(filterSessions(all, "tag:aut").map((s) => s.title)).toEqual(["fix login redirect"])
    expect(filterSessions(all, "color:green").map((s) => s.title)).toEqual(["write docs"])
    expect(filterSessions(all, "tag:urgent login")).toHaveLength(1)
    expect(filterSessions(all, "tag:urgent docs")).toEqual([])
  })

  test("message hits make a session match whatever its metadata says, but tag and color still apply", () => {
    const hits = { [billing.sessionId]: "…the refund flow…" }
    expect(filterSessions(all, "refund")).toEqual([])
    expect(filterSessions(all, "refund", { hits }).map((s) => s.title)).toEqual(["billing export"])
    expect(filterSessions(all, "refund color:red", { hits })).toEqual([])
    expect(matchesQuery(billing, parseSessionQuery("refund"), hits)).toBe(true)
  })

  test("what to ask the daemon: one word plain, several words all-of, re: as regex, nothing for tag-only", () => {
    expect(contentQuery("refund")).toEqual({ text: "refund", regex: false })
    expect(contentQuery('"two words"')).toEqual({ text: "two words", regex: false })
    const both = contentQuery("alpha beta")!
    expect(both.regex).toBe(true)
    expect(new RegExp(both.text, "i").test("beta then alpha")).toBe(true)
    expect(new RegExp(both.text, "i").test("only alpha")).toBe(false)
    expect(contentQuery("re:foo.*bar")).toEqual({ text: "foo.*bar", regex: true })
    expect(contentQuery("tag:auth")).toBeUndefined()
    expect(contentQuery("re:(")).toBeUndefined()
    expect(contentQuery("   ")).toBeUndefined()
  })
})

describe("sort, scope and named filter", () => {
  test("recent, created and name order the sessions of a project and their projects", () => {
    const a1 = make({ title: "bravo", createdAt: NOW - 9000, updatedAt: NOW - 100 })
    const a2 = make({ title: "alpha", createdAt: NOW - 100, updatedAt: NOW - 9000 })
    const b1 = make({ title: "zulu", directory: "/tmp/b", createdAt: NOW - 50, updatedAt: NOW - 50 })
    const sessions = [a1, a2, b1]
    expect(orderSessions(sessions, "", undefined, false, { sort: "recent" }).map((s) => s.title)).toEqual(["zulu", "bravo", "alpha"])
    expect(orderSessions(sessions, "").map((s) => s.title)).toEqual(["zulu", "bravo", "alpha"])
    expect(orderSessions(sessions, "", undefined, false, { sort: "created" }).map((s) => s.title)).toEqual(["zulu", "alpha", "bravo"])
    expect(orderSessions(sessions, "", undefined, false, { sort: "name" }).map((s) => s.title)).toEqual(["alpha", "bravo", "zulu"])
    expect(nextSort("recent")).toBe("created")
    expect(nextSort("created")).toBe("name")
    expect(nextSort("name")).toBe("recent")
  })

  test("project scope keeps the open session's directory; named keeps only titled sessions", () => {
    expect(groupSessions(all, "", docs.sessionId, false, { scope: "project" }).map((g) => g.directory)).toEqual(["/tmp/a"])
    expect(orderSessions(all, "", docs.sessionId, false, { scope: "project" }).map((s) => s.title).sort()).toEqual(["fix login redirect", "write docs"])
    expect(orderSessions(all, "", undefined, false, { named: true }).map((s) => s.title)).toEqual(["fix login redirect"])
  })
})

describe("picker keys", () => {
  const key = (state: ReturnType<typeof createSessionListState>, k: string) => sessionListKey(state, k, all, docs.sessionId)

  test("ctrl+s cycles sort, ctrl+l scope, ctrl+e named, each back to the top", () => {
    let state = { ...createSessionListState(), selected: 2 }
    state = key(state, "\x13").state
    expect(state).toMatchObject({ sort: "created", selected: 0 })
    state = key(state, "\x13").state
    expect(state.sort).toBe("name")
    state = key(state, "\x0c").state
    expect(state.scope).toBe("project")
    state = key(state, "\x0c").state
    expect(state.scope).toBe("all")
    state = key(state, "\x05").state
    expect(state.named).toBe(true)
    expect(key(state, "\x05").state.named).toBe(false)
    expect(viewOf(state)).toEqual({ sort: "name", scope: "all", named: true })
  })

  test("ctrl+f turns message search on (asking the daemon), typing asks again, turning it off drops the hits", () => {
    const on = key(createSessionListState(), "\x06")
    expect(on.state.content).toBe(true)
    expect(on.action).toEqual({ type: "search" })
    const typed = key({ ...on.state, hits: { x: "old" } }, "r")
    expect(typed.state.filter).toBe("r")
    expect(typed.state.hits).toBeUndefined()
    expect(typed.action).toEqual({ type: "search" })
    expect(key({ ...typed.state, filter: "re" }, "\x7f").action).toEqual({ type: "search" })
    const off = key({ ...typed.state, hits: { x: "old" } }, "\x06")
    expect(off.state.content).toBe(false)
    expect(off.state.hits).toBeUndefined()
    expect(key(createSessionListState(), "r").action).toEqual({ type: "changed" })
  })

  test("ctrl+t opens the tag editor with the row's own tags and color, enter applies the words", () => {
    const state = { ...createSessionListState(), filter: "login" }
    const opened = key(state, "\x14")
    expect(opened.state.edit).toEqual({ mode: "tag", sessionId: login.sessionId, draft: "auth urgent color:red" })
    let edited = { ...opened.state, edit: { mode: "tag" as const, sessionId: login.sessionId, draft: "" } }
    for (const c of "Auth  #later color:blue") edited = key(edited, c).state
    const done = key(edited, "\r")
    expect(done.action).toEqual({ type: "tag", sessionId: login.sessionId, tags: ["auth", "later"], color: "blue" })
    expect(key(edited, "\x1b").state.edit).toBeUndefined()
  })

  test("color:none clears the mark, a made-up color is refused in the editor, a bare draft leaves the color alone", () => {
    const edit = (draft: string) => ({ ...createSessionListState(), edit: { mode: "tag" as const, sessionId: login.sessionId, draft } })
    expect(key(edit("a color:none"), "\r").action).toEqual({ type: "tag", sessionId: login.sessionId, tags: ["a"], color: null })
    expect(key(edit("a"), "\r").action).toEqual({ type: "tag", sessionId: login.sessionId, tags: ["a"], color: undefined })
    const refused = key(edit("a color:magenta"), "\r")
    expect(refused.action).toEqual({ type: "changed" })
    expect(refused.state.edit).toBeDefined()
    expect(refused.state.note).toContain("red orange yellow")
    expect(parseTagDraft("x #y color:").color).toBeNull()
  })
})

describe("picker view", () => {
  const render = (state = createSessionListState(), width = 120) => text(renderSessionList({ sessions: all, state, currentSessionId: docs.sessionId, width, height: 34, now: NOW }))

  test("rows carry the color mark and the tags; the detail column lists them", () => {
    const out = render({ ...createSessionListState(), selected: 1 })
    expect(out).toContain("● fix login redirect")
    expect(out).toContain("#auth #urgent")
    expect(out).toContain("#finance")
    expect(out).toMatch(/color\s+red/)
  })

  test("the summary names sort, scope, named-only and message search", () => {
    expect(render()).toContain("all projects")
    const out = render({ ...createSessionListState(), sort: "name", scope: "project", named: true, content: true, hits: { [login.sessionId]: "the login flow broke" } })
    expect(out).toContain("this project")
    expect(out).toContain("sort name")
    expect(out).toContain("named only")
    expect(out).toContain("messages 1")
  })

  test("with message search the matching snippet shows in the detail column", () => {
    const out = render({ ...createSessionListState(), filter: "broke", content: true, hits: { [login.sessionId]: "the login flow broke" } })
    expect(out).toContain("message match")
    expect(out).toContain("the login flow broke")
  })

  test("an invalid expression is named and matches nothing; the tag editor frame shows its words", () => {
    expect(render({ ...createSessionListState(), filter: "re:(" })).toContain("invalid regular expression")
    const editor = render({ ...createSessionListState(), edit: { mode: "tag", sessionId: login.sessionId, draft: "auth color:red" } })
    expect(editor).toContain("Tag session")
    expect(editor).toContain("tags: auth color:red")
    expect(editor).toContain("colors: red orange")
  })
})

describe("picker in the app", () => {
  test("ctrl+t then enter patches the session's agent-view metadata and reloads the list", async () => {
    const id = ids("session")
    const session: SessionSummary = { sessionId: id, title: "Tagged work", directory: "/project", createdAt: NOW, updatedAt: NOW, lastSeq: 1, queued: 0, state: "idle" }
    const h = appHarness({ sessionId: id, dataDir: tempDir(), directory: "/project", reply: (command) => {
      if (command.type === "session.list") return { ok: true, result: { sessions: [session] } }
      if (command.type === "session.agent-view.metadata.patch") {
        Object.assign(session, { tags: command.patch.tags, ...(command.patch.color ? { color: command.patch.color } : {}) })
        return { ok: true, result: { metadata: command.patch } }
      }
    } })
    h.app.applySettings({ onboarded: true })
    conversation(id, h.app.onEvent).exchange("hello", "hi")
    await h.type("/sessions\r")
    await h.app.onKey("\x14")
    await h.type("review color:cyan")
    await h.app.onKey("\r")
    expect(h.sentOf("session.agent-view.metadata.patch").at(-1)).toEqual({ type: "session.agent-view.metadata.patch", sessionId: id, patch: { tags: ["review"], color: "cyan" } })
    expect(h.text().join("\n")).toContain("#review")
  })

  test("ctrl+f asks the daemon to look in messages, scoped to the listed sessions, and the hits filter the list", async () => {
    const one = make({ title: "alpha", directory: "/project" })
    const two = make({ title: "beta", directory: "/project" })
    const h = appHarness({ sessionId: one.sessionId, dataDir: tempDir(), directory: "/project", reply: (command) => {
      if (command.type === "session.list") return { ok: true, result: { sessions: [one, two] } }
      if (command.type === "session.search") return { ok: true, result: { hits: [{ sessionId: two.sessionId, snippet: "we should refund the order" }] } }
    } })
    h.app.applySettings({ onboarded: true })
    conversation(one.sessionId, h.app.onEvent).exchange("hello", "hi")
    await h.type("/sessions\r")
    await h.app.onKey("\x06")
    await h.type("refund")
    const asked = h.sentOf("session.search").at(-1)
    expect(asked).toMatchObject({ type: "session.search", text: "refund", limit: 100 })
    expect(asked).not.toHaveProperty("regex")
    expect((asked as { sessionIds: string[] }).sessionIds.sort()).toEqual([one.sessionId, two.sessionId].sort())
    const out = h.text().join("\n")
    expect(out).toContain("beta")
    expect(out).not.toContain("alpha")
  })
})
