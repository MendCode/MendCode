import { expect, test } from "bun:test"
import { unresolvedCounts } from "../src/pr-review/dashboard"

type Count = Parameters<typeof unresolvedCounts>
const finding = (id: string, severity: "critical" | "major" | "minor", verdict: "confirmed" | "plausible" = "confirmed") =>
  ({ id, path: "a.ts", line: 1, side: "RIGHT", severity, category: "correctness", summary: id, detail: id, evidence: ["a.ts:1"], verdict })
const job = (verified: ReturnType<typeof finding>[], open?: string[]) =>
  ({ checkpoint: { verified, rounds: open ? [{ open }] : [] } }) as unknown as Count[0]
const state = (published: Record<string, { finding: ReturnType<typeof finding>; resolved?: boolean }>) => ({ published }) as unknown as Count[1]

test("a plausible finding a strict review published stays open and blocking until it is resolved, as the commit status counts it", () => {
  const plausible = finding("p1", "major", "plausible")
  expect(unresolvedCounts(job([plausible]), state({ p1: { finding: plausible } }))).toEqual({ open: 1, blocking: 1 })
  expect(unresolvedCounts(job([plausible]), state({ p1: { finding: plausible, resolved: true } }))).toEqual({ open: 0, blocking: 0 })
})

test("an incremental job with no findings of its own keeps earlier unresolved ones; a fix round of the job closes its own", () => {
  const old = finding("o1", "critical")
  expect(unresolvedCounts(job([]), state({ o1: { finding: old } }))).toEqual({ open: 1, blocking: 1 })
  const mine = finding("m1", "major")
  expect(unresolvedCounts(job([mine], []), state({ m1: { finding: mine } }))).toEqual({ open: 0, blocking: 0 })
  expect(unresolvedCounts(job([mine, finding("m2", "minor")], ["m2"]), state({}))).toEqual({ open: 1, blocking: 0 })
})
