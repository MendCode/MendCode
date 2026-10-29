import { describe, expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry, type SessionEvent } from "@mendcode/protocol"
import { collectEvidence, DREAM_LIMITS, dreamPrompt, parseDreamOutput, runDream } from "../src"

const ids = createIdFactory()

function session(pairs: Array<[string, string]>, tool = "secret tool output") {
  const sessionId = ids("session")
  let seq = 0
  const events: SessionEvent[] = []
  const ev = (e: Record<string, unknown>) => void events.push({ sessionId, seq: ++seq, at: 0, ...e } as SessionEvent)
  const turnId = ids("turn")
  for (const [user, agent] of pairs) {
    const u = ids("item")
    const t = ids("item")
    const a = ids("item")
    ev({ type: "item.started", turnId, itemId: u, kind: "user_message" })
    ev({ type: "item.completed", itemId: u, status: "ok", text: user })
    ev({ type: "item.started", turnId, itemId: t, kind: "tool_call" })
    ev({ type: "item.completed", itemId: t, status: "ok", text: tool })
    ev({ type: "item.started", turnId, itemId: a, kind: "agent_message" })
    ev({ type: "item.completed", itemId: a, status: "ok", text: agent })
  }
  return { sessionId, title: "t", events }
}

const memory = (text: string): MemoryEntry => ({ memoryId: ids("memory"), scope: "project", directory: "/repo", text, category: "commands", status: "saved", source: "user", createdAt: 0, updatedAt: 0 })

describe("dream", () => {
  test("evidence keeps user prompts and agent answers only, bounded", () => {
    const evidence = collectEvidence([session([["how do we test?", "Run bun test packages."]])])
    expect(evidence[0]!.lines).toEqual(["user: how do we test?", "agent: Run bun test packages."])
    const huge = Array.from({ length: 40 }, () => session([["x".repeat(3_000), "y".repeat(3_000)]]))
    const bounded = collectEvidence(huge)
    expect(bounded.length).toBeLessThanOrEqual(DREAM_LIMITS.sessions)
    expect(bounded.flatMap((e) => e.lines).join("").length).toBeLessThanOrEqual(DREAM_LIMITS.evidenceChars)
  })

  test("the prompt lists what is already remembered and asks for JSON", () => {
    const prompt = dreamPrompt({ directory: "/repo", evidence: collectEvidence([session([["q", "a"]])]), memories: [memory("Use pnpm")] })
    expect(prompt).toContain("[project/commands] Use pnpm")
    expect(prompt).toContain('"proposals"')
    expect(prompt).not.toContain("secret tool output")
  })

  test("output parsing tolerates fences, drops duplicates and invalid items, caps at five", () => {
    const out = "```json\n" + JSON.stringify({
      proposals: [
        { text: "Use PNPM!", scope: "project", category: "commands", why: "dup" },
        { text: "short" },
        ...Array.from({ length: 8 }, (_, i) => ({ text: `Deploy step number ${i} runs fly deploy`, scope: "weird", why: "s" })),
      ],
      notes: "none",
    }) + "\n```"
    const parsed = parseDreamOutput(out, [memory("use pnpm")])
    expect("proposals" in parsed && parsed.proposals).toHaveLength(5)
    expect("proposals" in parsed && parsed.proposals[0]!.scope).toBe("project")
    expect(parseDreamOutput("no json here", [])).toEqual({ error: "no JSON object in the model output" })
  })

  test("a run proposes pending memories and skips when there is nothing to learn from", async () => {
    const proposed: unknown[] = []
    const base = {
      directory: "/repo",
      memories: () => [],
      propose: (e: unknown) => void proposed.push(e),
      signal: new AbortController().signal,
    }
    expect(await runDream({ ...base, sessions: () => [], complete: async () => "{}" })).toMatchObject({ status: "skipped", reason: "no recent conversations in this project" })
    const result = await runDream({
      ...base,
      sessions: () => [session([["release?", "We release with bun run release after tagging."]])],
      complete: async () => JSON.stringify({ proposals: [{ text: "Release with bun run release after tagging", scope: "project", category: "commands", why: "s1" }], notes: "" }),
    })
    expect(result).toMatchObject({ status: "done", proposed: 1 })
    expect(proposed).toEqual([{ scope: "project", directory: "/repo", text: "Release with bun run release after tagging", category: "commands" }])
    expect(await runDream({ ...base, sessions: () => [session([["a", "b"]])], complete: async () => Promise.reject(new Error("429")) })).toMatchObject({ status: "failed", error: "429" })
  })
})
