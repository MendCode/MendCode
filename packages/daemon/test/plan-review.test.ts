import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import type { SessionId } from "@mendcode/protocol"
import { readPlanReviews } from "../src/plan-review"
import { boot, callTool, openSession, put, stop, until, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0).reverse()) await h.cleanup() })
async function start(options: Parameters<typeof boot>[0]) { const h = await boot(options); harnesses.push(h); return h }
async function pending(h: NativeHarness, sessionId: SessionId, text = "Prepare the implementation plan") {
  const before = h.events.length
  await h.client.send({ type: "user.submit", sessionId, text, attachments: [] })
  await until(() => h.events.slice(before).some((event) => event.type === "server.request" && event.planReview))
  const event = h.events.slice(before).find((event) => event.type === "server.request" && event.planReview)!
  if (event.type !== "server.request") throw new Error("missing review")
  return event
}
const settled = (h: NativeHarness, sessionId: SessionId) => until(() => h.store.turns.list(sessionId).every((turn) => turn.status !== "running"))
const file = (extra = "", body = "Implement carefully.") => `---\ndescription: Executes reviewed plans\nmode: primary\n${extra}\n---\n${body}`

test("apply persists edited Markdown, comments and destination; the next call uses that agent's model, tools and prompt", async () => {
  const h = await start({ steps: [callTool("plan_review", { title: "Socket recovery", markdown: "# Recovery\n\n1. Fix reconnect" }), stop("implemented")] })
  put(path.join(h.dir, "agents", "executor.md"), file("model: gpt-6-sol\neffort: high\ntools: read", "Check reconnect races."))
  await h.client.send({ type: "settings.set", patch: { planExitAgent: "executor" } })
  const sessionId = await openSession(h, "plan" as never)
  const request = await pending(h, sessionId)
  expect(request.planReview?.destination).toBe("executor")
  const markdown = `# Approved recovery\n\n${"Read the exact socket contract.\n".repeat(100)}`
  expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", markdown, comments: "Keep retries bounded", destination: "executor" })).ok).toBe(true)
  await settled(h, sessionId)
  await until(() => h.events.some((event) => event.type === "item.completed" && event.text === markdown))
  expect(h.requests[1]).toMatchObject({ model: "gpt-6-sol", effort: "high", system: "BASE\n\n# Agent: executor\n\nCheck reconnect races." })
  expect(h.requests[1]!.tools.some((tool) => tool.name === "write")).toBe(false)
  expect(h.store.sessionAgent(sessionId)).toBe("executor")
  expect(h.store.permissionModeOf(sessionId)).toBe("ask")
  const record = readPlanReviews(h.store, sessionId)[0]!
  expect(record).toMatchObject({ markdown, destination: "executor", phase: "implementation", reply: { action: "apply", markdown, comments: "Keep retries bounded" } })
  expect(h.events.filter((event) => event.type === "item.completed" && event.text === markdown)).toHaveLength(1)
  expect(h.events.find((event) => event.type === "item.completed" && event.text === markdown)).toMatchObject({ toolInput: expect.stringContaining("Approved recovery") })
  expect(h.requests[1]!.messages.find((message) => message.role === "assistant")).toMatchObject({ toolCalls: [{ name: "plan_review", args: { markdown } }] })
  const again = await h.client.reviewPlan(sessionId, request.requestId, { action: "apply" })
  expect(again.ok).toBe(false)
  expect(h.store.permissionModeOf(sessionId)).toBe("ask")
})

for (const action of ["accept", "edit", "reject", "close"] as const) test(`${action} remains read-only and has a durable reply`, async () => {
  const h = await start({ steps: [callTool("plan_submit", { plan: "# Plan\n\nRead the queue" }), stop("reviewed")] })
  const sessionId = await openSession(h, "plan" as never)
  const request = await pending(h, sessionId)
  const reply = { action, ...(action === "edit" ? { markdown: "# Updated\n\nRead the queue and actor", comments: "Add a regression" } : {}), ...(action === "reject" ? { reason: "Missing cancellation" } : {}) }
  expect((await h.client.reviewPlan(sessionId, request.requestId, reply)).ok).toBe(true)
  await settled(h, sessionId)
  expect(h.store.permissionModeOf(sessionId)).toBe("plan")
  expect(h.store.sessionAgent(sessionId)).toBeUndefined()
  expect(readPlanReviews(h.store, sessionId)[0]!.reply).toMatchObject(reply)
  expect((h.requests[1]!.messages.at(-1) as { output: string }).output).toContain(action === "reject" ? "Missing cancellation" : action === "edit" ? "Updated" : action === "accept" ? "does not authorize implementation" : "without authorization")
})

test("planning-only phases, user instructions and edited packets reject apply without consuming the request", async () => {
  for (const [args, prompt, edited] of [
    [{ markdown: "# Plan", phase: "plan" }, "Prepare it", undefined],
    [{ markdown: "# Plan" }, "Plan only, do not implement", undefined],
    [{ markdown: "# Plan" }, "Prepare it", '{"mode":"planner","execute":false}'],
  ] as const) {
    const h = await start({ steps: [callTool("plan_review", args), stop("accepted")] })
    const sessionId = await openSession(h, "plan" as never)
    const request = await pending(h, sessionId, prompt)
    expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", ...(edited ? { markdown: edited } : {}) })).ok).toBe(false)
    expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "accept" })).ok).toBe(true)
    await settled(h, sessionId)
    expect(h.store.permissionModeOf(sessionId)).toBe("plan")
    expect(readPlanReviews(h.store, sessionId)[0]!.reply?.action).toBe("accept")
  }
})

