import { describe, expect, test } from "bun:test"
import { createIdFactory, type MemoryEntry, type MemoryLink } from "@mendcode/protocol"
import { createMemorySelector, createRememberTool, selectMemories } from "../src"

const ids = createIdFactory()
const DAY = 86_400_000
const NOW = 1_000 * DAY

const saved = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({
  memoryId: ids("memory"),
  scope: "project",
  directory: "/repo",
  text,
  category: "commands",
  status: "saved",
  source: "user",
  createdAt: 0,
  updatedAt: NOW,
  ...patch,
})
const hit = (memory: MemoryEntry, rank = -1) => ({ memory, rank })
const texts = (entries: MemoryEntry[]) => entries.map((e) => e.text)
const line = (e: MemoryEntry) => `- [${e.scope}/${e.category}] ${e.text}`.length + 1

describe("relevance retrieval", () => {
  test("a memory the prompt matches beats a newer one it does not, when the budget fits only one", () => {
    const matching = saved("Deploy with fly deploy --remote-only", { updatedAt: NOW - 200 * DAY })
    const recent = saved("Unrelated note about the lunch menu today")
    const chosen = selectMemories({ entries: [recent, matching], hits: [hit(matching)], links: [], now: NOW, maxChars: line(matching) + 5 })
    expect(texts(chosen)).toEqual([matching.text])
  })

  test("the budget bounds the selection and unmatched memories cannot crowd out matches", () => {
    const matches = Array.from({ length: 10 }, (_, i) => saved(`match number ${i} about deploys and releases`))
    const filler = Array.from({ length: 50 }, (_, i) => saved(`ambient filler memory number ${i} with some words`, { category: "other" }))
    const chosen = selectMemories({ entries: [...filler, ...matches], hits: matches.map((m) => hit(m)), links: [], now: NOW, maxChars: 600 })
    expect(chosen.reduce((total, e) => total + line(e), 0)).toBeLessThanOrEqual(600)
    expect(chosen.slice(0, 5).every((e) => e.text.startsWith("match number"))).toBe(true)
    expect(chosen.length).toBeLessThan(filler.length + matches.length)
  })

  test("with no match at all, only a bounded ambient share is injected (not every saved memory)", () => {
    const many = Array.from({ length: 100 }, (_, i) => saved(`standing memory number ${i} with some words in it`))
    const chosen = selectMemories({ entries: many, hits: [], links: [], now: NOW, maxChars: 6_000 })
    expect(chosen.length).toBeGreaterThan(0)
    expect(chosen.reduce((total, e) => total + line(e), 0)).toBeLessThanOrEqual(1_500)
  })

  test("pinned memories are always in, first, even when irrelevant, old and the budget is tiny", () => {
    const pinned = saved("Never commit secrets to the repository", { pinned: true, updatedAt: NOW - 900 * DAY })
    const matching = saved("Deploy with fly deploy")
    // Pinned entries count against the budget but are never cut by it: with a budget smaller than the pin, only the pin is in.
    expect(selectMemories({ entries: [matching, pinned], hits: [hit(matching)], links: [], now: NOW, maxChars: 30 })).toEqual([pinned])
    const roomy = selectMemories({ entries: [matching, pinned], hits: [hit(matching)], links: [], now: NOW, maxChars: 200 })
    expect(roomy[0]).toBe(pinned)
    expect(roomy).toContain(matching)
  })

  test("a memory linked to a match rises, and one that a saved memory supersedes sinks", () => {
    const matching = saved("Package manager is pnpm")
    const related = saved("Lockfile is pnpm-lock.yaml", { updatedAt: NOW - 100 * DAY })
    const loner = saved("The office plant needs water on Fridays", { updatedAt: NOW - 100 * DAY })
    const stale = saved("Package manager is npm", { updatedAt: NOW - 100 * DAY })
    const link = (from: MemoryEntry, to: MemoryEntry, kind: MemoryLink["kind"]): MemoryLink => ({ from: from.memoryId, to: to.memoryId, kind, createdAt: 0 })
    const chosen = selectMemories({
      entries: [loner, stale, related, matching],
      hits: [hit(matching)],
      links: [link(matching, related, "related"), link(matching, stale, "supersedes")],
      now: NOW,
      maxChars: line(matching) + line(related) + 5,
    })
    expect(texts(chosen)).toEqual([matching.text, related.text])
  })

  test("the selector keeps a session's earlier selection unless clearly outranked, and a fresh session ranks from scratch", () => {
    const a = saved("Alpha rule about deploys")
    const b = saved("Beta rule about tests", { updatedAt: NOW - 10 * DAY })
    const port = {
      visible: () => [a, b],
      related: (input: { prompt: string }) => (input.prompt.includes("tests") ? [hit(b)] : input.prompt.includes("deploys") ? [hit(a)] : []),
      links: () => [],
    }
    const selector = createMemorySelector(port, { now: () => NOW, maxChars: line(a) + 4 })
    const sessionId = ids("session")
    expect(texts(selector.select({ directory: "/repo", sessionId, prompt: "how do deploys work" }).memories)).toEqual([a.text])
    // A match for the other memory wins only when it is clearly better than what the session already saw.
    expect(texts(selector.select({ directory: "/repo", sessionId, prompt: "deploys and tests" }).memories)[0]).toBe(b.text)
    expect(texts(selector.select({ directory: "/repo", sessionId: ids("session"), prompt: "how do deploys work" }).memories)).toEqual([a.text])
  })

  test("the block says how many saved memories it left out, and is empty with nothing saved", () => {
    const many = Array.from({ length: 30 }, (_, i) => saved(`memory number ${i} `.repeat(6)))
    const selector = createMemorySelector({ visible: () => many, related: () => [], links: () => [] }, { now: () => NOW, maxChars: 500 })
    expect(selector.block({ directory: "/repo", prompt: "anything" })).toMatch(/\(\d+ more saved memories not shown; search them with memory_graph\)/)
    expect(createMemorySelector({ visible: () => [], related: () => [], links: () => [] }).block({ directory: "/repo", prompt: "x" })).toBe("")
  })
})

