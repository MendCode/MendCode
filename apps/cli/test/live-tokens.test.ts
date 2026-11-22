import { afterEach, expect, test } from "bun:test"
import { DEFAULT_THEME } from "../src/themes"
import { appHarness, cleanTemps, ids, plain, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { setTheme } from "../src/ui/theme"

afterEach(() => { cleanTemps(); setTheme(DEFAULT_THEME) })

const TURN_AT = 1_800_000_000_000
const rows = (h: Harness) => (h.app.render(), h.frames.at(-1)!.map(plain))
const activity = (h: Harness) => rows(h).find((line) => line.includes("Generating…")) ?? ""

test("an external engine's turn shows its output tokens on the activity line while it runs, from the live push, and the record takes over without counting twice", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, footerDefaultRows: false, sidebar: "hidden" })
  const h = appHarness({ dataDir, directory: tempDir(), width: 100, height: 30, mode: "full", now: () => TURN_AT + 22_000 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const turnId = ids("turn")
  h.app.onEvent({ type: "turn.started", sessionId: h.sessionId, seq: 900, at: TURN_AT, turnId, queueId: ids("queue") } as never)
  h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 901, at: TURN_AT + 500, state: "generating", turnId } as never)
  // Claude Code records nothing until its result: no figure yet.
  expect(activity(h)).toContain("Generating…")
  expect(activity(h)).not.toContain("tokens")
  const push = (output: number, session = h.sessionId, turn = turnId) => h.app.onGlobal({ type: "turn.tokens", gseq: 0, at: TURN_AT + 5_000, sessionId: session, turnId: turn, output } as never)
  push(120)
  expect(activity(h)).toContain("↓ 120 tokens")
  push(1_250)
  expect(activity(h)).toContain("↓ 1,250 tokens")
  // Another session's push, or another turn's, leaves this line alone.
  push(9_999, ids("session"))
  push(9_999, h.sessionId, ids("turn"))
  expect(activity(h)).toContain("↓ 1,250 tokens")
  // The result's record holds the figure; the line shows it once.
  h.app.onEvent({ type: "usage.recorded", sessionId: h.sessionId, seq: 902, at: TURN_AT + 21_000, turnId, provider: "claude", model: "claude-opus-4-8", input: 15, output: 1_470, reasoning: 0, cacheRead: 0, cacheWrite: 0 } as never)
  push(0)
  expect(activity(h)).toContain("↓ 1,470 tokens")
})

test("a turn that started before this terminal joined it shows how long it has run and its live tokens, from the session's live state", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, footerDefaultRows: false, sidebar: "hidden" })
  const h = appHarness({ dataDir, directory: tempDir(), width: 100, height: 30, mode: "full", now: () => TURN_AT + 5 * 60_000 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const turnId = ids("turn")
  // No turn.started: it is older than the events this terminal loaded.
  h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 901, at: TURN_AT + 60_000, state: "generating", turnId } as never)
  h.app.onGlobal({ type: "session.activity", gseq: 0, at: TURN_AT + 60_000, sessionId: h.sessionId, directory: "/d", title: "Long one", state: "generating", updatedAt: TURN_AT + 60_000, since: TURN_AT } as never)
  expect(activity(h)).toContain("5m")
  h.app.onGlobal({ type: "turn.tokens", gseq: 0, at: TURN_AT + 4 * 60_000, sessionId: h.sessionId, turnId, output: 2_000 } as never)
  expect(activity(h)).toContain("↓ 2,000 tokens")
  // The turn ends: the next turn's figures start from nothing.
  h.app.onEvent({ type: "turn.completed", sessionId: h.sessionId, seq: 902, at: TURN_AT + 5 * 60_000, turnId } as never)
  h.app.onGlobal({ type: "turn.tokens", gseq: 0, at: TURN_AT + 5 * 60_000, sessionId: h.sessionId, turnId, output: 3_000 } as never)
  expect(rows(h).join("\n")).not.toContain("3,000")
})
