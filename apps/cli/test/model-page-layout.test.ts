import { describe, expect, test } from "bun:test"
import type { ModelInfo, ModelsReport } from "@mendcode/protocol"
import { createModelPageState, groupModels, renderModelPage } from "../src/view/model-page"
import type { ModelPrefs } from "../src/view/model-prefs"
import { textWidth } from "../src/view/wrap"
import { plain } from "./session-ui-harness"

/** The owner's catalog: seven ChatGPT-subscription models with their efforts and a 272k window, the four Claude Code aliases, an API-key provider. */
const CHATGPT = ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"]
const CLAUDE = ["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"]
const models: ModelInfo[] = [
  ...CHATGPT.map((id): ModelInfo => ({ id, name: id, efforts: ["low", "medium", "high"], contextWindow: 272_000 })),
  ...CLAUDE.map((id): ModelInfo => ({ id, name: `${id} · Claude Code`, efforts: ["low", "medium", "high", "xhigh"], contextWindow: 200_000, engine: "claude" })),
  { id: "anthropic:claude-sonnet-5-5", name: "claude-sonnet-5-5 · Anthropic", efforts: ["low", "high"], contextWindow: 1_000_000, provider: "anthropic" },
]
const IDS = models.map((model) => model.id)
const REPORT: ModelsReport = { engine: "native", selectable: true, models, defaults: { model: "gpt-6-sol", effort: "medium" }, roles: {}, effective: { model: "gpt-6-astra", effort: "medium" } }
const PREFS: ModelPrefs = { favorites: [], recents: ["gpt-6-astra", "claude-opus", "gpt-6.1-sol", "claude-fable", "gpt-5.6-luna"] }

const SIZES = [[80, 24], [120, 40], [200, 60]] as const
const hasId = (row: string, id: string) => new RegExp(`(^|\\s)${id.replace(/[.\\]/g, "\\$&")}(\\s|$)`).test(row)
/** The text of the last box on a row: the Models panel (alone below 150 columns, right of the roles above it). */
const lastBox = (row: string) => {
  const edges = [...row].flatMap((char, index) => (char === "│" ? [index] : []))
  return edges.length >= 2 ? row.slice(edges.at(-2)! + 1, edges.at(-1)!) : row
}
const catalogRows = (rows: string[]) => rows.map(lastBox).filter((text) => !text.includes("‹"))
const render = (input: { width: number; height: number; session?: string; row?: number }) => renderModelPage({
  state: { ...createModelPageState(), row: input.row ?? 0 },
  report: { ...REPORT, ...(input.session ? { session: { model: input.session } } : {}) },
  prefs: PREFS,
  width: input.width,
  height: input.height,
}).map(plain)

describe("the Models panel of the /model roles page", () => {
  for (const [width, height] of SIZES) {
    describe(`${width}x${height}`, () => {
      test("every row fits the width and none ends in a number cut mid-token", () => {
        for (const session of [undefined, ...IDS]) {
          for (const row of render({ width, height, ...(session ? { session } : {}) })) {
            expect(textWidth(row)).toBeLessThanOrEqual(width)
            // A context window is `272k`; a facts line never ends in a bare number (`· 272`).
            expect(lastBox(row).trimEnd()).not.toMatch(/·\s+\d+$/)
          }
        }
      })

      test("moving the selection through the models always has the selected one in view; each one is reachable", () => {
        const reached = new Set<string>()
        for (const session of IDS) {
          const rows = render({ width, height, session })
          expect(rows.some((row) => hasId(row, session))).toBe(true)
          for (const id of IDS) if (rows.some((row) => hasId(row, id))) reached.add(id)
        }
        expect([...reached].sort()).toEqual([...IDS].sort())
      })

      test("rows hidden above or below are counted in a muted line, and the counts add up to the models out of view", () => {
        for (const session of IDS) {
          const rows = render({ width, height, session })
          const panel = catalogRows(rows)
          const hidden = (arrow: string) => Number(panel.map((row) => new RegExp(`${arrow} (\\d+) more`).exec(row)?.[1]).find(Boolean) ?? 0)
          const listed = groupModels(models).flatMap((group) => group.models).length + PREFS.recents.filter((id) => IDS.includes(id)).length
          const shown = panel.filter((row) => IDS.some((id) => hasId(row, id))).length
          expect(shown + hidden("↑") + hidden("↓")).toBe(listed)
        }
      })
    })
  }

  test("at 120x40 the Claude Code group is reachable though the five Recent rows push it down; its header counts the four", () => {
    const fable = render({ width: 120, height: 40, session: "claude-fable" })
    expect(fable.some((row) => /Claude Code\s+4\b/.test(row))).toBe(true)
    expect(fable.some((row) => /↑ \d+ more/.test(row))).toBe(true)
    expect(fable.filter((row) => hasId(row, "claude-fable")).length).toBeGreaterThan(0)
    expect(fable.some((row) => hasId(row, "claude-opus"))).toBe(true)
  })

  test("a Recent row keeps its context window whole and drops the efforts, then the server, first", () => {
    const wide = render({ width: 200, height: 60 })
    const astra = wide.find((row) => hasId(row, "gpt-6-astra") && row.includes("272k"))
    expect(astra).toBeDefined()
    const narrow = render({ width: 120, height: 40 })
    for (const row of narrow.filter((row) => hasId(row, "gpt-6-astra"))) expect(row).toMatch(/272k/)
    const opus = catalogRows(render({ width: 120, height: 40, session: "claude-opus" })).find((row) => hasId(row, "claude-opus"))
    expect(opus).toMatch(/200k/)
  })

  test("everything shows without indicators when the panel has room for it", () => {
    const rows = render({ width: 200, height: 60 })
    expect(rows.some((row) => /(↑|↓) \d+ more/.test(row))).toBe(false)
    for (const id of IDS) expect(rows.some((row) => hasId(row, id))).toBe(true)
    expect(rows.some((row) => /ChatGPT subscription\s+7\b/.test(row))).toBe(true)
    expect(rows.some((row) => /Claude Code\s+4\b/.test(row))).toBe(true)
  })
})
