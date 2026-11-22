import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type MemoryId, type SessionId } from "@mendcode/protocol"
import { boot, callTool, jumpClock, say, stop, until, type NativeHarness } from "./native-harness"
import { buildBrief, createToday, emptyTodayPrefs, memoryGroups, readTodayPrefs, suggestedShape, todayRuleFor, writeTodayPrefs, TODAY_FILE, TODAY_KICKOFF, type TodayMemory, type TodayPrefs, type TodaySession } from "../src/today"
import { todayTool } from "../src/today-tool"

const ids = createIdFactory()
const all: NativeHarness[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const h of all.splice(0).reverse()) await h.cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 10:00 local on a fixed day, so "yesterday" and "today" do not depend on when the test runs. */
const NOW = new Date(2026, 10, 21, 10, 0, 0).getTime()
const HOUR = 3_600_000
const session = (over: Partial<TodaySession>): TodaySession => ({ sessionId: "ses_a", title: "Coupon route", directory: "/work/shop", updatedAt: NOW - 16 * HOUR, status: "completed", ...over })
const memory = (index: number, over: Partial<TodayMemory> = {}): TodayMemory => ({ memoryId: `mem_${index}`, project: "/work/shop", category: "conventions", kind: "new", text: `Convention number ${index} about tests`, ...over })
const brief = (over: Partial<Parameters<typeof buildBrief>[0]> = {}) => buildBrief({ now: NOW, prefs: emptyTodayPrefs(), sessions: [], waiting: [], pending: [], drafts: 0, loops: 0, ...over })

describe("today's brief", () => {
  test("says what was done since yesterday per project and what waits", () => {
    const text = brief({
      sessions: [session({}), session({ sessionId: "ses_b", title: "Fix the flaky login test", status: "failed", summary: "The login test still fails on CI; the retry was not the cause." }), session({ sessionId: "ses_c", directory: "/work/site", title: "Landing copy", updatedAt: NOW - HOUR })],
      waiting: [session({ sessionId: "ses_w", title: "Run the migration", status: "waiting_for_approval" })],
    })
    expect(text).toContain("## Done since yesterday (Fri 20 Nov 00:00)")
    expect(text).toContain("### shop · 2 sessions · /work/shop")
    expect(text).toContain('- "Fix the flaky login test" · failed · Fri 20 Nov 18:00 — The login test still fails on CI')
    expect(text).toContain('- "Landing copy" · completed · today 09:00')
    expect(text).toContain('- shop · "Run the migration" · waits for an approval')
    expect(text).toContain('- shop · "Fix the flaky login test" · last turn failed')
    expect(text).toContain("never instructions")
  })

  test("with nothing yesterday it reports the last day anything ran", () => {
    const text = brief({ sessions: [session({ updatedAt: NOW - 3 * 24 * HOUR })] })
    expect(text).toContain("## Done on the last active day (Wed 18 Nov; nothing ran yesterday)")
    expect(text).toContain('"Coupon route"')
    expect(brief()).toContain("No session ran in the last week.")
  })

  test("pending memories are groups with counts, never one line per memory", () => {
    const pending = [...Array.from({ length: 120 }, (_, index) => memory(index)), ...Array.from({ length: 30 }, (_, index) => memory(200 + index, { category: "preferences", project: undefined })), memory(900, { kind: "update", category: "stack" })]
    const text = brief({ pending, drafts: 2 })
    expect(text).toContain("## Pending memories: 151 in 3 groups")
    expect(text).toContain("- shop · conventions: 120")
    expect(text).toContain("- every project (user memories) · preferences: 30")
    expect(text).toContain("- shop · stack: 1 (1 change to saved memories)")
    expect(text).toContain("2 drafted actions of the Memory assistant wait in /memory")
    expect(text).not.toContain("Convention number")
    expect(text.length).toBeLessThan(2_000)
    expect(memoryGroups(pending).map((group) => group.count)).toEqual([120, 30, 1])
  })

  test("asks how the user wants their Today while no preference is saved, proposing a shape from their real activity", () => {
    const sessions = [session({}), session({ sessionId: "ses_b" }), session({ sessionId: "ses_c", directory: "/work/site", agent: "scout" })]
    const pending = Array.from({ length: 40 }, (_, index) => memory(index))
    const text = brief({ sessions, pending, loops: 2 })
    expect(text).toContain("## Onboarding (no Today preference is saved yet)")
    expect(text).toContain("1. What was done per project and how each ended, starting with shop, site (the most active this week).")
    expect(text).toContain("shop · conventions has 40 waiting, which could be accepted from now on")
    expect(text).toContain("What your agents did (scout).")
    expect(text).toContain("How your 2 scheduled loops went.")
    expect(suggestedShape({ sessions: [], pending: [], loops: 0 })).toEqual(["What was done per project and how each ended.", "What waits for you (approvals, questions, failed or interrupted turns) before anything else.", "Any check you want every day (a server, a dashboard, a deploy): say it and it runs in every Today."])
  })

  test("saved preferences end the onboarding and are listed to be carried out", () => {
    const prefs: TodayPrefs = { ...emptyTodayPrefs(), onboarded: true, instructions: [{ id: "i1", text: "Check that the VPS at status.example.test answers and the dashboard has data from today", createdAt: NOW }], rules: [{ id: "r1", project: "/work/shop", action: "accept", createdAt: NOW }] }
    const text = brief({ prefs })
    expect(text).not.toContain("## Onboarding")
    expect(text).toContain("## Standing instructions (carry out each one now and report what you observed)")
    expect(text).toContain("- i1: Check that the VPS at status.example.test answers")
    expect(text).toContain("- r1: accept · shop · every kind")
    expect(brief({ prefs: { ...emptyTodayPrefs(), onboarded: true } })).not.toContain("## Onboarding")
  })

  test("a long day cuts the activity, never the standing instructions", () => {
    const prefs: TodayPrefs = { ...emptyTodayPrefs(), onboarded: true, instructions: [{ id: "i1", text: "Check the status page answers", createdAt: 1 }] }
    const busy = Array.from({ length: 40 }, (_, index) => session({ sessionId: `ses_${index}`, directory: `/work/p${index % 8}`, title: `Task ${index}`, summary: "x".repeat(220) }))
    const text = brief({ prefs, sessions: busy })
    expect(text).toContain("(brief cut here)")
    expect(text).toContain("## Standing instructions")
    expect(text).toContain("- i1: Check the status page answers")
  })

  test("the day's own Today chats are not reported as work", () => {
    const prefs: TodayPrefs = { ...emptyTodayPrefs(), sessions: [{ day: "2026-11-20", sessionId: "ses_today" }] }
    expect(brief({ prefs, sessions: [session({ sessionId: "ses_today", title: "Today · Fri 20 Nov" })] })).not.toContain("Today · Fri 20 Nov")
  })
})

