import { describe, expect, test } from "bun:test"
import type { BotListReport } from "@mendcode/protocol"
import { helpText, parseAutomation } from "../src/automation"
import { completionScript } from "../src/support-output"
import { catalogHarness } from "./catalog-harness"

const NOW = 100_000
const report: BotListReport = {
  bots: [{
    name: "reviewer", description: "Reviews diffs", identity: { origin: "mendcode" }, model: "chatgpt:gpt-6-luna", permission: "smart", file: "/data/agents/reviewer.md", state: "waiting",
    projects: [
      { directory: "/work/a", state: "waiting", sessions: [
        { sessionId: "ses_aaaaaaaa", title: "Old chat", status: "idle", updatedAt: NOW - 7_200_000 },
        { sessionId: "ses_bbbbbbbb", title: "Needs approval", status: "waiting_for_approval", updatedAt: NOW - 30_000 },
      ] },
      { directory: "/work/b", state: "working", sessions: [{ sessionId: "ses_cccccccc", title: "Fixing tests", status: "running", updatedAt: NOW - 5_000 }] },
    ],
    schedules: [{ loopId: "loop_1", name: "morning check", trigger: "daily 09:00", directory: "/work/a", state: "active", runs: 4, nextWakeAt: NOW + 3_600_000 }],
  }],
  external: [{ origin: "hermes", id: "default", name: "hermes-default", state: "idle", model: "kimi-k3", projects: [] }],
  problems: [{ file: "connector:hermes", message: "Hermes did not answer" }],
}

describe("bot CLI", () => {
  test("parses list (also bare and plural) and show, and refuses anything else before asking the daemon", () => {
    expect(parseAutomation(["bot", "list", "--json"])).toMatchObject({ ok: true, command: { kind: "agent.bots", json: true } })
    expect(parseAutomation(["bots"])).toMatchObject({ ok: true, command: { kind: "agent.bots" } })
    expect(parseAutomation(["bot", "show", "reviewer", "--dir", "/tmp/d"])).toMatchObject({ ok: true, command: { kind: "agent.bots", name: "reviewer", dir: "/tmp/d" } })
    for (const args of [["bot", "show"], ["bot", "show", "a", "b"], ["bot", "list", "extra"], ["bot", "delete", "x"], ["bot", "list", "--model", "a/b"], ["bot", "show", "a\u0007"], ["bot", "show", "x".repeat(101)]]) expect(parseAutomation(args).ok).toBe(false)
    expect(parseAutomation(["bot", "show", "Adrián"])).toMatchObject({ ok: true, command: { name: "Adrián" } })
    expect(parseAutomation(["bot", "--help"])).toMatchObject({ command: { kind: "help", topic: "bot" } })
    expect(helpText("bot")).toContain("show NAME")
    expect(completionScript("bash")).toContain("bot) words='list show'")
  })

  test("list prints each bot's state, chats, running and waiting counts, schedules and the connector problems", async () => {
    const h = catalogHarness({ send: () => ({ ok: true, result: report }) })
    expect(await h.run(["bot", "list"])).toBe(0)
    expect(h.sent).toEqual([{ type: "bot.list" }])
    const text = h.out.join("")
    expect(text).toContain("reviewer        waiting for you  3 chats in 2 folders · 1 running · 1 waiting for you · last 5s ago · chatgpt:gpt-6-luna · 1 schedule")
    expect(text).toContain("hermes-default  idle             0 chats · kimi-k3 · from hermes")
    expect(text).toContain("problem: connector:hermes: Hermes did not answer")
  })

  test("show lists one bot's chats per folder newest first, with ids to attach, and its schedules; --json carries the same", async () => {
    const h = catalogHarness({ send: () => ({ ok: true, result: report }) })
    expect(await h.run(["bot", "show", "Reviewer"])).toBe(0)
    const lines = h.out.join("").split("\n")
    expect(lines[0]).toBe("reviewer  waiting for you · chatgpt:gpt-6-luna · permission smart")
    const a = lines.findIndex((line) => line.startsWith("/work/a"))
    expect(lines[a]).toBe("/work/a  waiting for you · 2 chats")
    expect(lines[a + 1]).toContain("waiting_for_approval")
    expect(lines[a + 1]).toContain("ses_bbbbbbbb  Needs approval")
    expect(lines[a + 2]).toContain("2h ago  ses_aaaaaaaa  Old chat")
    expect(lines).toContain("  daily 09:00  morning check  active · 4 runs · next in 1h  /work/a")
    const j = catalogHarness({ send: () => ({ ok: true, result: report }) })
    expect(await j.run(["bot", "show", "reviewer", "--json"])).toBe(0)
    expect(JSON.parse(j.out[0]!)).toMatchObject({ kind: "result", command: "agent.bots", data: { name: "reviewer", projects: [{ directory: "/work/a" }, { directory: "/work/b" }] } })
  })

  test("an unknown bot and a daemon refusal (bots off) fail with the reason", async () => {
    const h = catalogHarness({ send: () => ({ ok: true, result: report }) })
    const app = catalogHarness({ send: () => ({ ok: true, result: report }) })
    expect(await app.run(["bot", "show", "HERMES-DEFAULT"])).toBe(0)
    expect(app.out.join("")).toBe("hermes-default  idle · kimi-k3 · from hermes\n\nNo chats yet.\n")
    expect(await h.run(["bot", "show", "nobody"])).toBe(1)
    expect(h.err.join("")).toContain("No bot named nobody")
    const off = catalogHarness({ send: () => ({ ok: false, error: { code: "forbidden", message: "bots are experimental: /experimental bots on" } }) })
    expect(await off.run(["bot", "list"])).toBe(1)
    expect(off.err.join("")).toContain("/experimental bots on")
  })
})
