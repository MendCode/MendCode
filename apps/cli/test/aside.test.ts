import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { renderAsideCard } from "../src/view/aside-card"
import { sideChatRows, type SideChatState } from "../src/ui/app/aside"
import { createEditor } from "../src/view/editor"

const ids = createIdFactory()
const plain = (line: Line) => line.map((span) => span.text).join("")

function harness(reply: (command: Record<string, unknown>) => unknown | Promise<unknown>) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 110, height: 32 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: "/work/app",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => 1_800_000_000_000,
    random: () => 0,
    mode: "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      return (await reply(command)) ?? { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain).join("\n")
  const key = async (value: string) => {
    await app.onKey(value)
    await Bun.sleep(5)
    app.render()
  }
  return { app, sent, text, key }
}

describe("/btw", () => {
  test("asks the daemon on the side, keeps the answer in the side panel when esc returns focus", async () => {
    let answer!: (value: unknown) => void
    const { app, sent, text, key } = harness((command) => (command.type === "session.aside" ? new Promise((resolve) => (answer = resolve)) : undefined))
    await app.onInput("/btw which port does the dev server use?")
    await key("\r")
    expect(sent.find((command) => command.type === "session.aside")).toMatchObject({ text: "which port does the dev server use?" })
    expect(text()).toContain("btw")
    expect(text()).toContain("which port does the dev server use?")
    expect(text()).toContain("thinking…")
    answer({ ok: true, result: { text: "Port 3000, from vite.config.ts." } })
    await Bun.sleep(5)
    app.render()
    expect(text()).toContain("Port 3000, from vite.config.ts.")
    expect(text()).not.toContain("not saved in the session")
    expect(sent.some((command) => command.type === "user.submit")).toBe(false)
    await key("\x1b")
    expect(text()).toContain("Port 3000")
    await key("\x1b]")
    expect(text()).not.toContain("Port 3000")
    await app.onInput("/btw")
    await key("\r")
    expect(text()).toContain("Port 3000")
  })

  test("typing goes on in the prompt under the card", async () => {
    const { app, text, key } = harness((command) => (command.type === "session.aside" ? { ok: true, result: { text: "yes" } } : undefined))
    await app.onInput("/btw ok?")
    await key("\r")
    await app.onInput("next message")
    app.render()
    expect(text()).toContain("next message")
    expect(text()).toContain("yes")
  })

  test("an error shows in the card; an empty question toggles the panel", async () => {
    const failing = harness((command) => (command.type === "session.aside" ? { ok: false, error: { code: "internal", message: "[DAEMON]: side questions need the native engine" } } : undefined))
    await failing.app.onInput("/btw hi")
    await failing.key("\r")
    expect(failing.text()).toMatch(/side questions need the native\s*│?\s*\n[^\n]*engine/)
    const empty = harness(() => undefined)
    await empty.app.onInput("/btw")
    await empty.key("\r")
    expect(empty.sent.some((command) => command.type === "session.aside")).toBe(false)
    expect(empty.text()).toContain("Ask something about this session")
  })
})

describe("aside card", () => {
  const long = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")

  test("sits above the prompt, stays in its box, and scrolls a long answer", () => {
    const card = renderAsideCard({ aside: { question: "q", answer: long, scroll: 0 }, width: 120, bottom: 20 })!
    expect(card.top + card.rows.length).toBe(20)
    for (const row of card.rows) expect(Bun.stringWidth(plain(row))).toBe(100)
    expect(card.rows.map(plain).join("\n")).toContain("↓")
    const scrolled = renderAsideCard({ aside: { question: "q", answer: long, scroll: 99 }, width: 120, bottom: 20 })!
    const shown = scrolled.rows.map(plain).join("\n")
    expect(shown).toContain("line 40")
    expect(shown).toContain("above")
  })

  test("no card when the screen is too small", () => {
    expect(renderAsideCard({ aside: { question: "q", scroll: 0 }, width: 20, bottom: 20 })).toBeUndefined()
    expect(renderAsideCard({ aside: { question: "q", scroll: 0 }, width: 120, bottom: 3 })).toBeUndefined()
  })
})

