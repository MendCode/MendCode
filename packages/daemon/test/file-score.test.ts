import { describe, expect, test } from "bun:test"
import { indexEntry, rankEntries, scoreFileEntry } from "../src/file-score"
import { budgetMs } from "../../../scripts/test-budget"

const idx = (path: string, kind: "file" | "dir" = "file") => indexEntry(path, kind)

describe("scoreFileEntry", () => {
  test("basename prefix beats a path-segment match, which beats a subsequence match", () => {
    const basenamePrefix = idx("src/mendcode/app.ts")
    const segmentMatch = idx("apps/cli/src/index.ts")
    const subsequence = idx("packages/lsp/adapter/protocol.ts") // "app" as a subsequence of ...la-p...? use a clearer one below
    const query = "app"
    expect(scoreFileEntry(basenamePrefix, query)).toBeGreaterThan(scoreFileEntry(segmentMatch, query)!)
    expect(scoreFileEntry(segmentMatch, query)).toBeGreaterThan(scoreFileEntry(subsequence, query) ?? -Infinity)
  })

  test("no match returns undefined", () => {
    expect(scoreFileEntry(idx("src/index.ts"), "zzz")).toBeUndefined()
  })

  test("subsequence requires the characters in order, not contiguous", () => {
    expect(scoreFileEntry(idx("src/format.ts"), "tfm")).toBeUndefined() // reversed order: no match
    expect(scoreFileEntry(idx("src/format.ts"), "fmt")).toBeDefined() // f…m…t, in order but not contiguous
  })

  test("an empty query matches everything with score 0", () => {
    expect(scoreFileEntry(idx("anything.ts"), "")).toBe(0)
  })

  test("is case-insensitive (query and entries are pre-lowered)", () => {
    // indexEntry lowercases internally; scoring compares against an already-lowercase query.
    expect(scoreFileEntry(idx("Src/App.tsx"), "app")).toBeDefined()
  })

  test("shorter basenames rank above longer ones within the same tier", () => {
    const short = idx("app.ts")
    const long = idx("application-shell.ts")
    expect(scoreFileEntry(short, "app")!).toBeGreaterThan(scoreFileEntry(long, "app")!)
  })
})

describe("rankEntries", () => {
  const entries = [idx("src/view/mentions.ts"), idx("apps/cli/src/ui/app.ts"), idx("packages/daemon/src/files-index.ts"), idx("apps/cli", "dir"), idx("README.md")]

  test("ranks basename-prefix matches first, sorted, and respects the limit", () => {
    const ranked = rankEntries(entries, "app", 10)
    expect(ranked[0]!.path).toBe("apps/cli/src/ui/app.ts")
    expect(ranked.map((e) => e.path)).not.toContain("README.md")
    expect(rankEntries(entries, "app", 1)).toHaveLength(1)
  })

  test("an empty query lists entries unranked, capped at the limit", () => {
    expect(rankEntries(entries, "", 2)).toHaveLength(2)
    expect(rankEntries(entries, "", 2)).toEqual(entries.slice(0, 2))
  })

  test("directories are ranked and returned like files", () => {
    const ranked = rankEntries(entries, "cli", 10)
    expect(ranked.some((e) => e.path === "apps/cli" && e.kind === "dir")).toBe(true)
  })

  test("stays fast for 50k candidate paths", () => {
    const many = Array.from({ length: 50_000 }, (_, i) => idx(`src/pkg${i % 100}/module-${i}.ts`))
    const start = performance.now()
    rankEntries(many, "mod", 50)
    expect(performance.now() - start).toBeLessThan(budgetMs(50)) // generous CI margin over the 10 ms design target
  })
})
