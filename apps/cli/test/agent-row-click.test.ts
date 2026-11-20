import { afterEach, expect, test } from "bun:test"
import type { SessionEvent } from "@mendcode/protocol"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { psCard } from "../src/view/ps-card"
import { renderInfoCard } from "../src/view/rewind-card"

afterEach(cleanTemps)

const screen = (h: { text(): string[] }) => h.text().join("\n")

/** A Claude-harness session whose async agent's call sits far above the history the chat opens on, with a command beside it. */
async function longSession(shellName: string, callTitle: string) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
  const sessionId = ids("session")
  const log: SessionEvent[] = []
  const talk = conversation(sessionId, (event) => void log.push(event))
  talk.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_bg", kind: "tool_call", meta: { tool: `agent ${callTitle}`, subagent: true, agent: "general-purpose", background: false } })
  talk.emit({ type: "item.completed", turnId: "turn_1", itemId: "item_bg", status: "ok", text: "running in the background", meta: { tool: `agent ${callTitle}`, subagent: true, agent: "general-purpose", background: true } })
  talk.emit({ type: "item.started", turnId: "turn_1", itemId: "item_child", kind: "tool_call", meta: { tool: "read src/e2e.ts", agentParent: "item_bg" } })
  talk.emit({ type: "item.completed", turnId: "turn_1", itemId: "item_child", status: "ok", text: "ok", meta: { tool: "read src/e2e.ts" } })
  talk.emit({ type: "turn.completed", turnId: "turn_1" })
  // Far more than the 12 pages of 200 events a click used to read back.
  for (let n = 1; n <= 700; n++) talk.exchange(`question ${n}`, `answer ${n}`)
  const page = (events: SessionEvent[], more: boolean) => ({ ok: true as const, window: { events, firstSeq: events[0]!.seq, lastSeq: events.at(-1)!.seq, sessionLastSeq: log.at(-1)!.seq, more } })
  const h = appHarness({
    dataDir, sessionId, width: 110, height: 34,
    events: {
      loadWindow: async () => page(log.slice(-200), true),
      loadBefore: async (_id: string, before: number) => {
        const upTo = log.filter((event) => event.seq < before)
        const events = upTo.slice(-200)
        return page(events, upTo.length > events.length)
      },
    },
    reply: (command) => {
      if (command.type === "session.get") return { ok: true, result: { session: { sessionId: command.sessionId, directory: "/work" } } } as never
      if (command.type === "session.children") return { ok: true, result: { sessions: [] } } as never
      if (command.type === "task.list") return { ok: true, result: { tasks: [] } } as never
      if (command.type === "background.list") return { ok: true, result: { tasks: [
        { id: "engine:a1", sessionId, command: shellName, status: "running", kind: "agent", startedAt: Date.now() - 3_000_000 },
        { id: "engine:s1", sessionId, command: "Tests backend de integración sin cortar al primer fallo", status: "running", kind: "command", startedAt: Date.now() - 36_000 },
      ] } } as never
      return undefined
    },
  } as never)
  h.app.applySettings({ onboarded: true })
  await h.app.start()
  h.app.onGlobal({ type: "session.background.changed", gseq: 2, at: Date.now(), sessionId } as never)
  await Bun.sleep(5)
  h.app.render()
  return h
}

async function clickRow(h: Awaited<ReturnType<typeof longSession>>, pattern: RegExp) {
  const rows = h.text()
  const row = rows.findIndex((text) => pattern.test(text))
  expect(row).toBeGreaterThanOrEqual(0)
  const col = rows[row]!.search(pattern) + 4
  await h.type(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`)
  await Bun.sleep(200)
  h.app.render()
}

test("a click on a Claude async agent whose call is thousands of events back opens its thread, not the Background card", async () => {
  const h = await longSession("L5 E2E contra backend real", "L5 E2E contra backend real")
  await clickRow(h, /L5 E2E contra backend real\s+async/)
  expect(screen(h)).toContain("╭─ sub-agent ")
  expect(screen(h)).not.toMatch(/Background · /)
})

test("an agent named with different spacing than its call still opens its thread", async () => {
  const h = await longSession("L5  E2E contra\nbackend real", "L5 E2E contra backend real")
  await clickRow(h, /L5 E2E contra backend real\s+async/)
  expect(screen(h)).toContain("╭─ sub-agent ")
})

test("the Background card lists every row from the same cell, the marker in its own column", () => {
  const now = 10_000_000
  const items = [
    { id: "a", command: "L5 E2E contra backend real", kind: "agent" as const, startedAt: now - 3_000_000 },
    { id: "b", command: "Tests backend de integración sin cortar al primer fallo", kind: "command" as const, startedAt: now - 36_000 },
  ]
  for (const selected of [0, 1]) {
    const view = renderInfoCard({ card: psCard({ state: { selected }, items, now }), width: 110, bottom: 30 })!
    const rows = view.rows.map((row) => row.map((span) => span.text).join("")).filter((text) => /· (agent|command) ·/.test(text))
    expect(rows).toHaveLength(2)
    const body = rows.map((text) => text.slice(2))
    expect(body[selected]!.startsWith("› ")).toBe(true)
    expect(body[1 - selected]!.startsWith("  ")).toBe(true)
    expect(body[1 - selected]![2]).not.toBe(" ")
    expect(body[selected]![2]).not.toBe(" ")
  }
})
