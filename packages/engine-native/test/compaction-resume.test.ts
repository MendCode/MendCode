import { expect, test } from "bun:test"
import { createNativeEngine, memoryHistory } from "../src/engine"
import { checkpointOf } from "../src/compaction-checkpoint"
import { SUMMARY_PREFIX } from "../src/compaction-policy"
import { acceptSummary, ENGINE_ANCHOR_HEADING, REQUIRED_SUMMARY_HEADINGS, RESUME_HEADING, summaryBody } from "../src/compaction-summary"
import { currentTodos, engineAnchor, imageAttachmentContext, latestUserLanguage, localRescueSummary, renderTranscript, resumeImageRefs, RESUME_IMAGE_MAX_ITEMS } from "../src/compaction-context"
import { loadCompactionPrompt } from "../src/defaults"
import type { ModelMessage, ModelProvider, ModelRequest, ToolCall } from "../src/provider"
import { createIdFactory, type BlobRef, type CompactionConfig } from "@mendcode/protocol"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"

const ids = createIdFactory()
const user = (content: string, attachments?: BlobRef[]): ModelMessage => ({ role: "user", content, ...(attachments ? { attachments } : {}) })
const assistant = (content: string, toolCalls: ToolCall[] = []): ModelMessage => ({ role: "assistant", content, toolCalls })
const result = (callId: string, name: string, output: string, isError = false): ModelMessage => ({ role: "tool", callId, name, output, isError })
const image = (n: number, bytes = 1000): BlobRef => ({ sha256: n.toString(16).padStart(64, "0"), bytes, mime: "image/png", name: `shot-${n}.png` })

const STRUCTURED = `${REQUIRED_SUMMARY_HEADINGS.map((heading) => `${heading}\n- x`).join("\n\n")}`
const LATEST = "Termina el flujo de compactacion, solo local, no hagas push ni subas la version"

/** A session in the middle of work: the user's latest request carries constraints, a TODO list is open and a tool never returned. */
function workSession(): ModelMessage[] {
  return [
    user("Quiero revisar el modulo de compactacion para que no pierda contexto", [image(1), image(2)]),
    assistant("Reviso los archivos", [{ callId: "r1", name: "read", args: { path: "packages/engine-native/src/engine.ts" } }]),
    result("r1", "read", "export function createNativeEngine() {}"),
    assistant("Plan", [{ callId: "t1", name: "todo", args: { items: [{ text: "port the sectioned template", status: "done" }, { text: "prove resume with fixtures", status: "in_progress", priority: "high" }, { text: "update docs", status: "pending" }] } }]),
    result("t1", "todo", "[x] port the sectioned template"),
    user(LATEST),
    assistant("Corro las pruebas", [{ callId: "s1", name: "shell", args: { command: "bun test packages/engine-native" } }, { callId: "k1", name: "task", args: { description: "audit prompts", subagent_type: "explore" } }]),
    result("s1", "shell", "3 fail\nerror: expected summary to keep CODEWORD-ZEBRA-42", true),
    result("k1", "task", "task_id: child-7\n<task_result>\nfound two stale prompts in prompts/continuation.md\n</task_result>"),
    assistant("Sigo con la tercera falla", [{ callId: "s2", name: "shell", args: { command: "bun test --watch" } }]),
  ]
}

function fixture(config: CompactionConfig = {}, options: { reply?: (call: number) => string; limits?: { contextWindow?: number; inputLimit?: number }; transcript?: (input: { sessionId: string; generation: number; markdown: string }) => Promise<string | undefined> } = {}) {
  const history = memoryHistory()
  const requests: ModelRequest[] = []
  const events: EngineEvent[] = []
  const provider: ModelProvider = {
    id: "local",
    model: "model",
    async *stream(request) {
      const { signal, turnSignal: _turnSignal, transformBody, ...copy } = request
      requests.push({ ...structuredClone(copy), signal })
      yield { type: "text", delta: options.reply?.(requests.length) ?? STRUCTURED }
      yield { type: "finish", reason: "stop" }
    },
    ...(options.limits ? { compactionLimits: () => options.limits! } : {}),
  }
  const sessionId = ids("session")
  const input: TurnInput = { sessionId, turnId: ids("turn"), signal: new AbortController().signal, text: "seguimos", attachments: [], permissionMode: () => "ask", setPermissionMode: () => {}, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "deny" }) }
  const engine = createNativeEngine({ provider, tools: [], history, cwdFor: () => "/local", system: () => "system", compactionPrompt: "BASE-PROMPT", compaction: () => config, ...(options.transcript ? { transcript: options.transcript } : {}) })
  return { history, requests, events, sessionId, input, engine }
}