/** `createToday` over in-memory stand-ins for the daemon's sessions and memories, so a selector, a rule or an open is checked without a chat. */
function service(over: { pending?: TodayMemory[]; prefs?: TodayPrefs } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-today-unit-"))
  dirs.push(dir)
  let prefs = over.prefs ?? emptyTodayPrefs()
  let pending = over.pending ?? []
  const decided: Array<[string, boolean]> = []
  const today = createToday({
    dir, now: () => NOW,
    prefs: { get: () => prefs, set: (next) => { prefs = next } },
    sessions: () => [], waiting: () => [],
    pending: () => ({ memories: pending, drafts: 0 }),
    decide: (memoryId, accept) => { decided.push([memoryId, accept]); pending = pending.filter((entry) => entry.memoryId !== memoryId); return "done" },
    ending: () => undefined, loops: () => 0, canonical: (directory) => directory,
  })
  return { today, decided, prefs: () => prefs }
}

describe("today's selectors and rules", () => {
  test("a whitespace-only query names no memory, so accept and decline decide nothing", () => {
    const { today, decided } = service({ pending: [memory(1), memory(2)] })
    for (const action of ["accept", "decline"] as const) expect(today.run({ action, query: "   " })).toMatchObject({ ok: false, message: expect.stringContaining("say which memories") })
    expect(decided).toEqual([])
  })

  test("opens at the same time share one chat and one kickoff", async () => {
    const { today } = service()
    let created = 0
    const input = { alive: () => true, turns: () => 0, create: async () => { created++; await Promise.resolve(); return `ses_${created}` } }
    const [first, second] = await Promise.all([today.open(input), today.open(input)])
    expect(created).toBe(1)
    expect(first).toEqual({ sessionId: "ses_1", fresh: true, kickoff: TODAY_KICKOFF })
    expect(second).toEqual({ sessionId: "ses_1", fresh: false })
    // An open right after, before the first message lands, does not hand the kickoff out again.
    expect(await today.open(input)).toEqual({ sessionId: "ses_1", fresh: false })
  })

  test("a broad rule added after a more specific one leaves the memories the specific rule decides", () => {
    const specific: TodayPrefs["rules"][number] = { id: "r1", project: "/work/shop", action: "accept", createdAt: 1 }
    const { today, decided } = service({ prefs: { ...emptyTodayPrefs(), rules: [specific] }, pending: [memory(1), memory(2, { project: "/work/site" })] })
    expect(today.run({ action: "rule", decision: "decline", category: "conventions" })).toMatchObject({ ok: true })
    expect(decided).toEqual([["mem_2", false]])
  })
})

