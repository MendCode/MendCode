import { expect, test } from "bun:test"
import type { EnginePort, TurnInput } from "@mendcode/kernel"
import type { SessionId } from "@mendcode/protocol"
import { createRunLimitsStore, type RunLimits } from "../src/run-limits"
import { limitsTools, withRunLimitGuard } from "../src/run-limit-guard"

const session = "ses_01M7C3T9P0JHRKM1" as SessionId

function guarded(limits: RunLimits | undefined, engine: string | undefined) {
  const ran: string[] = []
  const base = { runTurn: async (turn: TurnInput) => (ran.push(turn.sessionId), { status: "ok" as const }), compact: async () => ({ status: "ok" as const }), needsCompaction: () => false } as unknown as EnginePort
  const port = withRunLimitGuard({ base, limits: () => limits, route: () => ({ model: engine ? "claude/claude-sonnet" : "chatgpt/gpt-6-luna", engine }) })
  return { ran, run: () => port.runTurn({ sessionId: session } as TurnInput) }
}

test("a run limited to some tools fails on an engine that would ignore them, before anything runs", async () => {
  const claude = guarded({ tools: ["mcp__kst-studio__kst_read_project"], requestedTools: true }, "Claude Code")
  const outcome = await claude.run()
  expect(outcome).toMatchObject({ status: "error", code: "run_limits_unenforced" })
  expect(outcome.status === "error" && outcome.message).toContain("claude/claude-sonnet runs on Claude Code, which would ignore them")
  expect(claude.ran).toEqual([])
  for (const limits of [{ excludeTools: ["web_search"], requestedTools: true }, { offline: true, requestedTools: true }]) expect(await guarded(limits, "Codex").run()).toMatchObject({ code: "run_limits_unenforced" })
})

test("MendCode's own models, runs without tool limits and the daemon's own limited sessions run as before", async () => {
  const native = guarded({ tools: ["read"], requestedTools: true }, undefined)
  expect(await native.run()).toEqual({ status: "ok" })
  expect(native.ran).toEqual([session])
  expect(await guarded({ maxSteps: 3 }, "Claude Code").run()).toEqual({ status: "ok" })
  // A PR review child and a bare sub-agent carry exclusions the daemon set itself: they keep running on Claude Code.
  expect(await guarded({ excludeTools: ["skill"], noHooks: true }, "Claude Code").run()).toEqual({ status: "ok" })
})

test("limitsTools names exactly the limits a scripted run sets on tools", () => {
  const store = createRunLimitsStore()
  expect(limitsTools(store.configure(session, { maxSteps: 2, addDirs: ["/tmp"] }))).toBe(false)
  expect(limitsTools(store.configure(session, { tools: [] }))).toBe(true)
  expect(limitsTools({ offline: true })).toBe(true)
  expect(limitsTools({ excludeTools: [] })).toBe(false)
})
