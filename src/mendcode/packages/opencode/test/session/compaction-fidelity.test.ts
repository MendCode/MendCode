import { describe, expect, test } from "bun:test"

import {
  checkFixtureFidelity,
  compactFixture,
  corruptedFixture,
  fixtureCorpora,
  runFixtureCanary,
} from "../../script/compaction-canary"

describe("compaction fidelity canary", () => {
  test("keeps the fixed facts, actions, intent, constraints, and tool pairs in both modes", () => {
    for (const corpus of fixtureCorpora()) {
      for (const strategy of ["portable", "native"] as const) {
        const result = runFixtureCanary(strategy, corpus)
        expect(result.status).toBe("PASS")
        expect(result.evidenceKind).toBe("synthetic-fixture")
        expect(result.fidelity).toEqual({ facts: true, actions: true, latestIntent: true, constraints: true, toolPairs: true })
        expect(result.corpus.sha256).toBe(corpus.sha256)
        expect(result.corpus.tokenMethod).toBe("utf8/4")
      }
    }
  })

  test("fails closed for corrupted or incomplete context", () => {
    const corpus = fixtureCorpora()[0]
    for (const kind of ["missing-fact", "broken-tool-pair", "wrong-intent"] as const) {
      expect(Object.values(checkFixtureFidelity(corruptedFixture(corpus.expected, kind), corpus.expected))).toContain(false)
    }
    expect(compactFixture({ strategy: "portable", corpus }).latestIntent).toBe(corpus.expected.latestIntent)
  })
})