describe("today's rules and file", () => {
  const rules: TodayPrefs["rules"] = [
    { id: "r1", category: "preferences", action: "decline", createdAt: 1 },
    { id: "r2", project: "/work/shop", action: "accept", createdAt: 2 },
    { id: "r3", project: "/work/shop", category: "security", action: "decline", createdAt: 3 },
  ]
  test("the most specific rule decides: project and kind, then project, then kind", () => {
    expect(todayRuleFor(rules, "/work/shop", "security")?.id).toBe("r3")
    expect(todayRuleFor(rules, "/work/shop", "preferences")?.id).toBe("r2")
    expect(todayRuleFor(rules, "/work/site", "preferences")?.id).toBe("r1")
    expect(todayRuleFor(rules, "/work/site", "stack")).toBeUndefined()
    expect(todayRuleFor(rules, undefined, "Preferences")?.id).toBe("r1")
  })

  test("preferences are written private, read back, and a file that is not Today's reads as none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mend-today-prefs-"))
    dirs.push(dir)
    const saved = writeTodayPrefs(dir, { ...emptyTodayPrefs(), onboarded: true, rules })
    expect(readTodayPrefs(dir)).toEqual(saved)
    expect(() => writeTodayPrefs(dir, { ...emptyTodayPrefs(), rules: [{ id: "r1", action: "keep" as never, createdAt: 1 }] })).toThrow("[TODAY]:")
    writeFileSync(path.join(dir, TODAY_FILE), "{ not json")
    expect(readTodayPrefs(dir)).toEqual(emptyTodayPrefs())
  })
})

const pendingOf = (h: NativeHarness) => h.store.memories.list({ status: "pending", session: "all" })
const savedOf = (h: NativeHarness) => h.store.memories.list({ status: "saved", session: "all" })
/** The newest finished transcript item (a tool's output) whose text has `marker`, once the client received it. */
async function toolOutput(h: NativeHarness, marker: string) {
  const found = () => h.events.flatMap((event) => (event.type === "item.completed" && typeof event.text === "string" && event.text.includes(marker) ? [event.text] : [])).at(-1)
  await until(() => found() !== undefined)
  return found()!
}
const alnum = (length: number) => "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0".repeat(Math.ceil(length / 30)).slice(0, length)
const seed = (h: NativeHarness, count: number, category: string, directory = h.project) => {
  for (let index = 0; index < count; index++) h.store.memories.add({ memoryId: ids("memory") as MemoryId, scope: "project", directory, text: `${category} fact #${index} of ${path.basename(directory)}`, category, status: "pending", source: "agent" })
}
async function openToday(h: NativeHarness) {
  const reply = await h.client.send({ type: "today.open", directory: h.project })
  if (!reply.ok) throw new Error(JSON.stringify(reply))
  const opened = reply.result as { sessionId: SessionId; fresh: boolean; kickoff?: string }
  await h.client.subscribe(opened.sessionId, 0)
  await h.client.send({ type: "session.permission.set", sessionId: opened.sessionId, mode: "full" })
  return opened
}