describe("side chat panel", () => {
  const state = (thread: SideChatState["thread"], extra: Partial<SideChatState> = {}): SideChatState => ({ thread, view: "chat", history: [], pick: 0, open: true, focused: false, editor: createEditor(), draft: "", scroll: 0, loaded: true, serial: 0, ...extra })
  const text = (chat: SideChatState, width = 60) => sideChatRows(chat, width, 16, "btw", 1_800_000_000_000).map((line) => line.map((span) => span.text).join(""))
  const panel = (thread: SideChatState["thread"], width = 60) => text(state(thread), width)

  test("the tools an answer ran are the transcript's tool rows between the question and the answer, and the model follows the name", () => {
    const rows = panel({ model: "luna", busy: false, messages: [{ role: "user", text: "is main pushed?" }, { role: "tool", text: "shell: git status -sb", status: "ok", ms: 2400 }, { role: "tool", text: "read: src/a.ts", status: "error" }, { role: "assistant", text: "Yes, nothing ahead." }] })
    expect(rows.find((row) => row.includes("btw"))).toContain("btw · luna")
    const tool = rows.findIndex((row) => row.includes("git status -sb"))
    expect(rows[tool]).toContain("$ shell")
    expect(rows[tool]).toContain("2.4s")
    expect(rows[tool]).not.toContain("⎿")
    expect(rows.find((row) => row.includes("src/a.ts"))).toContain("✗ Read")
    expect(tool).toBeGreaterThan(rows.findIndex((row) => row.includes("is main pushed?")))
    expect(rows.findIndex((row) => row.includes("Yes, nothing ahead."))).toBeGreaterThan(tool + 1)
  })

  test("the second row says what the side chat sees: the share of the session, whether its start is cut, the prompt and its cached part", () => {
    expect(panel({ busy: false, messages: [] }).join("\n")).toContain("sees the session as of your question")
    expect(panel({ busy: false, messages: [], context: { seen: 18_400, cut: false, tokens: 12_400, cached: 9_900 } }, 70).join("\n")).toContain("saw 18.4K chars · 12.4K tok · 80% cached")
    expect(panel({ busy: false, messages: [], context: { seen: 18_400, cut: false, tokens: 12_400, cached: 9_900 } }, 38).join("\n")).toContain("saw 18.4K chars · 12.4K tok ")
    expect(panel({ busy: false, messages: [], context: { seen: 24_000, cut: true } }).join("\n")).toContain("saw the last 24K chars")
  })

  test("the earlier side chats are listed newest first, one opens read-only, and the live chat is not touched", () => {
    const history = [
      { at: 1_800_000_000_000 - 3 * 60_000, model: "luna", messages: [{ role: "user" as const, text: "why did it fail?" }, { role: "assistant" as const, text: "A missing import." }] },
      { at: 1_800_000_000_000 - 3 * 3_600_000, messages: [{ role: "user" as const, text: "which port?" }, { role: "assistant" as const, text: "3000." }] },
    ]
    const live = state({ busy: false, messages: [{ role: "user", text: "live question" }] }, { view: "list", history })
    const list = text(live).join("\n")
    expect(list).toContain("btw · history")
    expect(list.indexOf("3m ago · luna  why did it fail?")).toBeGreaterThan(-1)
    expect(list.indexOf("why did it fail?")).toBeLessThan(list.indexOf("which port?"))
    expect(list).not.toContain("live question")
    const entry = text({ ...live, view: "entry", pick: 1 }).join("\n")
    expect(entry).toContain("which port?")
    expect(entry).toContain("3000.")
    expect(entry).toContain("esc back")
    expect(text({ ...live, history: [] }).join("\n")).toContain("No earlier side chats")
  })

  test("while it answers, the row under the thread says what it does: a tool, a provider retry", () => {
    expect(panel({ busy: true, status: "Running shell…", messages: [{ role: "user", text: "q" }] }).join("\n")).toContain("• Running shell…")
    expect(panel({ busy: true, status: "Retrying (attempt 2): stream stalled", messages: [{ role: "user", text: "q" }] }).join("\n")).toContain("• Retrying (attempt 2): stream stalled")
    expect(panel({ busy: true, messages: [{ role: "user", text: "q" }] }).join("\n")).toContain("• thinking…")
  })
})
