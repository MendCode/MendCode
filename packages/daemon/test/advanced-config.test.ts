import { afterEach, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Settings, type AgentsReport, type ModelChoice, type ModelsReport } from "@mendcode/protocol"
import { boot, callTool, openSession, put, say, stop, until, type NativeHarness } from "./native-harness"
import { createProviderService } from "../src/providers"
import { createToolOutputs } from "../src/tool-output"
import { clearFilesIndexCache } from "../src/files-index"
import type { CommandReply } from "@mendcode/client"
import { fileIgnore } from "../src/file-ignore"

const harnesses: NativeHarness[] = []
afterEach(async () => { clearFilesIndexCache(); for (const h of harnesses.splice(0)) await h.cleanup() })
async function start(options: Parameters<typeof boot>[0] = {}) { const h = await boot(options); harnesses.push(h); return h }
function result(ack: CommandReply) { if (!ack.ok) throw new Error(ack.error.message); return ack.result }

test("settings merge builtin overrides, choose default agents and preserve advanced generation on real turns", async () => {
  const h = await start({ steps: [stop("reviewed"), stop("planned")] })
  put(path.join(h.dir, "agents", "build.md"), "---\noptions:\n  seed: 7\n---\nExisting build prompt.")
  const patch = { default_agent: "build", plan_exit_agent: "reviewer", agent: { build: { temperature: 0.2, top_p: 0.8, model: "gpt-6-sol", variant: "high", color: "#22cc88" }, plan: { prompt: "Plan override." }, reviewer: { description: "Review", mode: "primary" as const }, hidden: { hidden: true }, old: { disable: true } } }
  expect((await h.client.send({ type: "settings.set", patch })).ok).toBe(true)
  const sessionId = await openSession(h)
  await say(h, sessionId, "review")
  expect(h.requests[0]).toMatchObject({ system: expect.stringContaining("Existing build prompt."), model: "gpt-6-sol", effort: "high", parameters: { seed: 7, temperature: 0.2, top_p: 0.8 } })
  const ack = await h.client.send({ type: "agents.list", sessionId })
  expect(ack.ok).toBe(true)
  const report = result(ack) as AgentsReport
  expect(report.agents.filter((agent) => agent.name === "build")).toHaveLength(1)
  expect(report.agents.find((agent) => agent.name === "build")).toMatchObject({ color: "#22cc88", source: "user" })
  expect((await h.client.send({ type: "session.agent.set", sessionId, agent: "old" })).ok).toBe(false)
  await h.client.send({ type: "session.agent.set", sessionId, agent: "plan" })
  await say(h, sessionId, "plan")
  expect(h.requests[1]!.system).toContain("Plan override.")
})

test("invalid defaults fail before creating a session; disabled build and plan cannot bypass selection", async () => {
  const h = await start()
  for (const default_agent of ["missing", "hidden", "child"]) {
    await h.client.send({ type: "settings.set", patch: { default_agent, agent: { hidden: { hidden: true }, child: { mode: "subagent" } } } })
    expect(await h.client.send({ type: "session.create", directory: h.project })).toMatchObject({ ok: false, error: { message: expect.stringContaining("invalid default agent") } })
  }
  await h.client.send({ type: "settings.set", patch: { default_agent: null } })
  const sessionId = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { agent: { build: { disable: true }, plan: { disable: true } } } })
  for (const agent of ["build", "plan", null]) expect((await h.client.send({ type: "session.agent.set", sessionId, agent })).ok).toBe(false)
  expect((await h.client.send({ type: "user.submit", sessionId, text: "no fallback", attachments: [] })).ok).toBe(false)
  expect(h.requests).toEqual([])
})