describe("the Today chat", () => {
  test("is one chat per day on the default model of a new session, never the small role, with Today's tool and instructions", async () => {
    const h = await boot({ extraTools: [todayTool], steps: [stop("Coupon route merged; the tests are green."), callTool("today", { action: "brief" }), stop("Yesterday: the coupon route."), stop("plain")] })
    all.push(h)
    await h.client.send({ type: "settings.set", patch: { models: { main: { model: "gpt-6-sol" }, small: { model: "gpt-6-luna" } } } })
    // Work done before Today is opened: the brief reports it under its project, with how its last answer began.
    const worked = await h.client.send({ type: "session.create", directory: h.project, title: "Add the coupon route" })
    const work = (worked.ok ? worked.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(work, 0)
    await say(h, work, "add the coupon route")
    h.requests.length = 0
    const opened = await openToday(h)
    expect(opened).toMatchObject({ fresh: true, kickoff: TODAY_KICKOFF })
    expect(h.store.sessionModel(opened.sessionId)).toBeUndefined()
    expect(h.store.sessionAgent(opened.sessionId)).toBeUndefined()
    expect(h.store.sessionInfo(opened.sessionId)?.title).toStartWith("Today · ")
    await say(h, opened.sessionId, opened.kickoff!)
    expect(h.requests[0]!.model).toBe("gpt-6-sol")
    expect(h.requests[0]!.tools.map((tool) => tool.name)).toContain("today")
    expect(h.requests[0]!.system).toContain("You are MendCode's Today assistant")
    expect(h.requests[0]!.system).toContain("BASE")
    const brief = await toolOutput(h, "# Today brief")
    expect(brief).toContain(`### ${path.basename(h.project)} · 1 session`)
    expect(brief).toContain('- "Add the coupon route" · completed · today ')
    expect(brief).toContain("its last answer began: Coupon route merged; the tests are green.")
    expect(brief).toContain("## Onboarding (no Today preference is saved yet)")
    // The same day opens the same chat, with no second brief.
    const again = await h.client.send({ type: "today.open", directory: h.project })
    expect(again.ok && again.result).toEqual({ sessionId: opened.sessionId, fresh: false })
    // A chat that is not Today's gets neither the tool nor the instructions.
    const created = await h.client.send({ type: "session.create", directory: h.project })
    const plain = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(plain, 0)
    await say(h, plain, "hello")
    expect(h.requests.at(-1)!.tools.map((tool) => tool.name)).not.toContain("today")
    expect(h.requests.at(-1)!.system).not.toContain("Today assistant")
  })

  test("accepts and declines memories by group and by topic, leaving the rest pending", async () => {
    const h = await boot({ extraTools: [todayTool], steps: [
      callTool("today", { action: "brief" }),
      callTool("today", { action: "accept", category: "conventions" }),
      // `#1`: a bare `1` can also be in the random name of the test's project folder.
      callTool("today", { action: "memories", query: "stack fact #1" }),
      callTool("today", { action: "decline", query: "stack fact #1" }),
      callTool("today", { action: "accept" }),
      stop("done"),
    ] })
    all.push(h)
    seed(h, 6, "conventions")
    seed(h, 3, "stack")
    const opened = await openToday(h)
    await say(h, opened.sessionId, opened.kickoff!)
    expect(await toolOutput(h, "# Today brief")).toContain("## Pending memories: 9 in 2 groups")
    expect(await toolOutput(h, "accepted")).toContain("accepted 6 memories. 3 still pending.")
    expect(await toolOutput(h, "pending memories match")).toContain("1 pending memories match")
    expect(await toolOutput(h, "declined")).toContain("declined 1 memory. 2 still pending.")
    // Accepting with no project, kind, words or ids decides nothing.
    expect(await toolOutput(h, "say which memories")).toContain("[TODAY]:")
    expect(savedOf(h).map((entry) => entry.category)).toEqual(Array(6).fill("conventions"))
    expect(pendingOf(h).map((entry) => entry.text).sort()).toEqual([`stack fact #0 of ${path.basename(h.project)}`, `stack fact #2 of ${path.basename(h.project)}`])
    expect(h.store.memories.list({ status: "archived", session: "all" })).toHaveLength(1)
  })

  test("an accept rule for a project empties its pile and stops it from growing; a decline rule keeps a kind out", async () => {
    let extracted = 0
    // The project's name is only known once the harness made its folder: the rule steps read it when they run.
    let project = ""
    const h = await boot({
      extraTools: [todayTool],
      dreamEligible: () => true,
      extractMemory: async () => { extracted++; return [{ scope: "project", text: `The deploy script number ${extracted} needs the staging flag`, category: "commands" }, { scope: "project", text: `Preference number ${extracted} about commit style`, category: "preferences" }] },
      steps: [stop("one"), stop("two"), () => callTool("today", { action: "rule", decision: "accept", project }), () => callTool("today", { action: "rule", decision: "decline", project, category: "preferences" }), stop("rules saved"), stop("three"), stop("four")],
    })
    all.push(h)
    project = path.basename(h.project)
    await h.client.send({ type: "settings.set", patch: { memoryGenerate: true, memoryReviewEveryTurns: 2, memoryProjectMaxEntries: 20 } })
    const created = await h.client.send({ type: "session.create", directory: h.project })
    const work = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await h.client.subscribe(work, 0)
    await say(h, work, "first")
    await say(h, work, "second")
    await until(() => extracted === 1 && h.store.extraction.list().length === 0)
    // Without a rule every proposal of the review waits for the user: this is the pile.
    expect(pendingOf(h)).toHaveLength(2)
    expect(savedOf(h)).toHaveLength(0)
    const opened = await openToday(h)
    await say(h, opened.sessionId, "from now on always accept this project's memories, and never keep preferences here")
    expect(await toolOutput(h, "rule r1 saved")).toContain("accepted 2 memories that waited there.")
    expect(await toolOutput(h, "rule r2 saved")).toContain("None waited there.")
    expect(pendingOf(h)).toHaveLength(0)
    expect(savedOf(h)).toHaveLength(2)
    expect(readTodayPrefs(h.dir).rules).toMatchObject([{ id: "r1", project: realpathSync(h.project), action: "accept" }, { id: "r2", project: realpathSync(h.project), category: "preferences", action: "decline" }])
    await say(h, work, "third")
    await say(h, work, "fourth")
    await until(() => extracted === 2 && h.store.extraction.list().length === 0)
    // The next review's proposals do not stack: the project's are saved, the declined kind is not kept.
    expect(pendingOf(h)).toHaveLength(0)
    expect(savedOf(h).map((entry) => entry.text)).toContain("The deploy script number 2 needs the staging flag")
    expect(h.store.memories.list({ session: "all" }).some((entry) => entry.text.startsWith("Preference number 2"))).toBe(false)
  })

  test("a standing instruction is saved, ends the onboarding and reaches the next day's Today, also after a restart", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-today-dir-")))
    const project = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-today-proj-")))
    dirs.push(dir, project)
    const clock = jumpClock()
    const first = await boot({ dir, project, clock, extraTools: [todayTool], steps: [callTool("today", { action: "instruct", text: "Always tell me how the shop project ended up" }), callTool("today", { action: "instruct", text: `Check the dashboard with the key ${"s" + "k-ant-" + "api03-" + alnum(60)}` }), stop("saved")] })
    all.push(first)
    const opened = await openToday(first)
    await say(first, opened.sessionId, "in every today, always tell me how the shop project ended up")
    expect(await toolOutput(first, "carries a credential")).toContain("[TODAY]:")
    const saved = JSON.parse(readFileSync(path.join(dir, TODAY_FILE), "utf8")) as TodayPrefs
    expect(saved).toMatchObject({ onboarded: true, instructions: [{ id: "i1", text: "Always tell me how the shop project ended up" }] })
    expect(saved.instructions).toHaveLength(1)
    await first.daemon.stop()

    clock.jump(24 * HOUR)
    const next = await boot({ dir, project, clock, extraTools: [todayTool], steps: [callTool("today", { action: "brief" }), stop("brief")] })
    all.push(next)
    const tomorrow = await openToday(next)
    expect(tomorrow.fresh).toBe(true)
    expect(tomorrow.sessionId).not.toBe(opened.sessionId)
    await say(next, tomorrow.sessionId, tomorrow.kickoff!)
    const output = await toolOutput(next, "# Today brief")
    expect(output).toContain("- i1: Always tell me how the shop project ended up")
    expect(output).not.toContain("## Onboarding")
    // Yesterday's Today chat is still Today's (its tool answers there), and is not reported as work.
    expect(output).not.toContain("Today · ")
    expect(readTodayPrefs(dir).sessions.map((entry) => entry.sessionId)).toEqual([opened.sessionId, tomorrow.sessionId])
  })

  test("today.open refuses a malformed command", async () => {
    const h = await boot({ extraTools: [todayTool] })
    all.push(h)
    const reply = await h.client.send({ type: "today.open", directory: 7 as never })
    expect(reply.ok).toBe(false)
  })
})