const summaryOf = async (h: ReturnType<typeof fixture>) => (await h.history.load(h.sessionId))![0]!
const promptOf = (h: ReturnType<typeof fixture>, index = 0) => (h.requests[index]!.messages.at(-1) as { content: string }).content

test("the shipped prompt is the sectioned template with every required heading", async () => {
  const prompt = await loadCompactionPrompt()
  for (const heading of REQUIRED_SUMMARY_HEADINGS) expect(prompt).toContain(heading)
  expect(prompt).toContain("Resume Anchor")
  expect(prompt).toContain("Never request, simulate, print or narrate tool calls")
})

test("the summarizer is shown the latest request, constraints, active work, tool state and the earlier summary", async () => {
  const h = fixture({}, { transcript: async () => "/data/session-transcripts/s-g1.md" })
  await h.history.save(h.sessionId, workSession())
  await h.engine.compact(h.input)
  const prompt = promptOf(h)
  expect(prompt).toContain("BASE-PROMPT")
  expect(prompt).toContain("Create a new anchored summary")
  expect(prompt).toContain("Latest Real User Request Evidence")
  expect(prompt).toContain(LATEST)
  expect(prompt).toContain("Latest real user language hint: Spanish")
  expect(prompt).toContain("2. [in_progress] (high) prove resume with fixtures")
  expect(prompt).toContain("3. [pending] update docs")
  expect(prompt).toContain("toolStatuses: shell:pending")
  expect(prompt).toContain("not final")
  expect(prompt).toContain("CODEWORD-ZEBRA-42")
  expect(prompt).toContain("command=\"bun test --watch\"")
  expect(prompt).toContain("audit prompts (explore)")
  expect(prompt).toContain("task_id: child-7")
  expect(prompt).toContain("found two stale prompts")
  expect(prompt).toContain("Image Attachment Context")
  expect(prompt).toContain("shot-2.png")
  expect(prompt).toContain("markdown: /data/session-transcripts/s-g1.md")
  expect(prompt).toContain("reason: manual")
  const second = fixture()
  await second.history.save(second.sessionId, workSession())
  await second.engine.compact(second.input)
  await second.engine.runTurn(second.input)
  await second.engine.compact(second.input)
  expect(promptOf(second, 2)).toContain("Update the anchored summary at the start of the conversation above")
  expect(second.requests[2]!.messages[0]).toMatchObject({ content: expect.stringContaining(SUMMARY_PREFIX) })
})

test("a lossy summary cannot lose the latest request, its constraints or open work: the engine anchors them", async () => {
  const h = fixture({ tail_turns: 0 }, { reply: () => "## Goal\n- improve things" })
  await h.history.save(h.sessionId, workSession())
  expect(await h.engine.compact(h.input)).toMatchObject({ status: "ok", compacted: true })
  const saved = (await h.history.load(h.sessionId))!
  expect(saved).toHaveLength(1)
  const content = saved[0]!.role === "user" ? saved[0]!.content : ""
  expect(content.startsWith(SUMMARY_PREFIX)).toBe(true)
  expect(content).toContain("improve things")
  expect(content).toContain(ENGINE_ANCHOR_HEADING)
  expect(content).toContain(LATEST)
  expect(content).toContain("[in_progress] prove resume with fixtures")
  expect(content).toContain("[pending] update docs")
  expect(content).not.toContain("port the sectioned template")
  expect(content).toContain(RESUME_HEADING)
  expect(content).toContain("Compaction is a pause, not a cancellation")
  await h.engine.runTurn(h.input)
  const next = h.requests.at(-1)!
  expect(next.messages[0]).toMatchObject({ role: "user", content: expect.stringContaining(LATEST) })
  expect(next.messages.at(-1)).toMatchObject({ role: "user", content: "seguimos" })
})

