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
  const panel = (thread: SideChatState["thread"], width = 60) => {
    const chat: SideChatState = { thread, open: true, focused: false, editor: createEditor(), draft: "", scroll: 0, loaded: true, serial: 0 }
    return sideChatRows(chat, width, 16).map((line) => line.map((span) => span.text).join(""))
  }

  test("the tools an answer ran are muted rows between the question and the answer, and the model follows the name", () => {
    const rows = panel({ model: "luna", busy: false, messages: [{ role: "user", text: "is main pushed?" }, { role: "tool", text: "shell: git status -sb" }, { role: "assistant", text: "Yes, nothing ahead." }] })
    expect(rows.find((row) => row.includes("btw"))).toContain("btw · luna")
    const tool = rows.findIndex((row) => row.includes("⎿ shell: git status -sb"))
    expect(tool).toBeGreaterThan(rows.findIndex((row) => row.includes("is main pushed?")))
    expect(rows.findIndex((row) => row.includes("Yes, nothing ahead."))).toBeGreaterThan(tool + 1)
  })

  test("while it answers, the row under the thread says what it does: a tool, a provider retry", () => {
    expect(panel({ busy: true, status: "Running shell…", messages: [{ role: "user", text: "q" }] }).join("\n")).toContain("• Running shell…")
    expect(panel({ busy: true, status: "Retrying (attempt 2): stream stalled", messages: [{ role: "user", text: "q" }] }).join("\n")).toContain("• Retrying (attempt 2): stream stalled")
    expect(panel({ busy: true, messages: [{ role: "user", text: "q" }] }).join("\n")).toContain("• thinking…")
  })
})
