import { expect, test } from "bun:test"
import { HTTP_WEB } from "../src/http-web"

type Fake = Record<string, any>
const sessionId = "ses_WEB1"
const base = { sessionId, at: 1 }
const events = [
  { ...base, seq: 1, type: "item.started", turnId: "trn_1", itemId: "itm_u", kind: "user_message" },
  { ...base, seq: 2, type: "item.completed", itemId: "itm_u", status: "ok", text: "fix it" },
  { ...base, seq: 3, type: "item.started", turnId: "trn_1", itemId: "itm_t", kind: "tool_call", meta: { tool: "Edit src/a.ts" } },
  { ...base, seq: 4, type: "item.started", turnId: "trn_1", itemId: "itm_c", kind: "tool_call", meta: { tool: "child step", parentItemId: "itm_t" } },
  { ...base, seq: 5, type: "item.completed", itemId: "itm_t", status: "ok", text: "" },
  { ...base, seq: 6, type: "item.started", turnId: "trn_1", itemId: "itm_b", kind: "tool_call", meta: { tool: "Bash bun test" } },
  { ...base, seq: 7, type: "server.request", requestId: "req_A", turnId: "trn_1", kind: "approval", title: "Run bun test", detail: "bun test", tool: "bash" },
  { ...base, seq: 8, type: "server.request", requestId: "req_Q", turnId: "trn_1", kind: "question", title: "Which branch?", detail: "", options: [{ label: "main" }, { label: "dev" }] },
]

function harness({ readOnly = false } = {}) {
  const elements = new Map<string, Fake>()
  const make = (): Fake => ({ value: "", textContent: "", disabled: true, hidden: false, dataset: {}, children: [] as Fake[], scrollTop: 0, scrollHeight: 0, replaceChildren() { this.children = [] }, append(item: Fake) { this.children.push(item) }, setAttribute() {}, removeAttribute() {} })
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id)! }
  const commands: Array<Record<string, any>> = []
  const encoder = new TextEncoder()
  const fetcher = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url === "/event" && body.hello) return Response.json({ directory: "/work", remote: { readOnly } })
    if (url === "/event") {
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        for (const event of events.slice(6)) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "event", body: event })}\n\n`))
        init.signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })))
      } })
      return new Response(stream)
    }
    commands.push(body)
    const results: Record<string, unknown> = {
      "session.list": { sessions: [{ sessionId, title: "First" }, { sessionId: "ses_WEB2", title: "Fork" }] },
      "session.events": { events: events.slice(0, 6) },
      "models.list": { selectable: true, models: [{ id: "m1", name: "Model One" }, { id: "m2", name: "Model Two" }], session: { model: "m2" } },
      "session.fork": { sessionId: "ses_WEB2" },
      "session.changes": { files: [{ path: "src/a.ts", additions: 2, deletions: 1, binary: false, diff: "@@ -1 +1 @@\n-a\n+b", truncated: false }] },
    }
    return Response.json(results[body.type] ?? {})
  }
  const script = HTTP_WEB.match(/<script>([\s\S]*)<\/script>/)![1]!
  new Function("document", "fetch", "crypto", script)({ getElementById: el, createElement: () => make() }, fetcher, crypto)
  return { el, commands }
}
const until = async (check: () => boolean) => { const end = Date.now() + 1000; while (!check()) { if (Date.now() > end) throw new Error("browser fake deadline"); await Bun.sleep(2) } }
const cards = (el: (id: string) => Fake) => el("requests").children as Fake[]
const button = (card: Fake, label: string) => (card.children as Fake[]).flatMap((child) => child.children ?? []).find((item: Fake) => item.textContent === label)!

test("browser client lists tool calls without sub-steps and resolves approvals and questions", async () => {
  const { el, commands } = harness()
  el("token").value = "full"
  await el("login").onsubmit({ preventDefault() {} })
  await until(() => cards(el).length === 2)
  expect(el("error").textContent).toBe("")
  expect(el("transcript").textContent).toBe("› fix it\n\n  ▸ Edit src/a.ts\n  ▸ Bash bun test …")
  expect(el("transcript").textContent).not.toContain("child step")
  const [approval, question] = cards(el)
  expect(approval!.children[0].textContent).toBe("Approval: Run bun test")
  await button(approval!, "Allow for session").onclick()
  await button(approval!, "Deny").onclick()
  const input = question!.children[1].children.find((item: Fake) => item.type === "text")
  input.value = "feature"
  await button(question!, "Answer").onclick()
  await button(question!, "dev").onclick()
  expect(commands.filter((command) => command.type === "request.resolve").map(({ requestId, decision }) => ({ requestId, decision }))).toEqual([
    { requestId: "req_A", decision: { kind: "approve", scope: "session" } },
    { requestId: "req_A", decision: { kind: "deny" } },
    { requestId: "req_Q", decision: { kind: "answer", text: "feature" } },
    { requestId: "req_Q", decision: { kind: "answer", text: "dev" } },
  ])
  await el("disconnect").onclick()
  expect(cards(el)).toHaveLength(0)
})

test("browser client drives model, rename, fork and changes through existing commands", async () => {
  const { el, commands } = harness()
  el("token").value = "full"
  await el("login").onsubmit({ preventDefault() {} })
  await until(() => el("model").children.length === 3)
  expect(el("model").value).toBe("m2")
  expect(el("model").disabled).toBe(false)
  el("model").value = "m1"
  await el("model").onchange()
  el("model").value = ""
  await el("model").onchange()
  expect(commands.filter((command) => command.type === "session.model.set").map((command) => command.choice)).toEqual([{ model: "m1" }, null])
  el("rename").value = "  Renamed  "
  await el("tools").onsubmit({ preventDefault() {} })
  expect(commands.find((command) => command.type === "session.rename")).toMatchObject({ sessionId, title: "Renamed" })
  expect(el("title").textContent).toBe("Renamed")
  await el("fork").onclick()
  expect(commands.find((command) => command.type === "session.fork")).toMatchObject({ sessionId, transcript: true })
  await until(() => el("title").textContent === "Fork")
  await el("changes").onclick()
  await until(() => el("diff").hidden === false)
  expect(el("files").children[0].textContent).toBe("src/a.ts +2 -1")
  await el("files").children[0].onclick()
  expect(el("patch").textContent).toContain("+b")
  await el("changes").onclick()
  expect(el("diff").hidden).toBe(true)
})

test("read-only browser peers can read but not answer, rename, fork or switch models", async () => {
  const { el, commands } = harness({ readOnly: true })
  el("token").value = "observer"
  await el("login").onsubmit({ preventDefault() {} })
  await until(() => cards(el).length === 2)
  expect(cards(el).every((card) => (card.children as Fake[]).flatMap((child) => child.children ?? []).every((item: Fake) => item.disabled === true))).toBe(true)
  await button(cards(el)[0]!, "Deny").onclick()
  for (const name of ["rename", "renameGo", "fork", "model"]) expect(el(name).disabled).toBe(true)
  el("rename").value = "x"
  await el("tools").onsubmit({ preventDefault() {} })
  await el("fork").onclick()
  expect(commands.some((command) => ["request.resolve", "session.rename", "session.fork"].includes(command.type))).toBe(false)
})
