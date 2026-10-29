import { describe, expect, test } from "bun:test"
import type { ModelsReport } from "@mendcode/protocol"
import { createModelPageState, MODEL_PAGE_ROWS, modelPageKey, renderModelPage } from "../src/view/model-page"
import { textWidth } from "../src/view/wrap"

const text = (line: { text: string }[]) => line.map((span) => span.text).join("")
const RIGHT = "\x1b[C"
const LEFT = "\x1b[D"
const DOWN = "\x1b[B"

const report = (over: Partial<ModelsReport> = {}): ModelsReport => ({
  engine: "native",
  selectable: true,
  models: [
    { id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 },
    { id: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextWindow: 272_000 },
  ],
  defaults: { model: "gpt-6-luna", effort: "low" },
  roles: {},
  effective: { model: "gpt-6-luna", effort: "low" },
  ...over,
})

describe("modelPageKey", () => {
  test("→ on this session walks unset → each model → unset; ← goes back", () => {
    const state = createModelPageState()
    expect(modelPageKey(state, RIGHT, report()).action).toEqual({ type: "session", choice: { model: "gpt-6-luna" } })
    expect(modelPageKey(state, RIGHT, report({ session: { model: "gpt-6-luna" } })).action).toEqual({ type: "session", choice: { model: "gpt-6-sol" } })
    expect(modelPageKey(state, RIGHT, report({ session: { model: "gpt-6-sol" } })).action).toEqual({ type: "session", choice: null })
    expect(modelPageKey(state, LEFT, report()).action).toEqual({ type: "session", choice: { model: "gpt-6-sol" } })
  })
  test("changing model keeps an effort the new model supports and drops one it does not", () => {
    const state = createModelPageState()
    expect(modelPageKey(state, LEFT, report({ session: { model: "gpt-6-luna", effort: "high" } })).action).toEqual({ type: "session", choice: null })
    expect(modelPageKey(state, RIGHT, report({ session: { model: "gpt-6-luna", effort: "high" } })).action).toEqual({ type: "session", choice: { model: "gpt-6-sol", effort: "high" } })
    expect(modelPageKey(state, LEFT, report({ session: { model: "gpt-6-sol", effort: "xhigh" } })).action).toEqual({ type: "session", choice: { model: "gpt-6-luna" } })
  })
  test("e cycles the effort through the model default and each supported effort; nothing without a model", () => {
    const state = createModelPageState()
    expect(modelPageKey(state, "e", report({ session: { model: "gpt-6-luna" } })).action).toEqual({ type: "session", choice: { model: "gpt-6-luna", effort: "low" } })
    expect(modelPageKey(state, "e", report({ session: { model: "gpt-6-luna", effort: "high" } })).action).toEqual({ type: "session", choice: { model: "gpt-6-luna" } })
    expect(modelPageKey(state, "e", report()).action).toEqual({ type: "none" })
  })
  test("s turns fast on and off for an OpenAI Responses model and keeps it across effort and model changes", () => {
    const state = createModelPageState()
    const fast = { service_tier: "priority" }
    expect(modelPageKey(state, "s", report({ session: { model: "gpt-6-luna", effort: "high" } })).action).toEqual({ type: "session", choice: { model: "gpt-6-luna", effort: "high", parameters: fast } })
    expect(modelPageKey(state, "s", report({ session: { model: "gpt-6-luna", parameters: fast } })).action).toEqual({ type: "session", choice: { model: "gpt-6-luna" } })
    expect(modelPageKey(state, "e", report({ session: { model: "gpt-6-luna", parameters: fast } })).action).toEqual({ type: "session", choice: { model: "gpt-6-luna", effort: "low", parameters: fast } })
    expect(modelPageKey(state, RIGHT, report({ session: { model: "gpt-6-luna", parameters: fast } })).action).toEqual({ type: "session", choice: { model: "gpt-6-sol", parameters: fast } })
    expect(modelPageKey(state, "s", report()).action).toEqual({ type: "none" })
  })
  test("s does nothing on models outside OpenAI Responses hosts, and moving to one drops fast", () => {
    const state = createModelPageState()
    const models = [...report().models, { id: "opencode:kimi", name: "Kimi", efforts: [], provider: "opencode" }, { id: "claude-opus", name: "Opus", efforts: [], engine: "claude" as const }]
    expect(modelPageKey(state, "s", report({ models, session: { model: "opencode:kimi" } })).action).toEqual({ type: "none" })
    expect(modelPageKey(state, "s", report({ models, session: { model: "claude-opus" } })).action).toEqual({ type: "none" })
    expect(modelPageKey(state, RIGHT, report({ models, session: { model: "gpt-6-sol", parameters: { service_tier: "priority" } } })).action).toEqual({ type: "session", choice: { model: "claude-opus" } })
  })
  test("a fast row reads · fast after its effort", () => {
    const lines = renderModelPage({ state: createModelPageState(), report: report({ session: { model: "gpt-6-luna", effort: "high", parameters: { service_tier: "priority" } } }), width: 120, height: 30 }).map(text)
    expect(lines.some((line) => line.includes("high · fast"))).toBe(true)
  })
  test("role rows edit the settings' roles and leave the others alone", () => {
    const onCompaction = { row: MODEL_PAGE_ROWS.indexOf("compaction") }
    const base = report({ roles: { main: { model: "gpt-6-sol", effort: "high" } } })
    expect(modelPageKey(onCompaction, RIGHT, base).action).toEqual({ type: "roles", roles: { main: { model: "gpt-6-sol", effort: "high" }, compaction: { model: "gpt-6-luna" } } })
    const onMain = { row: MODEL_PAGE_ROWS.indexOf("main") }
    expect(modelPageKey(onMain, RIGHT, base).action).toEqual({ type: "roles", roles: {} })
  })
  test("rows move and stop at the ends; esc, enter and q close; engines without a choice only move and close", () => {
    const state = createModelPageState()
    expect(modelPageKey(state, "\x1b[A", report()).state).toBe(state)
    expect(modelPageKey(state, DOWN, report()).state).toEqual({ row: 1 })
    expect(modelPageKey({ row: MODEL_PAGE_ROWS.length - 1 }, DOWN, report()).state.row).toBe(MODEL_PAGE_ROWS.length - 1)
    for (const key of ["\x1b", "\r", "q"]) expect(modelPageKey(state, key, report()).action).toEqual({ type: "close" })
    expect(modelPageKey(state, RIGHT, report({ selectable: false })).action).toEqual({ type: "none" })
    expect(modelPageKey(state, RIGHT, undefined).action).toEqual({ type: "none" })
  })
})

