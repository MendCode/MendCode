import { describe, expect, test } from "bun:test"
import type { MemoryEntry } from "@mendcode/protocol"
import { createMemorySelector, type MemoryRetrievalPort } from "../src"
import { comparePrefix, recordLineage } from "./prefix-harness"

const entry = (id: string, word: string): MemoryEntry => ({ memoryId: id, scope: "project", category: "", text: `${word} ${"x".repeat(1_900)}`, status: "saved", updatedAt: 1_000, pinned: false, tags: [] }) as unknown as MemoryEntry
const memories = [entry("mem_alpha", "alpha"), entry("mem_beta", "beta")]
const port: MemoryRetrievalPort = {
  visible: () => memories,
  related: ({ prompt }) => memories.filter((memory) => prompt.includes(memory.text.split(" ")[0]!)).map((memory) => ({ memory, rank: 0 })),
  links: () => [],
}

describe("the system prompt of a turn does not depend on the prompts that join it", () => {
  test("a queued prompt or notice that matches another memory leaves the instructions, and the request prefix, as they were", async () => {
    const selector = createMemorySelector(port, { now: () => 2_000, settings: () => ({ memoryUse: true }) })
    const calls = await recordLineage({
      adapter: "responses", promptCache: "smart",
      system: (cwd, context) => `You are a coding agent.\n${selector.block({ directory: cwd, ...(context ? { sessionId: context.sessionId } : {}), prompt: context?.prompt ?? "" })}`,
      turns: [{ text: "Tell me about alpha", steps: [
        { calls: [{ name: "read", args: { path: "a.ts" } }] },
        { calls: [{ name: "read", args: { path: "b.ts" } }] },
        { text: "Done." },
      ] }],
      joins: { "0.0": "Now beta, please" },
    })
    expect(calls).toHaveLength(3)
    expect(calls[0]!.body.instructions).toContain("alpha")
    expect(calls[0]!.body.instructions).not.toContain("beta")
    for (const call of calls) expect(call.body.instructions).toBe(calls[0]!.body.instructions)
    for (const [i, call] of calls.slice(1).entries()) expect(comparePrefix("responses", calls[i]!.body, call.body), `call ${i} -> ${i + 1}`).toMatchObject({ share: 1, firstDifference: "none" })
    expect(new Set(calls.map((call) => call.body.prompt_cache_key)).size).toBe(1)
  })
})
