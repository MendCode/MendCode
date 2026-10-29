import { describe, expect, test } from "bun:test"
import { ADAPTERS, CONVERSATION, comparePrefix, lineageReport, recordLineage, type Adapter } from "./prefix-harness"

const MODES = ["legacy", "smart"] as const

describe("prefix stability: a request repeats the whole previous request of its lineage", () => {
  for (const adapter of ADAPTERS) for (const promptCache of MODES) {
    test(`${adapter} (${promptCache}): every call, inside a turn and into the next turn, only appends`, async () => {
      const calls = await recordLineage({ adapter, turns: CONVERSATION, promptCache })
      expect(calls).toHaveLength(5)
      const report = lineageReport(adapter, calls)
      console.info(`${adapter}/${promptCache}: ${report.map((entry) => `${entry.from}→${entry.to}${entry.crossTurn ? " (new turn)" : ""} ${(entry.share * 100).toFixed(1)}% ${entry.firstDifference}`).join(" · ")}`)
      for (const entry of report) expect(entry, `${entry.from}→${entry.to}`).toMatchObject({ share: 1, firstDifference: "none" })
    })
  }

  test("the check itself fails when an earlier message, the system prompt or the tool list changes", async () => {
    const calls = await recordLineage({ adapter: "responses", turns: CONVERSATION })
    const [first, second] = [calls[0]!.body, calls[1]!.body]
    const edited = (patch: (body: Record<string, any>) => void) => { const copy = structuredClone(second); patch(copy); return copy }
    expect(comparePrefix("responses", first, second)).toMatchObject({ share: 1, firstDifference: "none" })
    expect(comparePrefix("responses", first, edited((body) => { body.instructions = `${body.instructions} (2026-10-06)` }))).toMatchObject({ firstDifference: "system" })
    expect(comparePrefix("responses", first, edited((body) => { body.tools = [...body.tools].reverse() }))).toMatchObject({ firstDifference: "tools" })
    expect(comparePrefix("responses", first, edited((body) => { body.input[0].content[0].text += " [changed]" }))).toMatchObject({ firstDifference: "messages[0]" })
    const report = comparePrefix("responses", first, edited((body) => { body.input[0].content[0].text += " [changed]" }))
    expect(report.share).toBeLessThan(1)
  })

  test("each adapter really received the whole conversation (the fixture is not vacuous)", async () => {
    for (const adapter of ADAPTERS as readonly Adapter[]) {
      const calls = await recordLineage({ adapter, turns: CONVERSATION })
      const text = JSON.stringify(calls.at(-1)!.body)
      for (const needle of ["Fix the pagination bug", "src/paginate.ts", "Fixed it.", "Now add a test for the empty page"]) expect(text, `${adapter}: ${needle}`).toContain(needle)
    }
  })
})
