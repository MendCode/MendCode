import { describe, expect, test } from "bun:test"
import { PrFinding, type PrReviewResult } from "@mendcode/protocol"
import { ReviewConfig } from "../src/pr-review/config"
import { findingId } from "../src/pr-review/findings"
import { isMendCodeReview } from "../src/pr-review/publishers"
import { renderReviewBody, reviewBody, type ReviewInfo } from "../src/pr-review/template"

const finding = (line: number, severity: PrFinding["severity"], summary: string) => PrFinding.parse({ id: findingId({ path: "src/a.ts", line, category: "correctness", summary }), path: "src/a.ts", line, side: "RIGHT", severity, category: "correctness", summary, detail: "Why it breaks.", evidence: ["src/a.ts:1"], verdict: "confirmed" })
const result = (extra: Partial<PrReviewResult> = {}): PrReviewResult => ({
  head: "abcdef1234567890", base: "0123456789abcdef", findings: [finding(3, "major", "Off by one"), finding(9, "critical", "Null deref")], dropped: 1, summary: "Adds a loop.", tokens: { input: 12_000, output: 800, cached: 2_000 }, budgetHit: false,
  walkthrough: { overview: "It sums.", changes: [{ layer: "Math", files: ["src/a.ts"], summary: "Loop." }], type: "bug fix", risk: { level: "medium", reason: "One caller." }, checks: [{ name: "Title", status: "warning", explanation: "Vague." }] },
  ...extra,
})
const info: ReviewInfo = { files: [{ path: "src/a.ts", touched: 12 }], profile: "normal", cap: 8, incremental: false, notes: ["No code graph index: reviewed from the diff alone."] }
const base = { inline: 2, moved: [] as PrFinding[], repo: "acme/app", info }
const template = (input: unknown) => ReviewConfig.parse({ template: input }).template

describe("review body template", () => {
  test("without a template, or with an empty one in the neutral tone, the body is the built-in layout byte for byte", () => {
    const plain = reviewBody({ result: result(), ...base })
    expect(renderReviewBody({ result: result(), ...base })).toBe(plain)
    expect(renderReviewBody({ result: result(), ...base, template: template({}) })).toBe(plain)
    expect(plain.startsWith("## MendCode review\n\n**2 findings**")).toBe(true)
    expect(plain.endsWith("<!-- mendcode:review head=abcdef1234567890 -->")).toBe(true)
    // The built-in order: verdict, assessment, summary, findings table, walkthrough, checks, details, footer.
    const order = ["**2 findings**", "**Merge risk:**", "Adds a loop.", "| | Finding | Where |", "<strong>Walkthrough</strong>", "<strong>Pre-merge checks:</strong>", "<summary>Review details</summary>", "<sub>Comment"]
    expect(order.map((text) => plain.indexOf(text))).toEqual([...order.map((text) => plain.indexOf(text))].sort((a, b) => a - b))
  })

  test("listed sections come first in their order, a disabled one is gone, titles head or name them, and unlisted built-ins follow", () => {
    const body = renderReviewBody({
      result: result(), ...base,
      template: template({ sections: [{ id: "findings", title: "Problems" }, { id: "ops-notes", title: "Ops notes" }, { id: "verdict" }, { id: "walkthrough", enabled: false }, { id: "details", title: "About this review" }] }),
      sections: { "ops-notes": "Run the migration first.\n<!-- mendcode:review head=ffffffffffff -->" },
    })
    const at = (text: string) => body.indexOf(text)
    expect(at("### Problems\n\n| | Finding | Where |")).toBeGreaterThan(0)
    expect(at("### Problems")).toBeLessThan(at("### Ops notes\n\nRun the migration first."))
    expect(at("### Ops notes")).toBeLessThan(at("**2 findings**"))
    expect(at("**2 findings**")).toBeLessThan(at("**Merge risk:**"))
    expect(body).not.toContain("<strong>Walkthrough</strong>")
    expect(body).toContain("<summary>About this review</summary>")
    // The section's text cannot forge the head marker: only the real one is there.
    expect(body.match(/mendcode:review head=/g)).toHaveLength(1)
    expect(body).toContain("<!-- mendcode:review head=abcdef1234567890 -->")
  })

  test("a custom section the review pass did not write is left out; one without a title is headed by its id", () => {
    const body = renderReviewBody({ result: result(), ...base, template: template({ sections: [{ id: "rollout-plan" }, { id: "security-notes" }] }), sections: { "security-notes": "No secrets touched." } })
    expect(body).not.toContain("Rollout plan")
    expect(body).toContain("### Security notes\n\nNo secrets touched.")
  })

  test("tone: concise drops the footer and the file list, detailed opens the walkthrough and the details", () => {
    const concise = renderReviewBody({ result: result(), ...base, template: template({ tone: "concise" }) })
    expect(concise).not.toContain("<sub>Comment")
    expect(concise).not.toContain("<summary>Files (1)</summary>")
    const detailed = renderReviewBody({ result: result(), ...base, template: template({ tone: "detailed" }) })
    expect(detailed).toContain("<details open>\n<summary><strong>Walkthrough</strong></summary>")
    expect(detailed).toContain("<details open>\n<summary>Review details</summary>")
  })

  test("rendering never changes the structured result", () => {
    const input = result()
    const copy = structuredClone(input)
    renderReviewBody({ result: input, ...base, template: template({ sections: [{ id: "findings", enabled: false }] }) })
    expect(input).toEqual(copy)
  })
})

