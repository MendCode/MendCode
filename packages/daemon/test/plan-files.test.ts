import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { todoTool } from "@mendcode/engine-native"
import type { SessionEvent, SessionId } from "@mendcode/protocol"
import { createPeers } from "../src/peers"
import { sessionsTool } from "../src/peer-tools"
import { createPlanFiles, planLine, projectFolder } from "../src/plan-files"
import { boot, callTool, openSession, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
const temps: string[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0).reverse()) await h.cleanup()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function start(options: Parameters<typeof boot>[0]) { const h = await boot(options); harnesses.push(h); return h }
const settled = (h: NativeHarness, sessionId: SessionId) => until(() => h.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
async function review(h: NativeHarness, sessionId: SessionId) {
  const before = h.events.length
  await h.client.send({ type: "user.submit", sessionId, text: "Prepare the plan", attachments: [] })
  await until(() => h.events.slice(before).some((event) => event.type === "server.request" && event.planReview))
  const event = h.events.slice(before).find((event) => event.type === "server.request" && event.planReview)!
  if (event.type !== "server.request") throw new Error("missing review")
  return event
}
const plansOf = (h: NativeHarness) => path.join(h.dir, "plans", projectFolder(h.project))
const filesOf = (folder: string) => { try { return readdirSync(folder).filter((name) => name.endsWith(".md")) } catch { return [] } }

test("an applied plan is saved with its final text and comments in the project's folder of the data directory", async () => {
  const h = await start({ steps: [callTool("plan_review", { title: "Socket recovery", markdown: "# Recovery\n\n1. Fix reconnect" }), stop("done")] })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const sessionId = await openSession(h, "plan" as never)
  const request = await review(h, sessionId)
  expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", markdown: "# Recovery\n\n1. Fix reconnect\n2. Add the regression test", comments: "Keep retries bounded" })).ok).toBe(true)
  await settled(h, sessionId)
  const names = filesOf(plansOf(h))
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/^plan-socket-recovery-[a-z0-9]{1,8}\.md$/)
  const text = readFileSync(path.join(plansOf(h), names[0]!), "utf8")
  expect(text).toContain('title: "Socket recovery"')
  expect(text).toContain("status: applied")
  expect(text).toContain(`session: ${sessionId}`)
  expect(text).toContain("2. Add the regression test")
  expect(text).toContain("Keep retries bounded")
  expect(existsSync(path.join(h.project, ".mendcode"))).toBe(false)
})

test("a session without a plan writes nothing, and neither does minimalist or a rejected plan", async () => {
  const h = await start({ steps: [stop("hello")] })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const sessionId = await openSession(h, "full")
  await h.client.send({ type: "user.submit", sessionId, text: "hi", attachments: [] })
  await settled(h, sessionId)
  expect(existsSync(path.join(h.dir, "plans"))).toBe(false)

  const m = await start({ steps: [callTool("plan_review", { markdown: "# Plan\n\n1. A" }), stop("ok")] })
  await m.client.send({ type: "settings.set", patch: { tier: "minimalist" } })
  const minimal = await openSession(m, "plan" as never)
  const request = await review(m, minimal)
  await m.client.reviewPlan(minimal, request.requestId, { action: "apply" })
  await settled(m, minimal)
  expect(existsSync(path.join(m.dir, "plans"))).toBe(false)

  const r = await start({ steps: [callTool("plan_review", { markdown: "# Plan\n\n1. A" }), stop("ok")] })
  await r.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const rejected = await openSession(r, "plan" as never)
  const asked = await review(r, rejected)
  await r.client.reviewPlan(rejected, asked.requestId, { action: "reject", reason: "No" })
  await settled(r, rejected)
  expect(existsSync(path.join(r.dir, "plans"))).toBe(false)
})

test("plan_files_location repo keeps the file in .mendcode/plans of the project", async () => {
  const h = await start({ steps: [callTool("plan_review", { title: "In repo", markdown: "# Plan\n\n1. A" }), stop("ok")] })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced", plan_files_location: "repo" } })
  const sessionId = await openSession(h, "plan" as never)
  const request = await review(h, sessionId)
  await h.client.reviewPlan(sessionId, request.requestId, { action: "accept" })
  await settled(h, sessionId)
  expect(filesOf(path.join(h.project, ".mendcode", "plans"))).toHaveLength(1)
  expect(existsSync(path.join(h.dir, "plans"))).toBe(false)
})

