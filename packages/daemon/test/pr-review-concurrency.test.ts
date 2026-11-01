import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Settings } from "@mendcode/protocol"
import { classifySetting } from "../src/config-bundle"
import { MAX_CONCURRENT_REVIEWS, MAX_REVIEW_CONCURRENCY, reviewConcurrency } from "../src/pr-review/repo-watch"
import { createPrReviewService } from "../src/pr-review/service"
import { localOnlySettings } from "../src/remote-policy"

/**
 * `prReview.concurrency` (docs/pr-review.md "Concurrency"): a per-device daemon setting, validated by the settings schema, set only
 * on the machine that runs the reviews, read again at every start, and shown by `/pr list` and the dashboard's metrics.
 */

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix))); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

function service(concurrency: () => number | undefined) {
  const checkout = temp("cc-repo-")
  const created = createPrReviewService({
    dir: temp("cc-data-"), intervalMs: 3_600_000, enabled: () => true, graphOn: () => false, concurrency,
    run: async () => ({ code: 1, out: "", err: "no network in this test" }) as never, call: async () => ({ code: 1, out: "" }),
    sessionDirectory: () => checkout, sessionExists: () => true, notify: () => undefined,
    sessions: () => (async () => { throw new Error("no review child in this test") }) as never, editor: () => (async () => { throw new Error("no fix session") }) as never,
    schedule: async (job) => { await job() },
  })
  cleanups.push(() => created.stop())
  return created
}

describe("prReview.concurrency", () => {
  test("the settings schema takes 1 to 4 and refuses 0, 5, a fraction and an unknown key", () => {
    for (const value of [1, 2, 3, 4]) expect(Settings.parse({ prReview: { concurrency: value } }).prReview?.concurrency).toBe(value)
    for (const value of [0, 5, 1.5, -1]) expect(Settings.safeParse({ prReview: { concurrency: value } }).success).toBe(false)
    expect(Settings.safeParse({ prReview: { concurency: 2 } }).success).toBe(false)
    expect(Settings.parse({}).prReview).toBeUndefined()
  })

  test("it describes this machine: a config bundle never applies it elsewhere, and only a local terminal may set it", () => {
    expect(classifySetting("prReview")).toBe("machine")
    expect(localOnlySettings({ prReview: { concurrency: 1 } })).toEqual(["prReview"])
  })

  test("unset is the default of two; a value is clamped to 1 … the scheduler's ceiling", () => {
    expect(reviewConcurrency(undefined)).toBe(MAX_CONCURRENT_REVIEWS)
    expect(reviewConcurrency(1)).toBe(1)
    expect(reviewConcurrency(0)).toBe(1)
    expect(reviewConcurrency(9)).toBe(MAX_REVIEW_CONCURRENCY)
    expect(reviewConcurrency(Number.NaN)).toBe(MAX_CONCURRENT_REVIEWS)
  })

  test("the service reads the setting every time: /pr list and the dashboard's handle show the value as it is now", async () => {
    const setting: { value: number | undefined } = { value: 1 }
    const reviewer = service(() => setting.value)
    const list = async () => { const answer = await reviewer.control({ sessionId: "ses", action: "list" }); return answer.ok ? answer.text : "" }
    expect(await list()).toContain("This device runs at most 1 review or command at once (prReview.concurrency).")
    expect(reviewer.platform.handle.concurrency).toBe(1)
    setting.value = 3
    expect(await list()).toContain("This device runs at most 3 reviews or commands at once (prReview.concurrency).")
    expect(reviewer.platform.handle.concurrency).toBe(3)
    setting.value = undefined
    expect(reviewer.platform.handle.concurrency).toBe(2)
  })
})
