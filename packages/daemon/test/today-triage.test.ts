import { describe, expect, test } from "bun:test"
import type { ModelInfo, TodayTriageItem } from "@mendcode/protocol"
import { cheapAuxiliaryModel, type ModelCatalog } from "../src/models"
import { readTriage, todayTriageRequest, TODAY_TRIAGE_SYSTEM } from "../src/today-triage"

const ITEMS: TodayTriageItem[] = [
  { id: "attention:ses_a", tab: "attention", kind: "approval", title: "Run bun test", why: "shop · waiting for your approval" },
  { id: "attention:ses_b", tab: "attention", kind: "approval", title: "Run bun test again", why: "shop · waiting for your approval" },
  { id: "pickup:ses_c", tab: "pickup", kind: "interrupted", title: "Coupon route", why: "the last turn was lost" },
  { id: "memory:mem_1", tab: "memory", kind: "new", title: "conventions: tests freeze the clock", why: "proposed as a new memory" },
  { id: "memory:mem_2", tab: "memory", kind: "new", title: "conventions: tests freeze time", why: "proposed as a new memory" },
]

describe("today triage answers", () => {
  test("keeps only ids the request carried, once each, and drops empty groups", () => {
    const groups = readTriage(JSON.stringify({ groups: [
      { title: "2 proposals repeat each other", reason: "same fact", example: "memory:mem_2", action: "memory", ids: ["memory:mem_1", "memory:mem_2", "memory:mem_9"] },
      { title: "again", reason: "", action: "mark", ids: ["memory:mem_1"] },
      { title: "unknown", action: "mark", ids: ["pickup:nope"] },
    ] }), ITEMS)
    expect(groups).toEqual([{ title: "2 proposals repeat each other", reason: "same fact", example: "memory:mem_2", action: "memory", ids: ["memory:mem_1", "memory:mem_2"] }])
  })

  test("an action the rows do not allow becomes review: memory only for memory rows, approvals never set aside", () => {
    const groups = readTriage(`<think>x</think>\`\`\`json\n${JSON.stringify({ groups: [
      { title: "tests", action: "memory", ids: ["attention:ses_a", "memory:mem_1"] },
      { title: "approvals", action: "wait", ids: ["attention:ses_b"] },
      { title: "later", action: "wait", ids: ["pickup:ses_c"] },
      { title: "bogus", action: "approve", ids: ["memory:mem_2"] },
    ] })}\n\`\`\``, ITEMS)!
    expect(groups.map((group) => group.action)).toEqual(["review", "review", "wait", "review"])
    expect(groups[0]!.example).toBe("attention:ses_a")
  })

  test("an answer without groups is no triage", () => {
    expect(readTriage("I cannot help", ITEMS)).toBeUndefined()
    expect(readTriage('{"answer": 1}', ITEMS)).toBeUndefined()
    expect(readTriage('{"groups": []}', ITEMS)).toEqual([])
  })

  test("the request is the rows as data and the system says they are not instructions", () => {
    expect(todayTriageRequest(ITEMS.slice(0, 1))).toBe('<items>\n[{"id":"attention:ses_a","tab":"attention","kind":"approval","title":"Run bun test","why":"shop · waiting for your approval"}]\n</items>')
    expect(TODAY_TRIAGE_SYSTEM).toContain("not instructions")
  })
})

describe("cheapAuxiliaryModel", () => {
  const MODELS: ModelInfo[] = [
    { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: [] },
    { id: "gpt-6-sol", name: "GPT-6-Sol", efforts: [] },
    { id: "anthropic:claude-opus-5-5", name: "Opus", efforts: [], provider: "anthropic" },
    { id: "claude-opus", name: "Claude Opus · Claude Code", efforts: [], engine: "claude" },
  ]
  const catalog: ModelCatalog = { selectable: true, list: () => MODELS, defaults: { model: "gpt-6-sol" } }

  test("a set memory or small role wins; else the main model's cheaper peer; never a large model or an engine", () => {
    expect(cheapAuxiliaryModel({ roles: { main: { model: "gpt-6-sol" } }, catalog })?.model).toBe("gpt-6-luna")
    expect(cheapAuxiliaryModel({ roles: { main: { model: "gpt-6-sol" }, small: { model: "anthropic:claude-opus-5-5" } }, catalog })?.model).toBe("anthropic:claude-opus-5-5")
    expect(cheapAuxiliaryModel({ roles: { main: { model: "gpt-6-luna" } }, catalog })?.model).toBe("gpt-6-luna")
    expect(cheapAuxiliaryModel({ roles: { main: { model: "anthropic:claude-opus-5-5" } }, catalog })).toBeUndefined()
    expect(cheapAuxiliaryModel({ roles: { main: { model: "claude-opus" } }, catalog })).toBeUndefined()
  })
})