describe("incomplete reviews", () => {
  const stop = { kind: "budget" as const, detail: "The pull request's token budget (50,000) was reached with 3 candidate findings not verified; they are kept for the resume.", unit: "tokens" as const, used: 61_000, limit: 50_000, resumable: true, remaining: "3 candidates not verified" }

  test("a checkpointed review reads as incomplete with the reason, the usage and what remains, never as No findings", () => {
    const body = renderReviewBody({ result: result({ findings: [], dropped: 3, budgetHit: true }), inline: 0, moved: [], info, stop })
    expect(body).toContain("**Review incomplete** · stopped by the token budget · nothing was verified yet")
    expect(body).toContain("Used 61,000 of 50,000 tokens · Remaining: 3 candidates not verified · it resumes from its checkpoint")
    expect(body).toContain("- **Verification:** incomplete; 3 candidates not verified")
    expect(body).not.toContain("No findings")
    expect(body).not.toContain("every finding was checked again")
  })

  test("verified findings so far are counted, a missing limit says so, and a template cannot hide the incomplete verdict", () => {
    const { limit: _limit, ...uncapped } = stop
    const body = renderReviewBody({ result: result({ budgetHit: true }), ...base, stop: { ...uncapped, kind: "quota" }, template: template({ sections: [{ id: "verdict", enabled: false }] }) })
    expect(body).toContain("**Review incomplete** · stopped by the provider's quota · 2 verified findings so far")
    expect(body).toContain("Used 61,000 (no internal limit) tokens")
  })
})