test("when the tail already carries the latest request it is not duplicated, and the tail stays verbatim", async () => {
  const h = fixture({ tail_turns: 1 })
  const session = workSession()
  await h.history.save(h.sessionId, session)
  await h.engine.compact(h.input)
  const saved = (await h.history.load(h.sessionId))!
  // The call that never returned is closed with a cancelled result so strict providers accept the replay.
  expect(saved.slice(1, -1)).toEqual(session.slice(5))
  expect(saved.at(-1)).toMatchObject({ role: "tool", callId: "s2", output: "cancelled", isError: true })
  const content = saved[0]!.role === "user" ? saved[0]!.content : ""
  expect(content).not.toContain("Latest real user request (verbatim)")
  expect(content).toContain("Open TODOs at compaction")
  expect(content).toContain(RESUME_HEADING)
  expect(checkpointOf(saved)).toMatchObject({ generation: 1, method: "legacy" })
})

test("repeated compaction keeps one cumulative summary: no stacked anchors or resume guidance", async () => {
  const h = fixture({ tail_turns: 0 })
  await h.history.save(h.sessionId, workSession())
  await h.engine.compact(h.input)
  await h.engine.runTurn(h.input)
  await h.engine.compact(h.input)
  const content = (await summaryOf(h)).role === "user" ? ((await summaryOf(h)) as { content: string }).content : ""
  expect(content.split(RESUME_HEADING)).toHaveLength(2)
  expect(content.split(ENGINE_ANCHOR_HEADING)).toHaveLength(2)
  expect(content).toContain("seguimos")
  expect(checkpointOf((await h.history.load(h.sessionId))!)).toMatchObject({ generation: 2 })
  expect(summaryBody(content)).not.toContain(RESUME_HEADING)
  expect(summaryBody(content)).not.toContain(ENGINE_ANCHOR_HEADING)
  expect(summaryBody(content).startsWith("##")).toBe(true)
})

test("a summarizer that prints tool calls is replaced by a local rescue summary built from the evidence", async () => {
  const h = fixture({ tail_turns: 0 }, { reply: () => "## Goal\nto=functions.shell\n{\"recipient_name\":\"functions.shell\",\"parameters\":{\"command\":\"rm -rf /\"}}" })
  await h.history.save(h.sessionId, workSession())
  expect(await h.engine.compact(h.input)).toMatchObject({ compacted: true })
  const content = ((await summaryOf(h)) as { content: string }).content
  expect(content).not.toContain("recipient_name")
  expect(content).not.toContain("rm -rf")
  expect(content).toContain("## Preserved Context Evidence")
  expect(content).toContain("the summarizer printed tool calls")
  expect(content).toContain(LATEST)
  expect(content).toContain("in_progress")
  for (const heading of REQUIRED_SUMMARY_HEADINGS) expect(content).toContain(heading)
})

test("an oversized summarization prompt is rescued locally without a provider call", async () => {
  const h = fixture({ tail_turns: 0 }, { limits: { contextWindow: 300 } })
  const big = [...workSession(), result("pad", "read", "x".repeat(6_000))]
  await h.history.save(h.sessionId, big)
  expect(await h.engine.compact(h.input)).toMatchObject({ compacted: true })
  expect(h.requests).toHaveLength(0)
  const content = ((await summaryOf(h)) as { content: string }).content
  expect(content).toContain("exceeds the model's 300-token input window")
  expect(content).toContain(LATEST)
  expect(h.events.find((event) => event.type === "item.started")).toMatchObject({ kind: "compaction", meta: { summaryFallback: "rescue" } })
  expect(h.events.find((event) => event.type === "item.completed")).toMatchObject({ status: "ok" })
})

