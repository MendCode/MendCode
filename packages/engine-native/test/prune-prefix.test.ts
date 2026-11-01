import { describe, expect, test } from "bun:test"
import { comparePrefix, fileTool, recordLineage, type Recorded, type Step, type Turn } from "./prefix-harness"

/** A tool result of about 15k estimated tokens: five of them in one turn are what a prune can take back. */
const BIG = 60_000
const read = (path: string) => ({ name: "read", args: { path } })
const usage = (context: number) => ({ input: 500, output: 20, cacheRead: context - 500 })

/** Turn 0 leaves 75k tokens of tool output; turn 1 is small; turn 2 is the one the tests look into. */
const history = (third: Step[], carried = 63_000): Turn[] => [
  { text: "Read the five modules", steps: [...[1, 2, 3, 4, 5].map((n): Step => ({ calls: [read(`src/m${n}.ts`)], usage: usage(10_000 * n) })), { text: "Read them.", usage: usage(60_000) }] },
  { text: "Small question", steps: [{ calls: [read("src/small.ts")], usage: usage(62_000) }, { text: "Answered.", usage: usage(carried) }] },
  { text: "Look at the rest", steps: third },
]

const inTurn = (calls: Recorded[], index: number) => calls.filter((call) => call.turn === index)
const consecutive = (calls: Recorded[]) => calls.slice(1).map((call, i) => comparePrefix("responses", calls[i]!.body, call.body))
const options = { tools: [fileTool("read", BIG)], engineOptions: { compactAtTokens: 100_000 }, promptCache: "smart" as const }

describe("pruning old tool output never rewrites the prefix inside a turn", () => {
  test("the context crossing the prune point in the middle of a turn leaves the earlier items as they were", async () => {
    const calls = await recordLineage({
      adapter: "responses", ...options,
      // 70k at the first call of the turn (no prune is due), 85k at the second (past 80% of 100k): the third call must still repeat the second.
      turns: history([
        { calls: [read("src/a.ts")], usage: usage(70_000) },
        { calls: [read("src/b.ts")], usage: usage(85_000) },
        { calls: [read("src/c.ts")], usage: usage(88_000) },
        { text: "Done.", usage: usage(90_000) },
      ]),
    })
    const third = inTurn(calls, 2)
    expect(third).toHaveLength(4)
    for (const [i, report] of consecutive(third).entries()) expect(report, `call ${i} -> ${i + 1}`).toMatchObject({ share: 1, firstDifference: "none" })
  })

  test("a prompt or notice that joins the turn does not make the previous turn's results prunable mid-turn", async () => {
    const calls = await recordLineage({
      adapter: "responses", ...options,
      // The context is past the prune point from the first call of the turn, so the turn starts pruned; the join must not move that line.
      turns: history([
        { calls: [read("src/a.ts")], usage: usage(90_000) },
        { calls: [read("src/b.ts")], usage: usage(91_000) },
        { calls: [read("src/c.ts")], usage: usage(92_000) },
        { text: "Done.", usage: usage(93_000) },
      ], 90_000),
      joins: { "2.0": "Also check the small file", "2.1": "[background task bg_1 exited 0]" },
    })
    const third = inTurn(calls, 2)
    expect(third).toHaveLength(4)
    for (const [i, report] of consecutive(third).entries()) expect(report, `call ${i} -> ${i + 1}`).toMatchObject({ share: 1, firstDifference: "none" })
  })

  test("a context past the prune point at the start of a turn still prunes, once, before the first call", async () => {
    const calls = await recordLineage({
      adapter: "responses", ...options,
      turns: history([
        { calls: [read("src/a.ts")], usage: usage(90_000) },
        { text: "Done.", usage: usage(91_000) },
      ], 90_000),
    })
    const [secondTurnLast] = inTurn(calls, 1).slice(-1)
    const [first, second] = inTurn(calls, 2)
    // The start of the turn is the one place the prefix may change (the prompt cache is rewritten there anyway) ...
    expect(JSON.stringify(first!.body.input)).toContain("Old tool output pruned")
    expect(comparePrefix("responses", secondTurnLast!.body, first!.body).share).toBeLessThan(1)
    // ... and then it stays.
    expect(comparePrefix("responses", first!.body, second!.body)).toMatchObject({ share: 1, firstDifference: "none" })
  })

  test("a context about to reach the compaction point prunes once, and the calls after it repeat that request", async () => {
    const calls = await recordLineage({
      adapter: "responses", ...options,
      turns: history([
        { calls: [read("src/a.ts")], usage: usage(70_000) },
        { calls: [read("src/b.ts")], usage: usage(97_000) },
        { calls: [read("src/c.ts")], usage: usage(80_000) },
        { text: "Done.", usage: usage(82_000) },
      ]),
    })
    const third = inTurn(calls, 2)
    const [, before, urgent, after] = third
    expect(JSON.stringify(before!.body.input)).not.toContain("[Old tool output pruned]")
    expect(JSON.stringify(urgent!.body.input)).toContain("[Old tool output pruned]")
    expect(comparePrefix("responses", urgent!.body, after!.body)).toMatchObject({ share: 1, firstDifference: "none" })
  })
})
