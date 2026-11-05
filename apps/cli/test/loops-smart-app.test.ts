import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, type Loop } from "@mendcode/protocol"
import { createLoopsPageState, loopsPageKey, renderLoopsPage } from "../src/view/loops-page"
import { appHarness, scratch } from "./extensions-harness"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

const waitingLoop = (over: Partial<Loop> = {}): Loop => ({
  loopId: ids("loop"),
  name: "Avance sesion",
  directory: "/work/app",
  objective: "read the other repo",
  trigger: { kind: "interval", everyMs: 300_000 },
  budget: { mode: "monitor" },
  reportOnly: true,
  state: "needs_input",
  reason: "external directory access",
  waiting: { sessionId: ids("session"), requestId: "req_01ABC", kind: "approval", title: "external directory access", detail: "external_directory: /Users/x/other/*\n\nread /Users/x/other/a.txt", tool: "read", at: NOW - 120_000 },
  sessionId: ids("session"),
  runs: 1,
  history: [],
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  ...over,
})

async function open(options: { reply?: (command: Record<string, unknown>) => unknown; loops?: Loop[] } = {}) {
  const dirs = scratch()
  made.push(dirs)
  const h = await appHarness({
    dataDir: dirs.dataDir,
    width: 110,
    height: 40,
    reply: (command) => {
      const custom = options.reply?.(command)
      if (custom !== undefined) return custom
      if (command.type === "loop.list") return { ok: true, result: { loops: options.loops ?? [] } }
      return undefined
    },
  })
  await h.start({ onboarded: true })
  return h
}
const created = (h: Awaited<ReturnType<typeof open>>) => h.sent.filter((command) => command.type === "loop.create")

describe("/loop with a phrase asks for one line of confirmation (AE)", () => {
  test("cada 5 minutos ve diciéndome: the line names when, the permission and the work, and enter starts it", async () => {
    const h = await open({ reply: (command) => (command.type === "loop.create" ? { ok: true, result: { loop: waitingLoop({ state: "active" }) } } : undefined) })
    await h.type("/loop cada 5 minutos ve diciéndome")
    await h.key("\r")
    expect(created(h)).toHaveLength(0)
    expect(h.text()).toContain("loop: every 5m · ask · ve diciéndome")
    expect(h.text()).toContain("enter start · e edit")
    await h.key("\r")
    await Bun.sleep(15)
    expect(created(h)).toHaveLength(1)
    expect(created(h)[0]).toMatchObject({ type: "loop.create", name: "ve diciéndome", objective: "ve diciéndome", trigger: { kind: "interval", everyMs: 300_000 }, budget: { mode: "monitor" }, creatorSessionId: h.sessionId, permission: "ask" })
  })

  test("from a session in full access the line says full access, the loop is made with it, and a lower mode word lowers it", async () => {
    const h = await open({ reply: (command) => (command.type === "loop.create" ? { ok: true, result: { loop: waitingLoop({ state: "active" }) } } : undefined) })
    h.event({ type: "session.permission", mode: "full" })
    await h.type("/loop every five minutes tell me what changed")
    await h.key("\r")
    expect(h.text()).toContain("loop: every 5m · full access · tell me")
    await h.type("edits")
    await h.key("\r")
    expect(h.text()).toContain("loop: every 5m · edits · tell me what")
    await h.key("\r")
    await Bun.sleep(15)
    expect(created(h)[0]).toMatchObject({ permission: "edits", creatorSessionId: h.sessionId, trigger: { kind: "interval", everyMs: 300_000 } })
  })

  test("e puts the strict form back in the prompt to edit", async () => {
    const h = await open()
    await h.type("/loop todos los días a las 9 revisa los issues")
    await h.key("\r")
    expect(h.text()).toContain("loop: daily 09:00")
    await h.type("e")
    await h.key("\r")
    expect(created(h)).toHaveLength(0)
    expect(h.text()).toContain("/loop daily 09:00 revisa los issues")
  })

  test("a mode word lowers the loop's permission and the line says so", async () => {
    const h = await open()
    await h.key("\x1b[Z")
    await h.type("/loop every five minutes tell me what changed")
    await h.key("\r")
    expect(h.text()).toContain("loop: every 5m")
    // The session is in ask mode: nothing above it to choose, and a higher word is not an answer to the line.
    await h.type("full")
    await h.key("\r")
    expect(created(h)).toHaveLength(0)
  })

  test("without a schedule the loop is adaptive", async () => {
    const h = await open()
    await h.type("/loop ve diciéndome cuando termine la sesión")
    await h.key("\r")
    expect(h.text()).toContain("loop: adaptive 10m")
    await h.key("\r")
    await Bun.sleep(15)
    expect(created(h)[0]).toMatchObject({ trigger: { kind: "adaptive", everyMs: 600_000 } })
  })

  test("a schedule the local parser does not know goes to the small role once, and its answer is confirmed the same way", async () => {
    const h = await open({ reply: (command) => (command.type === "loop.interpret" ? { ok: true, result: { trigger: "every 3h", objective: "revisa facturas" } } : undefined) })
    await h.type("/loop cada tercer jueves revisa facturas")
    await h.key("\r")
    await Bun.sleep(15)
    h.app.render()
    expect(h.sent.filter((command) => command.type === "loop.interpret")).toEqual([expect.objectContaining({ text: "cada tercer jueves revisa facturas" })])
    expect(h.text()).toContain("loop: every 3h · ask · revisa")
    expect(h.text()).toContain("enter start · e edit")
    expect(created(h)).toHaveLength(0)
  })

  test("the strict form starts at once, without the small role and without a confirmation", async () => {
    const h = await open({ reply: (command) => (command.type === "loop.create" ? { ok: true, result: { loop: waitingLoop({ state: "active" }) } } : undefined) })
    await h.type("/loop every 30m check ci")
    await h.key("\r")
    await Bun.sleep(15)
    expect(created(h)).toHaveLength(1)
    expect(h.sent.some((command) => command.type === "loop.interpret")).toBe(false)
  })
})