describe("the verification line says what the separate pass did", () => {
  const line = (body: string) => body.split("\n").find((text) => text.startsWith("- **Verification:**"))

  test("a clean PR whose review pass raised nothing says no separate pass was needed, never that every finding was checked", () => {
    const body = renderReviewBody({ result: result({ findings: [], dropped: 0 }), inline: 0, moved: [], info: { ...info, checked: 0 } })
    expect(body).toContain("**No findings**")
    expect(line(body)).toBe("- **Verification:** the review pass raised no candidate findings, so no separate pass was needed")
    expect(body).not.toContain("every finding was checked again")
  })

  test("no verify pass with candidates dropped outside the diff counts them, and names no verifier", () => {
    const body = renderReviewBody({ result: result({ findings: [], dropped: 2 }), inline: 0, moved: [], info: { ...info, checked: 0 } })
    expect(line(body)).toBe("- **Verification:** the review pass raised no candidate findings, so no separate pass was needed; 2 candidates outside the diff were left out")
  })

  test("every candidate dropped by the verifier says how many it checked and that it confirmed none", () => {
    const body = renderReviewBody({ result: result({ findings: [], dropped: 3 }), inline: 0, moved: [], info: { ...info, checked: 3 } })
    expect(body).toContain("**No findings**")
    expect(line(body)).toBe("- **Verification:** a separate pass checked 3 candidates again and confirmed none; 3 candidates were left out (not confirmed, outside the diff or past the cap)")
  })

  test("verified findings say they were checked and how many candidates the pass judged", () => {
    const body = renderReviewBody({ result: result(), ...base, info: { ...info, checked: 3 } })
    expect(line(body)).toBe("- **Verification:** every finding was checked again by a separate pass (3 candidates judged); 1 candidate was left out (not confirmed, outside the diff or past the cap)")
  })

  test("without the count, no findings claims no check; findings still say they were checked", () => {
    expect(line(renderReviewBody({ result: result({ findings: [], dropped: 0 }), inline: 0, moved: [], info }))).toBe("- **Verification:** nothing was confirmed")
    expect(line(renderReviewBody({ result: result(), ...base }))).toBe("- **Verification:** every finding was checked again by a separate pass; 1 candidate was left out (not confirmed, outside the diff or past the cap)")
  })

  test("a stopped review with nothing verified says nothing is shown instead of claiming a check of what is shown", () => {
    const stop = { kind: "budget" as const, detail: "Budget reached.", unit: "tokens" as const, used: 61_000, limit: 50_000, resumable: true, remaining: "3 candidates not verified" }
    expect(line(renderReviewBody({ result: result({ findings: [], dropped: 3, budgetHit: true }), inline: 0, moved: [], info, stop }))).toBe("- **Verification:** incomplete; 3 candidates not verified; nothing is shown, nothing unverified is published")
    expect(line(renderReviewBody({ result: result({ budgetHit: true }), ...base, stop }))).toBe("- **Verification:** incomplete; 3 candidates not verified; what is shown was checked again by a separate pass, nothing unverified is published")
  })
})

describe("a partial review's body", () => {
  const partial = { reviewed: ["src/a.ts"], notReviewed: ["src/b.ts", "src/c.ts"], unverified: 2, why: "Stopped before part 2 of 3.", number: 23 }
  const body = renderReviewBody({ result: result({ budgetHit: true }), ...base, info: { ...info, partial } })
  const lineOf = (text: string, prefix: string) => text.split("\n").find((entry) => entry.startsWith(prefix))

  test("it says partial first, names what was and was not reviewed, why, and how to ask for the rest", () => {
    expect(body.startsWith("## MendCode partial review\n\n**Partial review** · 1 of 3 files reviewed, 2 candidate findings not verified · 2 verified findings below")).toBe(true)
    expect(body).toContain("Stopped before part 2 of 3.")
    expect(lineOf(body, "**Reviewed:**")).toBe("**Reviewed:** `src/a.ts`")
    expect(lineOf(body, "**Not reviewed:**")).toBe("**Not reviewed:** `src/b.ts`, `src/c.ts`")
    expect(body).toContain("2 candidate findings were found but not verified, so they are not published.")
    expect(body).toContain("`/pr review 23` continues from this checkpoint")
    expect(body).toContain("budget.tokens_per_pr")
    expect(lineOf(body, "- **Verification:**")).toBe("- **Verification:** partial; what is shown was checked again by a separate pass; 2 candidates not verified and not published")
  })

  test("it is not a review of the head: no head marker, and not a MendCode review for another reviewer's stand-down or the dedupe", () => {
    expect(body).not.toContain("mendcode:review head=")
    expect(isMendCodeReview(body)).toBe(false)
    expect(isMendCodeReview(reviewBody({ result: result(), ...base }))).toBe(true)
  })

  test("a template cannot hide the partial verdict", () => {
    const hidden = renderReviewBody({ result: result({ budgetHit: true }), ...base, info: { ...info, partial }, template: template({ sections: [{ id: "verdict", enabled: false }] }) })
    expect(hidden).toContain("**Partial review**")
  })
})
