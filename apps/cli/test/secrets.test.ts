import { describe, expect, test } from "bun:test"
import { createIdFactory, type SecretInfo, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { hasSecretMarker, maskedMarker, maskSecretMarkers, secretMarkers } from "../src/view/secret-markers"
import { createSecretsPageState, renderSecretsPage, secretsPageKey, secretsRevealed } from "../src/view/secrets-page"
import { createTranscript } from "../src/view/transcript"
import { textWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")
const VALUE = "sk-live-SUPER-SECRET-VALUE-a1b2"
const SECRETS: SecretInfo[] = [
  { n: 1, kind: "openai_key", tail: "a1b2", createdAt: NOW - 3_600_000 },
  { n: 2, kind: "password", tail: "zz99", createdAt: NOW - 60_000 },
]

describe("secret markers", () => {
  test("a marker with a known tail is drawn as ‹secret ··tail›; unknown ones stay as written", () => {
    const tails = new Map([[1, "a1b2"]])
    expect(maskSecretMarkers("use ‹secret:1› and ‹secret:2›", (n) => tails.get(n))).toBe("use ‹secret ··a1b2› and ‹secret:2›")
    expect(maskedMarker("a1b2")).toBe("‹secret ··a1b2›")
    expect(maskSecretMarkers("no markers here", () => "x")).toBe("no markers here")
    expect(maskSecretMarkers("‹secret:12› ‹secret:12›", () => "zz")).toBe("‹secret ··zz› ‹secret ··zz›")
    expect(hasSecretMarker("a ‹secret:3›")).toBe(true)
    expect(secretMarkers("‹secret:1› ‹secret:20› ‹secret:x›")).toEqual([1, 20])
  })

  test("the transcript draws markers in messages and tool titles with the tails and keeps the raw text", () => {
    const tails = new Map([[1, "a1b2"]])
    const t = createTranscript({ glyphs: glyphs({}), now: () => NOW, secretTail: (n) => tails.get(n) })
    const sessionId = ids("session")
    const turnId = ids("turn")
    const itemId = ids("item")
    const toolId = ids("item")
    let seq = 0
    const emit = (event: Record<string, unknown>) => t.apply({ sessionId, seq: ++seq, at: NOW, ...event } as SessionEvent)
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    emit({ type: "item.started", turnId, itemId, kind: "user_message" })
    emit({ type: "item.completed", itemId, status: "ok", text: "deploy with ‹secret:1› then ‹secret:2›" })
    emit({ type: "item.started", turnId, itemId: toolId, kind: "tool_call", meta: { tool: "shell: curl -H ‹secret:1›" } })
    emit({ type: "item.completed", itemId: toolId, status: "ok", text: "done" })
    const rows = t.viewport(100, 40).map((line) => line.text)
    expect(rows.some((row) => row.includes("deploy with ‹secret ··a1b2› then ‹secret:2›"))).toBe(true)
    expect(rows.some((row) => row.includes("curl -H ‹secret ··a1b2›"))).toBe(true)
    expect(rows.join("\n")).not.toContain("‹secret:1›")
    expect(t.blocks().find((block) => block.itemId === itemId)?.text).toBe("deploy with ‹secret:1› then ‹secret:2›")
    tails.set(2, "zz99")
    t.refresh()
    expect(t.viewport(100, 40).map((line) => line.text).some((row) => row.includes("‹secret ··a1b2› then ‹secret ··zz99›"))).toBe(true)
  })
})

describe("secrets page", () => {
  test("keys: select, reveal with enter (the action names the secret), x twice forgets, anything else cancels the confirm", () => {
    const start = createSecretsPageState()
    expect(secretsPageKey(start, "j", SECRETS).state.selected).toBe(1)
    expect(secretsPageKey(start, "k", SECRETS).state).toBe(start)
    expect(secretsPageKey(start, "\r", SECRETS).action).toEqual({ type: "reveal", n: 1 })
    expect(secretsPageKey(secretsPageKey(start, "j", SECRETS).state, "\r", SECRETS).action).toEqual({ type: "reveal", n: 2 })
    const asked = secretsPageKey(start, "x", SECRETS)
    expect(asked.state.confirm).toBe(1)
    expect(asked.action.type).toBe("none")
    expect(secretsPageKey(asked.state, "x", SECRETS).action).toEqual({ type: "forget", n: 1 })
    expect(secretsPageKey(asked.state, "j", SECRETS).state).toMatchObject({ selected: 1, confirm: null })
    expect(secretsPageKey(asked.state, "z", SECRETS).state.confirm).toBeNull()
    expect(secretsPageKey(start, "\x1b", SECRETS).action.type).toBe("close")
    expect(secretsPageKey(start, "q", SECRETS).action.type).toBe("close")
    expect(() => secretsPageKey(start, "\r", [])).not.toThrow()
  })

  test("the value is kept only while its row stays selected: moving, enter again and a late reply for another row all hide or ignore it", () => {
    const revealed = secretsRevealed(createSecretsPageState(), SECRETS, 1, VALUE)
    expect(revealed.revealed).toEqual({ n: 1, value: VALUE })
    expect(secretsPageKey(revealed, "j", SECRETS).state.revealed).toBeNull()
    expect(secretsPageKey(revealed, "\r", SECRETS)).toMatchObject({ state: { revealed: null }, action: { type: "none" } })
    expect(secretsRevealed(createSecretsPageState(), SECRETS, 2, VALUE).revealed).toBeNull()
  })

  test("rows list marker, kind, tail and time; the value shows only for the revealed row, cleaned of terminal escapes", () => {
    const render = (state = createSecretsPageState()) => renderSecretsPage({ secrets: SECRETS, state, width: 100, height: 20, now: NOW }).map(plain)
    const rows = render()
    expect(rows.find((row) => row.includes("‹secret:1›"))).toMatch(/‹secret:1›\s+openai_key\s+··a1b2\s+\S/)
    expect(rows.find((row) => row.includes("‹secret:2›"))).toMatch(/‹secret:2›\s+password\s+··zz99/)
    expect(rows.join("\n")).not.toContain(VALUE)
    expect(rows.some((row) => row.includes("2 secrets"))).toBe(true)
    const shown = render(secretsRevealed(createSecretsPageState(), SECRETS, 1, `${VALUE}\x1b[31m\x07`))
    expect(shown.join("\n")).toContain(VALUE)
    expect(shown.join("\n")).not.toMatch(/[\x1b\x07]/)
    const pem = render(secretsRevealed(createSecretsPageState(), SECRETS, 1, `-----BEGIN KEY-----\n${"A".repeat(400)}\n-----END KEY-----`))
    expect(pem.filter((row) => row.includes("AAAA")).length).toBeLessThanOrEqual(6)
    expect(pem.join("\n")).toContain("more rows")
    const confirming = render({ ...createSecretsPageState(), confirm: 1 })
    expect(confirming.some((row) => row.includes("press x again to forget ‹secret ··a1b2›"))).toBe(true)
    for (const line of renderSecretsPage({ secrets: SECRETS, state: createSecretsPageState(), width: 40, height: 12, now: NOW })) expect(textWidth(plain(line))).toBe(40)
    expect(renderSecretsPage({ secrets: [], state: createSecretsPageState(), width: 80, height: 12, now: NOW }).map(plain).join("\n")).toContain("no secrets in this session")
  })
})

describe("secrets in the app", () => {
  function harness(options: { secrets?: () => SecretInfo[]; reveal?: () => Promise<unknown> | unknown } = {}) {
    const frames: Line[][] = []
    const sent: Array<Record<string, unknown>> = []
    const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
    const sessionId = ids("session")
    const turnId = ids("turn")
    const app = createApp({
      sessionId,
      screen,
      directory: "/work/app",
      exit() {},
      schedule: (fn) => fn(),
      glyphs: glyphs({}),
      now: () => NOW,
      random: () => 0,
      mode: "balanced",
      send: (async (command: Record<string, unknown>) => {
        sent.push(command)
        if (command.type === "secrets.list") return { ok: true, result: { secrets: options.secrets?.() ?? SECRETS } }
        if (command.type === "secrets.reveal") return (await options.reveal?.()) ?? { ok: true, result: { value: VALUE } }
        return { ok: true }
      }) as never,
    })
    let seq = 0
    const ev = (patch: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: NOW, ...patch } as SessionEvent)
    const text = () => frames.at(-1)!.map(plain)
    const key = async (value: string) => {
      await app.onKey(value)
      await Bun.sleep(5)
    }
    const say = (message: string) => {
      const itemId = ids("item")
      ev({ type: "turn.started", turnId, queueId: ids("queue") })
      ev({ type: "item.started", turnId, itemId, kind: "user_message" })
      ev({ type: "item.completed", itemId, status: "ok", text: message })
    }
    const open = async () => {
      await app.onInput("/secrets")
      await key("\r")
      await Bun.sleep(5)
    }
    const everything = () => frames.flat().map((line) => plain(line)).join("\n")
    return { app, sent, ev, text, key, say, open, frames, sessionId, everything }
  }

  test("a message with markers asks secrets.list once and the transcript shows the tails", async () => {
    const h = harness()
    h.say("call the API with ‹secret:1› and ‹secret:2›")
    await Bun.sleep(10)
    expect(h.sent.filter((command) => command.type === "secrets.list")).toEqual([{ type: "secrets.list", sessionId: h.sessionId }])
    h.app.render()
    const rows = h.text()
    expect(rows.some((row) => row.includes("call the API with ‹secret ··a1b2› and ‹secret ··zz99›"))).toBe(true)
    h.say("again ‹secret:1›")
    await Bun.sleep(10)
    expect(h.sent.filter((command) => command.type === "secrets.list")).toHaveLength(1)
  })

  test("text without a marker never asks", async () => {
    const h = harness()
    h.say("plain message")
    await Bun.sleep(5)
    expect(h.sent.some((command) => command.type === "secrets.list")).toBe(false)
  })

  test("/secrets lists the session's secrets; enter reveals the focused one and moving hides it", async () => {
    const h = await (async () => {
      const made = harness()
      await made.open()
      return made
    })()
    expect(h.app.page).toBe("secrets")
    expect(h.sent).toContainEqual({ type: "secrets.list", sessionId: h.sessionId })
    let rows = h.text()
    expect(rows.find((row) => row.includes("‹secret:1›"))).toMatch(/openai_key\s+··a1b2/)
    expect(rows.find((row) => row.includes("‹secret:2›"))).toMatch(/password\s+··zz99/)
    await h.key("\r")
    expect(h.sent.at(-1)).toEqual({ type: "secrets.reveal", sessionId: h.sessionId, n: 1 })
    rows = h.text()
    expect(rows.some((row) => row.includes(VALUE))).toBe(true)
    await h.key("j")
    expect(h.text().join("\n")).not.toContain(VALUE)
    await h.key("k")
    expect(h.text().join("\n")).not.toContain(VALUE)
  })

  test("the value is never on screen after leaving, nor after coming back, and never reaches a command or a toast", async () => {
    const h = harness()
    await h.open()
    await h.key("\r")
    const during = h.frames.length
    expect(h.frames.slice(0, during).map((rows) => rows.map(plain).join("\n")).some((frame) => frame.includes(VALUE))).toBe(true)
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
    const afterLeaving = h.frames.length
    for (const frame of h.frames.slice(afterLeaving - 1)) expect(frame.map(plain).join("\n")).not.toContain(VALUE)
    await h.open()
    await Bun.sleep(5)
    for (const frame of h.frames.slice(afterLeaving)) expect(frame.map(plain).join("\n")).not.toContain(VALUE)
    expect(JSON.stringify(h.sent)).not.toContain(VALUE)
  })

  test("q leaves like esc, and the page opened again starts hidden", async () => {
    const h = harness()
    await h.open()
    await h.key("\r")
    expect(h.text().join("\n")).toContain(VALUE)
    await h.key("q")
    expect(h.app.page).toBe("chat")
    const afterLeaving = h.frames.length
    await h.open()
    expect(h.app.page).toBe("secrets")
    for (const frame of h.frames.slice(afterLeaving)) expect(frame.map(plain).join("\n")).not.toContain(VALUE)
    expect(h.text().some((row) => row.includes("enter reveals the value on screen only"))).toBe(true)
  })

  test("a reveal that answers after the page was left never shows", async () => {
    let release: (reply: unknown) => void = () => {}
    const slow = new Promise((resolve) => (release = resolve))
    const h = harness({ reveal: () => slow })
    await h.open()
    await h.key("\r")
    await h.key("\x1b")
    release({ ok: true, result: { value: VALUE } })
    await Bun.sleep(10)
    h.app.render()
    expect(h.everything()).not.toContain(VALUE)
  })

  test("a failed reveal says so without the daemon's message and shows nothing", async () => {
    const h = harness({ reveal: () => ({ ok: false, error: { code: "internal", message: `[SECRETS]: could not read ${VALUE}` } }) })
    await h.open()
    await h.key("\r")
    h.app.render()
    expect(h.text().some((row) => row.includes("could not reveal the secret"))).toBe(true)
    expect(h.everything()).not.toContain(VALUE)
  })

  test("x twice forgets the focused secret, reloads the list, and its marker stops resolving in the transcript", async () => {
    let list = [...SECRETS]
    const h = harness({ secrets: () => list })
    h.say("use ‹secret:1›")
    await Bun.sleep(10)
    await h.open()
    await h.key("x")
    expect(h.text().some((row) => row.includes("press x again to forget"))).toBe(true)
    expect(h.sent.some((command) => command.type === "secrets.forget")).toBe(false)
    list = list.filter((secret) => secret.n !== 1)
    await h.key("x")
    expect(h.sent).toContainEqual({ type: "secrets.forget", sessionId: h.sessionId, n: 1 })
    expect(h.sent.filter((command) => command.type === "secrets.list").length).toBeGreaterThanOrEqual(3)
    const rows = h.text()
    expect(rows.join("\n")).not.toMatch(/‹secret:1›\s+openai_key/)
    expect(rows.some((row) => /‹secret:2›\s+password/.test(row))).toBe(true)
    expect(rows.some((row) => row.includes("1 secret") && !row.includes("2 secrets"))).toBe(true)
    await h.key("\x1b")
    h.app.render()
    expect(h.text().some((row) => row.includes("use ‹secret:1›"))).toBe(true)
  })

  test("the approval panel shows tails too", async () => {
    const h = harness()
    const turnId = ids("turn")
    h.ev({ type: "turn.started", turnId, queueId: ids("queue") })
    h.ev({ type: "server.request", requestId: ids("request"), turnId, kind: "approval", title: "Run command", detail: "curl -H ‹secret:1› https://x" })
    await Bun.sleep(10)
    h.app.render()
    expect(h.text().some((row) => row.includes("curl -H ‹secret ··a1b2› https://x"))).toBe(true)
  })
})