test("configured invalid, hidden, subagent and untrusted destinations fall back to build; an explicit invalid target is refused", async () => {
  const h = await start({ steps: [callTool("plan_review", { markdown: "Plan" }), stop("ok")] })
  put(path.join(h.dir, "agents", "hidden.md"), file("hidden: true"))
  put(path.join(h.project, ".mendcode", "agents", "project.md"), file())
  await h.client.send({ type: "settings.set", patch: { planExitAgent: "hidden" } })
  const sessionId = await openSession(h, "plan" as never)
  const request = await pending(h, sessionId)
  expect(request.planReview?.destination).toBe("build")
  for (const destination of ["ghost", "hidden", "explore", "project", "plan"]) expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", destination })).ok).toBe(false)
  expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", destination: "build" })).ok).toBe(true)
  await settled(h, sessionId)
})

test("plan_exit reads reviewed Markdown after restart; list and client helper keep the review history", async () => {
  const h = await start({ steps: [callTool("plan_review", { markdown: "Old plan" }), stop("refined")] })
  const sessionId = await openSession(h, "plan" as never)
  const request = await pending(h, sessionId)
  await h.client.reviewPlan(sessionId, request.requestId, { action: "edit", markdown: "Reviewed plan" })
  await settled(h, sessionId)
  await h.daemon.stop()
  const restarted = await start({ dir: h.dir, project: h.project, steps: [callTool("plan_exit", {}), stop("done")] })
  await restarted.client.subscribe(sessionId, 0)
  const resumed = await pending(restarted, sessionId, "Continue with the reviewed plan")
  expect(resumed.planReview?.markdown).toBe("Reviewed plan")
  await restarted.client.reviewPlan(sessionId, resumed.requestId, { action: "apply" })
  await settled(restarted, sessionId)
  const records = await restarted.client.planReviews(sessionId)
  expect(records.ok && records.reviews.map((record) => record.reply?.action)).toEqual(["apply", "edit"])
})

test("a restart abandons a pending plan durably without applying it", async () => {
  const h = await start({ steps: [callTool("plan_review", { markdown: "Never apply automatically" })] })
  const sessionId = await openSession(h, "plan" as never)
  await pending(h, sessionId)
  await h.daemon.stop()
  const restarted = await start({ dir: h.dir, project: h.project })
  expect(readPlanReviews(restarted.store, sessionId)[0]!.reply).toMatchObject({ action: "close" })
  expect(restarted.store.permissionModeOf(sessionId)).toBe("plan")
  expect(restarted.requests).toHaveLength(0)
})

test("plan_review can open from build; acceptance enters read-only planning and never selects a destination", async () => {
  const h = await start({ steps: [callTool("plan_review", { markdown: "# Plan\n\nReview first" }), stop("accepted")] })
  const sessionId = await openSession(h)
  const request = await pending(h, sessionId)
  expect(h.store.permissionModeOf(sessionId)).toBe("plan")
  await h.client.reviewPlan(sessionId, request.requestId, { action: "accept" })
  await settled(h, sessionId)
  expect(h.store.permissionModeOf(sessionId)).toBe("plan")
  expect(h.store.sessionAgent(sessionId)).toBeUndefined()
})

test("an explicit destination overrides the default durably; revoked project trust keeps the review pending", async () => {
  const h = await start({ steps: [callTool("plan_review", { markdown: "# Plan\n\nRead source" }), stop("done")] })
  put(path.join(h.project, ".mendcode", "agents", "executor.md"), file())
  await h.client.send({ type: "tools.trust", directory: h.project, trusted: true })
  const sessionId = await openSession(h, "plan" as never)
  const request = await pending(h, sessionId)
  await h.client.send({ type: "tools.trust", directory: h.project, trusted: false })
  expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", destination: "executor" })).ok).toBe(false)
  expect(readPlanReviews(h.store, sessionId)[0]!.reply).toBeUndefined()
  await h.client.send({ type: "tools.trust", directory: h.project, trusted: true })
  expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply", destination: "executor" })).ok).toBe(true)
  await settled(h, sessionId)
  expect(readPlanReviews(h.store, sessionId)[0]!.destination).toBe("executor")
})

test("the read-only report redacts plan titles and user review text before persistence and model delivery", async () => {
  const secret = "sk-proj-" + "Ab12".repeat(8)
  const h = await start({ steps: [callTool("plan_review", { title: `Rotate ${secret}`, markdown: `# Rotate\n\n${secret}` }), stop("edited")] })
  const sessionId = await openSession(h, "plan" as never)
  const request = await pending(h, sessionId)
  expect(JSON.stringify(request.planReview)).not.toContain(secret)
  expect(JSON.stringify(h.store.engineMessages.load(sessionId, "native"))).not.toContain(secret)
  expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "edit", markdown: `# Plan\n\n${secret}`, comments: `Rotate ${secret}` })).ok).toBe(true)
  await settled(h, sessionId)
  const result = await h.client.planReviews(sessionId)
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(JSON.stringify(h.requests[1]!.messages)).not.toContain(secret)
  expect(JSON.stringify(readPlanReviews(h.store, sessionId))).not.toContain(secret)
})