describe("a loop waiting on a tool permission (AI)", () => {
  test("the footer says needs input", async () => {
    const waiting = waitingLoop()
    const h = await open({ loops: [waiting] })
    await h.app.onGlobal({ type: "loop.changed", loop: waiting } as never)
    h.app.render()
    expect(h.text()).toContain("1 loop · needs input")
  })

  test("/loops shows what the run asked for and a, o and x answer it in the loop's session", async () => {
    const waiting = waitingLoop()
    const h = await open({ loops: [waiting] })
    await h.type("/loops")
    await h.key("\r")
    await Bun.sleep(15)
    h.app.render()
    const screen = h.text()
    expect(screen).toContain("waiting on you")
    expect(screen).toContain("external directory access")
    expect(screen).toContain("a allow once")
    await h.key("a")
    await h.key("o")
    await h.key("x")
    const resolved = h.sent.filter((command) => command.type === "request.resolve")
    expect(resolved).toEqual([
      expect.objectContaining({ sessionId: waiting.waiting!.sessionId, requestId: "req_01ABC", decision: { kind: "approve", scope: "once" } }),
      expect.objectContaining({ decision: { kind: "approve", scope: "session" } }),
      expect.objectContaining({ decision: { kind: "deny" } }),
    ])
  })

  test("a loop that is not waiting ignores those keys, and a question is answered in its session", () => {
    const idle = waitingLoop({ state: "active", waiting: undefined })
    delete (idle as { waiting?: unknown }).waiting
    expect(loopsPageKey(createLoopsPageState(), "x", [idle]).action.type).toBe("none")
    const question = waitingLoop({ waiting: { ...waitingLoop().waiting!, kind: "question", title: "Which branch?" } })
    expect(loopsPageKey(createLoopsPageState(), "a", [question]).action.type).not.toBe("resolve")
    const rows = renderLoopsPage({ loops: [question], state: createLoopsPageState(), width: 120, height: 30, now: NOW }).map((line) => line.map((span) => span.text).join(""))
    expect(rows.join("\n")).toContain("enter opens its session to answer")
  })

  test("m lowers a full-access loop one step; a report-only loop has no mode to lower", () => {
    const full = waitingLoop({ state: "active", reportOnly: false, permission: "full" })
    expect(loopsPageKey(createLoopsPageState(), "m", [full]).action).toEqual({ type: "mode", loopId: full.loopId, permission: "edits" })
    const asking = waitingLoop({ state: "active", reportOnly: false, permission: "ask" })
    expect(loopsPageKey(createLoopsPageState(), "m", [asking]).action.type).toBe("none")
    const report = waitingLoop({ state: "active", reportOnly: true, permission: "full" })
    expect(loopsPageKey(createLoopsPageState(), "m", [report]).action.type).toBe("none")
  })
})