test("subagent_variant applies to durable tasks and an explicit model/variant wins over agent defaults", async () => {
  const h = await start({ steps: [callTool("task", { description: "lookup", prompt: "look", agent: "scout", model: "gpt-6-sol", variant: "high" }), stop("found"), stop("done")] })
  await h.client.send({ type: "settings.set", patch: { subagent_variant: "high", agent: { scout: { mode: "subagent", description: "Scout", model: "gpt-6-luna", variant: "high", options: { seed: 8 } } } } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "delegate")
  expect(h.requests[1]).toMatchObject({ model: "gpt-6-sol", effort: "high", parameters: { temperature: 0.8, seed: 8 } })
})

test("global subagent variant is inherited when a task has no explicit model or agent variant", async () => {
  const h = await start({ steps: [callTool("task", { description: "lookup", prompt: "look" }), stop("found"), stop("done")] })
  await h.client.send({ type: "settings.set", patch: { subagent_variant: "high" } })
  await say(h, await openSession(h), "delegate")
  expect(h.requests[1]).toMatchObject({ model: "script-1", effort: "high", parameters: { temperature: 0.8 } })
})

test("custom default and plan_exit_agent select the configured primary, overriding the older alias", async () => {
  const h = await start({ steps: [callTool("plan_review", { markdown: "# Implementation\n\nReview and verify the change." }), stop("done")] })
  await h.client.send({ type: "settings.set", patch: { default_agent: "reviewer", plan_exit_agent: "reviewer", planExitAgent: "build", agent: { reviewer: { description: "Review", mode: "primary", prompt: "Reviewer instructions.", temperature: 0.3 } } } })
  const sessionId = await openSession(h)
  expect(h.store.sessionAgent(sessionId)).toBe("reviewer")
  await h.client.send({ type: "session.agent.set", sessionId, agent: "plan" })
  await h.client.send({ type: "user.submit", sessionId, text: "Prepare an implementation plan", attachments: [] })
  await until(() => h.events.some((event) => event.type === "server.request" && event.planReview))
  const request = h.events.find((event) => event.type === "server.request" && event.planReview)!
  if (request.type !== "server.request") throw new Error("missing plan request")
  expect(request.planReview?.destination).toBe("reviewer")
  expect((await h.client.reviewPlan(sessionId, request.requestId, { action: "apply" })).ok).toBe(true)
  await until(() => h.store.lastTurnStatus(sessionId) === "completed")
  expect(h.requests[1]).toMatchObject({ system: expect.stringContaining("Reviewer instructions."), parameters: { temperature: 0.3 } })
  expect(h.store.sessionAgent(sessionId)).toBe("reviewer")
})

test("exact model denies and provider allowlists change catalog and reject selection", async () => {
  const h = await start()
  const sessionId = await openSession(h)
  await h.client.send({ type: "settings.set", patch: { disabled_models: ["chatgpt/gpt-6-sol"] } })
  const listed = await h.client.send({ type: "models.list", sessionId })
  expect((result(listed) as ModelsReport).models.some((model) => model.id === "gpt-6-sol")).toBe(false)
  expect((await h.client.send({ type: "session.model.set", sessionId, choice: { model: "gpt-6-sol" } })).ok).toBe(false)
  await h.client.send({ type: "settings.set", patch: { enabled_providers: [] } })
  expect((result(await h.client.send({ type: "models.list", sessionId })) as ModelsReport).models).toEqual([])
})

test("watcher.ignore removes indexed files and their descendants from mention search", async () => {
  const h = await start()
  put(path.join(h.project, "generated", "hidden.ts"), "x")
  put(path.join(h.project, "visible.ts"), "x")
  await h.client.send({ type: "settings.set", patch: { watcher: { ignore: ["**/generated/**"] } } })
  const ack = await h.client.send({ type: "files.search", directory: h.project, query: "" })
  expect(JSON.stringify(result(ack))).toContain("visible.ts")
  expect(JSON.stringify(result(ack))).not.toContain("hidden.ts")
  expect(fileIgnore(["generated"])("src/generated/hidden.ts")).toBe(true)
  expect(fileIgnore(["generated"])("src/visible.ts")).toBe(false)
})

test("provider config maps SDK names, merges offline models.dev metadata and enforces filters at runtime", async () => {
  const h = await start()
  writeFileSync(path.join(h.dir, "models.dev.json"), JSON.stringify({ local: { models: { fast: { name: "Fast", family: "local", reasoning: true, temperature: true, tool_call: true, release_date: "2026-01-01", cost: { input: 1, output: 3 }, limit: { context: 64000, output: 4096 }, modalities: { input: ["text"], output: ["text"] }, variants: { high: { temperature: 0.4 }, off: { disabled: true } } }, old: { name: "Old" } } } }))
  let settings = Settings.parse({ provider: { local: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://local.test/v1", timeout: false, chunkTimeout: false, seed: 4 }, whitelist: ["fast", "old"], blacklist: ["old"] } } })
  const providers = createProviderService({ dir: h.dir, env: {}, settings: () => settings, fetch: async () => { throw new Error("must not fetch") } })
  expect(providers.models()).toMatchObject([{ id: "local:fast", contextWindow: 64000, cost: { input: 1, output: 3 }, variants: { high: { parameters: { temperature: 0.4 } } } }])
  expect(providers.models()[0]?.variants?.off).toBeUndefined()
  const runtime = providers.runtime().local!
  await expect(Array.fromAsync(runtime.stream({ system: "", messages: [], tools: [], model: "old", signal: new AbortController().signal }))).rejects.toThrow("excluded")
  settings = Settings.parse({ provider: { local: { npm: "unsupported-sdk", baseUrl: "http://local.test/v1" } } })
  expect(providers.list()[0]).toMatchObject({ enabled: false, error: expect.stringContaining("unsupported SDK") })
})

test("title and summary roles run asynchronously, persist, look again at turn 3, refresh at turn 15 and preserve renamed titles", async () => {
  const calls: Array<{ system: string; model?: ModelChoice }> = []
  const h = await start({ steps: Array.from({ length: 16 }, () => stop("completed work")), complete: async (input) => { calls.push(input); return input.system.includes("title") ? `Generated title ${calls.filter((call) => call.system.includes("title")).length}` : "Updated summary" } })
  await h.client.send({ type: "settings.set", patch: { models: { title: { model: "gpt-6-luna" }, summary: { model: "gpt-6-sol" } } } })
  const sessionId = await openSession(h)
  for (let i = 0; i < 15; i++) { await say(h, sessionId, `work ${i}`); await until(() => calls.filter((call) => call.system.includes("Summarize")).length === i + 1) }
  const titleCalls = calls.filter((call) => call.system.includes("title")) as Array<{ system: string; prompt?: string }>
  expect(titleCalls).toHaveLength(3)
  expect(titleCalls[1]?.prompt).toContain("Current title: Generated title 1")
  expect(titleCalls[1]?.prompt).toContain("work 2")
  expect(calls[0]?.model?.model).toBe("gpt-6-luna")
  expect(calls[1]?.model?.model).toBe("gpt-6-sol")
  expect(h.store.sessionInfo(sessionId)?.title).toBe("Generated title 3")
  const ack = await h.client.send({ type: "session.list", directory: h.project })
  expect(JSON.stringify(result(ack))).toContain("Updated summary")
  await h.client.send({ type: "session.rename", sessionId, title: "My title" })
  await say(h, sessionId, "continue")
  expect(h.store.sessionInfo(sessionId)?.title).toBe("My title")
})

test("an in-flight title completion cannot overwrite a manual rename, and children have no metadata calls", async () => {
  let release!: (text: string) => void
  let calls = 0
  const h = await start({ steps: [stop("done"), stop("child")], complete: async (input) => { calls++; return input.system.includes("title") ? new Promise((resolve) => { release = resolve }) : "summary" } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "go")
  await until(() => !!release)
  await h.client.send({ type: "session.rename", sessionId, title: "Manual" })
  release("Stale generated title")
  await until(() => calls === 2)
  expect(h.store.sessionInfo(sessionId)?.title).toBe("Manual")
  const created = await h.client.send({ type: "session.create", directory: h.project, parentId: sessionId })
  const child = (result(created) as { sessionId: typeof sessionId }).sessionId
  await h.client.subscribe(child, 0)
  await say(h, child, "child")
  expect(calls).toBe(2)
})

test("auxiliary agent frontmatter shapes titles and disabled summary agents make no call", async () => {
  const calls: Array<{ system: string; model?: ModelChoice | undefined }> = []
  const h = await start({ steps: [stop("done")], complete: async (input) => { calls.push(input); return "Specific title" } })
  put(path.join(h.dir, "agents", "title.md"), "---\ndescription: Titles\nmodel: gpt-6-luna\ntemperature: 0.1\ntop_p: 0.8\noptions:\n  seed: 3\n---\nSpecific title instructions.")
  await h.client.send({ type: "settings.set", patch: { agent: { summary: { disable: true } } } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "go")
  await until(() => h.store.sessionInfo(sessionId)?.title === "Specific title")
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ system: "Specific title instructions.", model: { model: "gpt-6-luna", parameters: { seed: 3, temperature: 0.1, top_p: 0.8 } } })
})

test("metadata completions coalesce new turns while busy and recover summary after a title failure", async () => {
  let release!: () => void
  const prompts: string[] = []
  let titles = 0
  const h = await start({ steps: [stop("first"), stop("second")], complete: async (input) => {
    if (input.system.includes("title")) { titles++; return "Working title" }
    prompts.push(input.prompt)
    if (prompts.length === 1) await new Promise<void>((resolve) => { release = resolve })
    return `Summary ${prompts.length}`
  } })
  const sessionId = await openSession(h)
  await say(h, sessionId, "First user question")
  await until(() => !!release)
  await say(h, sessionId, "Second user question")
  release()
  await until(() => h.store.meta.get(`session.summary:${sessionId}`) === "Summary 2")
  expect(titles).toBe(1)
  expect(prompts[1]).toContain("Second user question")
  const failed = await start({ steps: [stop("done")], complete: async (input) => { if (input.system.includes("title")) throw new Error("title unavailable"); return "Recovered summary" } })
  const other = await openSession(failed)
  await say(failed, other, "work")
  await until(() => failed.store.meta.get(`session.summary:${other}`) === "Recovered summary")
})

test("tool excerpts have an 8 MB per-file cap, a 64 MB disk budget and one-day retention", async () => {
  const h = await start()
  const outputs = createToolOutputs(h.dir)
  const large = "é".repeat(5 * 1024 * 1024)
  const saved = await outputs.save(large)
  expect(saved.complete).toBe(false)
  expect(statSync(saved.path).size).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(readFileSync(saved.path, "utf8")).not.toContain("�")
  expect(statSync(saved.path).mode & 0o777).toBe(0o600)
  utimesSync(saved.path, new Date(0), new Date(0))
  outputs.cleanup()
  expect(readdirSync(path.dirname(saved.path))).toEqual([])
  for (let i = 0; i < 9; i++) await outputs.save("x".repeat(8 * 1024 * 1024))
  const files = readdirSync(path.dirname(saved.path))
  expect(files.length).toBe(8)
  expect(files.reduce((sum, name) => sum + statSync(path.join(path.dirname(saved.path), name)).size, 0)).toBeLessThanOrEqual(64 * 1024 * 1024)
})

test("/fast is the session's own: stored with its model, kept when the model changes, and the setting untouched", async () => {
  const h = await start()
  const sessionId = await openSession(h)
  const set = (choice: ModelChoice) => h.client.send({ type: "session.model.set", sessionId, choice })
  expect(result(await set({ model: "gpt-6-luna", fast: true })) as ModelsReport).toMatchObject({ session: { model: "gpt-6-luna", fast: true } })
  expect(h.store.sessionModel(sessionId)).toMatchObject({ model: "gpt-6-luna", fast: true })
  expect(result(await set({ model: "gpt-6-sol" })) as ModelsReport).toMatchObject({ session: { model: "gpt-6-sol", fast: true } })
  expect(result(await set({ model: "gpt-6-sol", fast: false })) as ModelsReport).toMatchObject({ session: { fast: false } })
  expect(h.store.settings.get().serviceTier).toBeUndefined()
})