describe("remember tool outcomes", () => {
  test("tells the agent what became of its proposal", async () => {
    const run = async (result: string | { outcome: "pending" | "saved" | "dropped"; memoryId?: string }) => {
      const tool = createRememberTool(() => result)
      return (await tool.execute({ text: "Deploy with fly deploy", scope: "project" }, { cwd: "/repo", signal: new AbortController().signal })).output
    }
    expect(await run({ outcome: "saved", memoryId: "mem_1" })).toContain("Saved")
    expect(await run({ outcome: "dropped" })).toContain("Not kept")
    expect(await run({ outcome: "pending", memoryId: "mem_2" })).toContain("/memory")
    expect(await run("mem_3")).toContain("/memory")
  })
})

test("memory use and per-scope caps apply per call, including pinned entries and wrapper token estimates", () => {
  const entries = ["one", "two", "three", "four"].map((text) => ({ memoryId: ids("memory"), scope: "project" as const, directory: "/repo", text: text.repeat(100), category: "commands", status: "saved" as const, source: "user" as const, pinned: true, createdAt: NOW, updatedAt: NOW }))
  const settings = { memoryEnabled: true, memoryUse: false, memoryMaxEntries: 2, memoryProjectMaxEntries: 1, memoryMaxPromptTokens: 200 }
  const selector = createMemorySelector({ visible: () => entries, related: () => [], links: () => [] }, { settings: () => settings })
  expect(selector.block({ directory: "/repo", prompt: "one" })).toBe("")
  settings.memoryUse = true
  expect(selector.select({ directory: "/repo", prompt: "one" }).memories).toHaveLength(1)
  expect(selector.block({ directory: "/repo", prompt: "one" }).length).toBeLessThanOrEqual(800)
  settings.memoryMaxPromptTokens = 1
  expect(selector.block({ directory: "/repo", prompt: "one" })).toBe("")
  settings.memoryEnabled = false
  expect(selector.select({ directory: "/repo", prompt: "one" }).memories).toEqual([])
})

test("daemon prompt retrieval requires explicit use opt-in even when saved facts exist", () => {
  const selector = createMemorySelector({ visible: () => [saved("manual fact")], related: () => [], links: () => [] }, { settings: () => ({}) })
  expect(selector.block({ directory: "/repo", prompt: "manual" })).toBe("")
})
