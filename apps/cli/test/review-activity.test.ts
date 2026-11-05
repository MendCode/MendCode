import { beforeAll, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { createIdFactory, type GlobalEvent, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { loadReviewActivity } from "../src/ui/lazy-pages"
import { glyphs, type Line } from "../src/ui/theme"
import { reviewFooterWord, reviewPhase, type ReviewActivityJob } from "../src/view/review-activity"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const SEC = 1_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function harness(options: { width?: number; height?: number; mode?: "balanced" | "minimal" } = {}) {
  const frames: Line[][] = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const app = createApp({
    sessionId, screen, directory: "/work/app", exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => NOW, random: () => 0, mode: options.mode ?? "balanced",
    send: (async () => ({ ok: true })) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: NOW, ...patch } as SessionEvent)
  const text = () => frames.at(-1)!.map(plain)
  const global = (event: Record<string, unknown>) => { app.onGlobal({ gseq: 0, at: NOW, ...event } as unknown as GlobalEvent); app.render() }
  const note = (words: string) => {
    const turnId = ids("turn")
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    const itemId = ids("item")
    ev({ type: "item.started", turnId, itemId, kind: "agent_message" })
    ev({ type: "item.completed", itemId, status: "ok", text: words })
    ev({ type: "turn.completed", turnId })
    app.render()
  }
  return { app, text, global, note, sessionId, stop: () => app.dispose?.() }
}

const running = (sessionId: string, patch: Partial<ReviewActivityJob> = {}): ReviewActivityJob => ({
  jobId: "prj_1", sessionId: sessionId as never, repo: "Eden-sudo/Symbex-1", number: 25, phase: "analysis", startedAt: NOW - 80 * SEC,
  steps: [
    { label: "Fetching #25", detail: "head 51fe4047", startedAt: NOW - 80 * SEC, endedAt: NOW - 76 * SEC },
    { label: "Readers", detail: "32 files · gpt-6-luna", startedAt: NOW - 76 * SEC, endedAt: NOW - 60 * SEC },
    { label: "Analysis", detail: "112 files · incremental", startedAt: NOW - 60 * SEC },
  ],
  ...patch,
})

describe("a PR review at work", () => {
  // The view loads with the first activity that has a job (lazy-pages.ts); these cases draw it at once.
  beforeAll(() => loadReviewActivity())
  test("the watching session shows the steps as tool rows and the activity status with the PR, phase and time", () => {
    const h = harness()
    h.note("Watching Eden-sudo/Symbex-1.")
    h.global({ type: "pr.review.activity", jobs: [running(h.sessionId)] })
    const screen = h.text().join("\n")
    expect(screen).toContain("Review Fetching #25 · head 51fe4047")
    expect(screen).toContain("Review Readers · 32 files · gpt-6-luna")
    expect(screen).toContain("Review Analysis · 112 files · incremental")
    expect(screen).toContain("Reviewing Eden-sudo/Symbex-1#25 · analysis")
    expect(screen).toContain("1m 20s")
    // The steps sit right over the activity status, finished ones first.
    const rows = h.text()
    const analysis = rows.findIndex((row) => row.includes("Review Analysis"))
    const status = rows.findIndex((row) => row.includes("Reviewing Eden-sudo/Symbex-1#25"))
    expect(rows.findIndex((row) => row.includes("Review Fetching"))).toBeLessThan(analysis)
    expect(analysis).toBeLessThan(status)
    if (process.env.CAPTURE_DIR) writeFileSync(`${process.env.CAPTURE_DIR}/watch-session-running-100x30.txt`, rows.join("\n"))

    // The run ends: the rows and the status go, and the final note the daemon records is what stays.
    h.global({ type: "pr.review.activity", jobs: [] })
    h.note("PR review of Eden-sudo/Symbex-1#25: no findings.")
    const after = h.text().join("\n")
    expect(after).not.toContain("Review Analysis")
    expect(after).not.toContain("Reviewing Eden-sudo")
    expect(after).toContain("PR review of Eden-sudo/Symbex-1#25: no findings.")
    if (process.env.CAPTURE_DIR) writeFileSync(`${process.env.CAPTURE_DIR}/watch-session-done-100x30.txt`, h.text().join("\n"))
  })

  test("another session only names the review in its footer; its own transcript and status are untouched", () => {
    const h = harness()
    h.note("Working on something else.")
    h.global({ type: "pr.review.activity", jobs: [running("ses_watch")] })
    const screen = h.text().join("\n")
    expect(screen).toContain("reviewing Symbex-1#25")
    expect(screen).not.toContain("Review Analysis")
    expect(screen).not.toContain("Reviewing Eden-sudo")
    if (process.env.CAPTURE_DIR) writeFileSync(`${process.env.CAPTURE_DIR}/other-session-footer-100x30.txt`, h.text().join("\n"))
    h.global({ type: "pr.review.activity", jobs: [] })
    expect(h.text().join("\n")).not.toContain("reviewing Symbex-1#25")
  })

  test("the words: one review, several, and none elsewhere", () => {
    const one = running("ses_a")
    const two = running("ses_b", { jobId: "prj_2", number: 23, repo: "Eden-sudo/Symbex-1", phase: "corroboration" })
    expect(reviewFooterWord([one, two], "ses_c")).toBe("reviewing Symbex-1#25 +1")
    expect(reviewFooterWord([one], "ses_a")).toBeUndefined()
    expect(reviewPhase([two])).toBe("Reviewing Eden-sudo/Symbex-1#23 · corroboration...")
  })
})