test("the todo list of the session is mirrored into the plan's Progress and finishes it", async () => {
  const items = (a: string, b: string) => ({ items: [{ text: "Fix reconnect", status: a }, { text: "Add test", status: b }] })
  const h = await start({ extraTools: [todoTool], steps: [callTool("plan_review", { title: "Steps", markdown: "# Steps\n\n1. Fix reconnect\n2. Add test" }), callTool("todo", items("done", "in_progress")), callTool("todo", items("done", "done")), stop("finished")] })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const sessionId = await openSession(h, "plan" as never)
  const request = await review(h, sessionId)
  await h.client.reviewPlan(sessionId, request.requestId, { action: "apply" })
  await settled(h, sessionId)
  const file = path.join(plansOf(h), filesOf(plansOf(h))[0]!)
  await until(() => readFileSync(file, "utf8").includes("status: done"))
  const text = readFileSync(file, "utf8")
  expect(text).toContain("steps: 2/2")
  expect(text).toContain("- [x] Fix reconnect")
  expect(text).toContain("- [x] Add test")
  expect(text.match(/## Progress/g)).toHaveLength(1)
})

// ── the module on its own: engine-owned files, compaction, listing, other sessions ──
function unit(options: { enabled?: boolean; location?: "data" | "repo" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-files-"))
  const project = mkdtempSync(path.join(tmpdir(), "plan-files-proj-"))
  temps.push(dir, project)
  const files = createPlanFiles({ dir, enabled: () => options.enabled !== false, location: () => options.location ?? "data", directoryOf: () => project, now: () => Date.UTC(2026, 10, 3, 12) })
  let seq = 0
  const base = (sessionId: string) => ({ sessionId: sessionId as SessionId, seq: ++seq, at: 1 })
  const plan = (sessionId: string, requestId: string, review: Record<string, unknown>, reply: Record<string, unknown>) => {
    files.observe({ ...base(sessionId), type: "server.request", requestId, turnId: "t1", kind: "approval", title: "Review plan", detail: "", planReview: { phase: "implementation", destination: "build", ...review } } as unknown as SessionEvent)
    files.observe({ ...base(sessionId), type: "server.request.resolved", requestId, resolution: "approved", planReview: { kind: "plan_review", ...reply } } as unknown as SessionEvent)
  }
  const compaction = (sessionId: string) => files.observe({ ...base(sessionId), type: "item.started", turnId: "t1", itemId: "i1", kind: "compaction" } as unknown as SessionEvent)
  return { dir, project, files, plan, compaction }
}

test("after a compaction the next turn gets the plan's path and state, once, and not the plan", () => {
  const u = unit()
  u.plan("ses_aaaa1111", "r1", { title: "Pointer", markdown: "# Pointer\n\n1. One\n2. Two" }, { action: "apply" })
  expect(u.files.afterCompaction("ses_aaaa1111" as SessionId)).toBeUndefined()
  u.compaction("ses_aaaa1111")
  const note = u.files.afterCompaction("ses_aaaa1111" as SessionId)!
  expect(note.text).toContain(path.join(u.dir, "plans", projectFolder(u.project)))
  expect(note.text).toContain("applied")
  expect(note.text).not.toContain("1. One")
  note.done()
  expect(u.files.afterCompaction("ses_aaaa1111" as SessionId)).toBeUndefined()
  // A compaction that lands while the turn runs is not covered by the note that turn carried.
  u.compaction("ses_aaaa1111")
  const again = u.files.afterCompaction("ses_aaaa1111" as SessionId)!
  u.compaction("ses_aaaa1111")
  again.done()
  expect(u.files.afterCompaction("ses_aaaa1111" as SessionId)).toBeDefined()
  expect(u.files.pointer("ses_aaaa1111" as SessionId)).toContain("Plan file:")
  expect(u.files.roots("ses_aaaa1111" as SessionId)).toEqual([path.join(u.dir, "plans", projectFolder(u.project))])
})

test("an engine's own plan file is registered and not copied", () => {
  const u = unit()
  const engineFile = path.join(u.dir, "claude-plan.md")
  writeFileSync(engineFile, "# Engine plan\n\n1. Do it\n")
  u.plan("ses_bbbb2222", "r1", { markdown: "# Engine plan\n\n1. Do it", file: engineFile }, { action: "apply" })
  const [entry] = u.files.list({ directory: u.project })
  expect(entry).toMatchObject({ title: "Engine plan", status: "applied", path: engineFile })
  expect(entry!.record).not.toBe(engineFile)
  expect(readFileSync(entry!.record, "utf8")).not.toContain("1. Do it")
  const read = u.files.read(entry!.id, u.project)
  expect(read.ok && read.text).toContain("1. Do it")
  u.compaction("ses_bbbb2222")
  expect(u.files.afterCompaction("ses_bbbb2222" as SessionId)!.text).toContain(engineFile)
})

test("plans list for the project and for all, read by id, with the feature off nothing is found", () => {
  const u = unit()
  u.plan("ses_cccc3333", "r1", { title: "One", markdown: "1. a" }, { action: "accept" })
  u.plan("ses_dddd4444", "r2", { title: "Two", markdown: "1. b" }, { action: "apply", markdown: "1. b edited" })
  const listed = u.files.list({ directory: u.project })
  expect(listed.map((plan) => plan.title).sort()).toEqual(["One", "Two"])
  expect(u.files.list({ all: true })).toHaveLength(2)
  const two = listed.find((plan) => plan.title === "Two")!
  expect(planLine(two)).toContain(`plan=${two.id}`)
  const read = u.files.read(two.id)
  expect(read.ok && read.text).toContain("1. b edited")
  expect(u.files.read("plan-../../etc").ok).toBe(false)
  expect(createPlanFiles({ dir: u.dir, enabled: () => false, location: () => "data", directoryOf: () => u.project, now: () => 0 }).list({ all: true })).toEqual([])
})

test("secrets in a plan are redacted in the file", () => {
  const u = unit()
  u.plan("ses_eeee5555", "r1", { title: "Keys", markdown: "# Keys\n\nUse sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH for it" }, { action: "apply" })
  const [entry] = u.files.list({ directory: u.project })
  expect(readFileSync(entry!.path, "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789")
})

test("sessions plans=true lists and reads plans through the peer port, local only", async () => {
  const u = unit()
  u.plan("ses_ffff6666", "r1", { title: "Shared", markdown: "# Shared\n\n1. share me" }, { action: "apply" })
  const restricted = new Set<string>()
  const peers = createPeers({
    clock: { now: () => 0 } as never,
    sessions: () => [], info: () => ({ title: "t", directory: u.project }), state: () => "idle", notify: async () => undefined,
    plans: (from, where) => restricted.has(from) ? { ok: false, message: "reading plans is local only" } : (() => { const found = u.files.list(where?.scope === "all" ? { all: true } : { directory: where?.directory ?? u.project }); return { ok: true as const, output: found.map(planLine).join("\n"), count: found.length } })(),
    readPlan: (from, id) => { const plan = u.files.read(id, u.project); return plan.ok ? { ok: true, output: plan.text } : plan },
  })
  const context = (from: string) => ({ peers: peers.port(from as SessionId) }) as never
  const listed = await sessionsTool.execute({ plans: true }, context("ses_other0001"))
  expect(listed.output).toContain("title=\"Shared\"")
  const id = /plan=(\S+)/.exec(listed.output)![1]!
  const read = await sessionsTool.execute({ read: id }, context("ses_other0001"))
  expect(read.output).toContain("1. share me")
  restricted.add("ses_remote01")
  expect((await sessionsTool.execute({ plans: true }, context("ses_remote01"))).isError).toBe(true)
})

test("a native compaction keeps the plan's path in its engine anchor once, and the next message does not repeat it", async () => {
  const h = await start({ steps: [callTool("plan_review", { title: "Keep me", markdown: "# Keep me\n\n1. Unique step text" }), stop("applied"), stop("## Goal\n- summary"), stop("after")] })
  await h.client.send({ type: "settings.set", patch: { tier: "balanced" } })
  const sessionId = await openSession(h, "plan" as never)
  const request = await review(h, sessionId)
  await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", permission: "ask" })
  await settled(h, sessionId)
  const compact = await h.client.send({ type: "session.compact", sessionId })
  expect(compact.ok).toBe(true)
  await until(() => h.events.some((event) => event.type === "item.started" && event.kind === "compaction"))
  await settled(h, sessionId)
  const before = h.requests.length
  await h.client.send({ type: "user.submit", sessionId, text: "continue", attachments: [] })
  await settled(h, sessionId)
  const sent = JSON.stringify(h.requests.slice(before).at(-1)!.messages)
  expect(sent.match(/Plan file:/g)).toHaveLength(1)
  expect(sent).toContain(plansOf(h))
  expect(sent).toContain("Engine Anchor")
})
