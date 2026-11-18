import { expect, test } from "bun:test"
import type { BotListReport } from "@mendcode/protocol"
import { patchBotReport } from "../src/view/bot-live"

const NOW = 10_000_000
const MINUTE = 60_000
const identity = { shape: "circle", color: "success", origin: "mendcode" }
const report = (statuses: Array<[string, string, number]>) => ({
  bots: [{ name: "mendy", description: "", identity, file: "/d/mendy.md", state: "idle", schedules: [], projects: [{ directory: "/work", state: "idle", sessions: statuses.map(([sessionId, status, updatedAt]) => ({ sessionId, title: "t", status, updatedAt })) }] }],
  external: [],
  problems: [],
}) as unknown as BotListReport
const push = (sessionId: string, state: "error" | "idle", updatedAt: number) => ({ type: "session.activity", sessionId, directory: "/work", title: "t", state, updatedAt, gseq: 1, at: updatedAt }) as never

test("a chat that just failed puts its bot in problem, and a newer good turn clears it", () => {
  const failed = patchBotReport(report([["ses_a", "completed", NOW - 20 * MINUTE]]), push("ses_a", "error", NOW - MINUTE), NOW)!
  expect(failed.bots[0]!.state).toBe("problem")
  const recovered = patchBotReport(failed, push("ses_a", "idle", NOW), NOW)!
  expect(recovered.bots[0]!.state).toBe("idle")
})

test("a failure older than ten minutes no longer shows the bot as a problem", () => {
  const old = patchBotReport(report([["ses_a", "completed", NOW - 40 * MINUTE]]), push("ses_a", "error", NOW - 34 * MINUTE), NOW)!
  expect(old.bots[0]).toMatchObject({ state: "idle", projects: [{ state: "idle", sessions: [{ status: "failed" }] }] })
})

test("an external bot its app reports busy stays busy when one of its MendCode chats goes idle, and its chats' own work still shows", () => {
  const external = (appState: "working" | "idle") => ({
    bots: [],
    external: [{ origin: "hermes", id: "ada", name: "Ada", state: appState, appState, chat: "acp:hermes-ada", projects: [{ directory: "/work", state: "idle", sessions: [{ sessionId: "ses_x", title: "t", status: "completed", updatedAt: NOW - MINUTE }] }] }],
    problems: [],
  }) as unknown as BotListReport
  expect(patchBotReport(external("working"), push("ses_x", "idle", NOW), NOW)!.external[0]!.state).toBe("working")
  expect(patchBotReport(external("idle"), push("ses_x", "idle", NOW), NOW)!.external[0]!.state).toBe("idle")
  expect(patchBotReport(external("idle"), push("ses_x", "error", NOW), NOW)!.external[0]!.state).toBe("problem")
})

test("a chat at rest whose sub-agents still work keeps its bot working, and its last one ending lets the bot rest", () => {
  const working = patchBotReport(report([["ses_a", "completed", NOW - MINUTE]]), { ...push("ses_a", "idle", NOW), agents: 2 }, NOW)!
  expect(working.bots[0]).toMatchObject({ state: "working", projects: [{ state: "working", sessions: [{ status: "running" }] }] })
  expect(patchBotReport(working, push("ses_a", "idle", NOW), NOW)!.bots[0]!.state).toBe("idle")
})