describe("renderModelPage", () => {
  const lines = (over: Partial<Parameters<typeof renderModelPage>[0]> = {}) => renderModelPage({ state: createModelPageState(), report: report(), width: 100, height: 35, ...over }).map(text)

  test("shows what the next answer uses, each row with its choice or what it falls back to, and the catalog", () => {
    const out = lines({ report: report({ session: { model: "gpt-6-sol", effort: "high" }, effective: { model: "gpt-6-sol", effort: "high" } }) })
    expect(out.some((l) => l.includes("GPT-6-Sol · high"))).toBe(true) // in summary or body
    expect(out.find((l) => l.includes("this session"))).toContain("‹ GPT-6-Sol › high")
    expect(out.find((l) => l.includes("main "))).toContain("‹ default · GPT-6-Luna · low ›")
    expect(out.find((l) => l.includes("compaction"))).toContain("same as main")
    expect(out.some((l) => l.includes("GPT-6-Sol") && l.includes("xhigh"))).toBe(true) // models panel shows efforts
    expect(out.some((l) => l.includes("GPT-6-Sol") && l.includes("gpt-6-sol"))).toBe(true) // the exact id stays beside the name where models are picked
  })
  test("loading, errors and engines that choose their own model", () => {
    expect(lines({ report: undefined }).some((l) => l.includes("loading…"))).toBe(true)
    expect(lines({ report: undefined, error: "boom" }).some((l) => l.includes("boom"))).toBe(true)
    expect(lines({ report: report({ engine: "codex", selectable: false }) }).some((l) => l.includes("codex engine chooses its own model"))).toBe(true)
  })
  test.each([60, 100, 140])("fits width %i and exactly the height; content visible at reasonable sizes", (width) => {
    for (const height of [20, 35, 50]) {
      const out = renderModelPage({ state: { row: MODEL_PAGE_ROWS.length - 1 }, report: report(), width, height })
      expect(out).toHaveLength(height)
      for (const line of out) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
      // At reasonable heights, dream row should be visible in the roles panel
      if (height >= 20) expect(out.map(text).some((l) => l.includes("dream"))).toBe(true)
    }
  })
  test("keys sit in the header and the effective model is directly below it", () => {
    const out = lines()
    expect(out[0]!.trimStart()).toStartWith("Model")
    expect(out[0]).toContain("/ search")
    expect(out[1]).toContain("next: GPT-6-Luna · low")
    expect(out.at(-2)).not.toContain("esc close")
  })
  test("roles and catalog use the shared bordered grid", () => {
    const out = renderModelPage({ state: createModelPageState(), report: report(), width: 100, height: 35 })
    expect(out.flatMap((line) => line).find((span) => span.text === "Roles")).toMatchObject({ bold: true, fg: "primary" })
    expect(out.flatMap((line) => line).find((span) => span.text === "Models")).toMatchObject({ bold: true, fg: "primary" })
    expect(out.map(text).join("")).toMatch(/[┌┐└┘│]/)
  })
  test("a failed load has an explicit red Error", () => {
    const out = renderModelPage({ state: createModelPageState(), report: undefined, error: "boom", width: 100, height: 20 })
    expect(out[1]!.find((span) => span.text === "Error")).toMatchObject({ fg: "error", bold: true })
    expect(renderModelPage({ state: createModelPageState(), report: undefined, width: 100, height: 20 })[1]!.some((span) => span.text === "Error")).toBe(false)
  })
  test("the focused row stays visible when the height is too short for the whole page", () => {
    const recipes = { recipes: [{ name: "fast", file: "recipes/fast.json", source: "user" as const, description: "cheap and quick", roles: {} }] }
    for (const row of [0, MODEL_PAGE_ROWS.length - 1, MODEL_PAGE_ROWS.length]) {
      const out = renderModelPage({ state: { row }, report: report(), recipes, width: 60, height: 12 })
      expect(out).toHaveLength(12)
      expect(out.map(text).find((l) => l.includes("❯"))).toBeDefined()
    }
  })
  test("exact width x height at 60x20, 80x30, 120x40 and 160x50, with recipes too", () => {
    const recipes = { recipes: [{ name: "fast", file: "recipes/fast.json", source: "user" as const, description: "cheap and quick", roles: {} }], active: "fast" }
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
      for (const withRecipes of [undefined, recipes]) {
        const out = renderModelPage({ state: createModelPageState(), report: report(), recipes: withRecipes, width, height })
        expect(out).toHaveLength(height)
        for (const line of out) expect(textWidth(text(line))).toBe(width)
      }
    }
  })
  test("respects minimum dimensions and fills exactly width × height", () => {
    const scenarios: Array<{ width: number; height: number }> = [
      { width: 60, height: 20 },
      { width: 90, height: 35 },
      { width: 120, height: 35 },
      { width: 160, height: 45 },
    ]
    for (const { width, height } of scenarios) {
      const out = renderModelPage({ state: createModelPageState(), report: report(), width, height })
      expect(out).toHaveLength(height)
      for (const line of out) {
        const w = textWidth(text(line))
        expect(w).toBeLessThanOrEqual(width)
      }
    }
  })
})