test("an empty reply installs nothing and a failing transcript store never blocks compaction", async () => {
  const empty = fixture({}, { reply: () => "  " })
  await empty.history.save(empty.sessionId, workSession())
  expect(await empty.engine.compact(empty.input)).toEqual({ status: "ok" })
  expect(await empty.history.load(empty.sessionId)).toEqual(workSession())
  const failing = fixture({}, { transcript: async () => { throw new Error("disk full") } })
  await failing.history.save(failing.sessionId, workSession())
  expect(await failing.engine.compact(failing.input)).toMatchObject({ compacted: true })
  expect(promptOf(failing)).not.toContain("Full Transcript Reference")
})

test("the transcript file text is redacted, bounded and holds the exact commands and outputs", async () => {
  const written: string[] = []
  const h = fixture({}, { transcript: async ({ markdown }) => { written.push(markdown); return "/data/t.md" } })
  const session = workSession()
  session[1] = assistant("Uso la clave AKIAABCDEFGHIJKLMNOP", [{ callId: "r1", name: "read", args: { path: "a.ts" } }])
  await h.history.save(h.sessionId, session)
  await h.engine.compact(h.input)
  expect(written).toHaveLength(1)
  expect(written[0]).toContain("bun test --watch")
  expect(written[0]).toContain("CODEWORD-ZEBRA-42")
  expect(written[0]).toContain(LATEST)
  expect(written[0]).not.toContain("AKIAABCDEFGHIJKLMNOP")
  expect(renderTranscript([user("x".repeat(5_000_000))], { sessionId: "s", generation: 1 }).length).toBeLessThan(4 * 1024 * 1024 + 200)
})

test("images of compacted turns return with the summary, newest ten, none already in the tail", async () => {
  const h = fixture({ tail_turns: 1 })
  const first = Array.from({ length: 12 }, (_, i) => image(i + 1))
  const tailImage = image(99)
  const session: ModelMessage[] = [user("old screenshots", first), assistant("seen"), user(LATEST, [tailImage, first[11]!]), assistant("ok")]
  await h.history.save(h.sessionId, session)
  await h.engine.compact(h.input)
  const saved = (await h.history.load(h.sessionId))!
  const attachments = saved[0]!.role === "user" ? saved[0]!.attachments : undefined
  expect(attachments).toHaveLength(RESUME_IMAGE_MAX_ITEMS)
  expect(attachments!.map((ref) => ref.name)).toEqual(first.slice(1, 11).map((ref) => ref.name))
  expect(saved[1]).toEqual(session[2])
  expect(resumeImageRefs(session.slice(0, 2), session.slice(2))).toHaveLength(10)
  expect(resumeImageRefs([user("a", [image(1, 15 * 1024 * 1024), image(2, 15 * 1024 * 1024)])], [])).toHaveLength(1)
  expect(imageAttachmentContext(session)[0]).toContain("sha256")
})

test("language, TODO, anchor and rescue helpers read what the history holds", () => {
  const session = workSession()
  expect(latestUserLanguage(session)).toBe("Spanish")
  expect(latestUserLanguage([user("please fix the build and finish this when you can")])).toBe("English")
  expect(latestUserLanguage([user("ok")])).toContain("dominant language")
  expect(currentTodos(session)).toHaveLength(3)
  expect(currentTodos([...session, assistant("", [{ callId: "t2", name: "todo", args: { items: [] } }])])).toEqual([])
  expect(engineAnchor({ messages: [user("only")], tail: [user("only")] })).toBe("")
  expect(localRescueSummary({ context: [], reason: "r" })).toContain("Previous Summary:\n(none)")
})

test("summary acceptance trims prefaces, rejects tool-call cosplay and keeps other formats", () => {
  expect(acceptSummary("   ")).toEqual({ rejected: "empty" })
  expect(acceptSummary("to=functions.shell {}")).toEqual({ rejected: "tool-call-cosplay" })
  expect(acceptSummary(`Sure, here it is:\n${STRUCTURED}`)).toEqual({ text: STRUCTURED, structured: true })
  expect(acceptSummary("custom format summary")).toEqual({ text: "custom format summary", structured: false })
})
