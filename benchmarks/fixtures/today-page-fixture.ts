import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createTodayState, renderTodayPage, TODAY_TABS, type TodayData } from "../../apps/cli/src/view/today-page"

export const NOW = 1_800_000_000_000
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Fictional demo data: generic project names, no real paths, no personal data. */
export const TODAY_DEMO: TodayData = {
  summary: { lastVisit: NOW - 14 * HOUR, sessionsRan: 6, sessionsFinished: 4, projects: 3, dreamRuns: 1, lastDreamAt: NOW - 6 * HOUR },
  dream: { run: "dream_0412", at: NOW - 6 * HOUR, summary: "Read 12 sessions, saved 2 new memories on its own and left 3 changes for you to decide." },
  attention: [
    {
      id: "a1", kind: "approval", title: "Run db:migrate on staging", project: "shop-api", since: NOW - 2 * HOUR,
      why: "command waiting for your approval",
      explain: "The session asked to run `bun run db:migrate --env staging`. This project asks before shell commands, so it stopped there and has run nothing since.",
      next: "Approve or deny it in the session. Denying lets the agent continue with a dry run.",
      history: [
        { at: NOW - 2 * HOUR, text: "asked to run db:migrate on staging" },
        { at: NOW - 2 * HOUR - 6 * MIN, text: "tests passed, 14 of 14" },
        { at: NOW - 3 * HOUR, text: "wrote migrations/0042_add_coupon_cap.sql" },
      ],
      evidence: ["migrations/0042_add_coupon_cap.sql, 9 lines, adds a nullable column", "permission mode for shop-api: ask"],
      link: { command: "session", ref: "ses_8f3a" },
    },
    {
      id: "a2", kind: "review", title: "Review of fix/coupon-cap has 2 open findings", project: "shop-api", since: NOW - 7 * HOUR,
      why: "reviewer waits for your answer",
      explain: "The review of fix/coupon-cap found three issues. One was fixed by the agent, one is waiting for a decision from you and one is still open.",
      next: "Answer the finding about rounding before the cap, then let the agent re-run the review.",
      history: [
        { at: NOW - 7 * HOUR, text: "review finished with 3 findings" },
        { at: NOW - 6 * HOUR, text: "agent fixed finding 1, the missing cap in the preview" },
      ],
      evidence: ["src/cart/totals.ts:44 rounds before the cap is applied", "test/totals.test.ts has no case for a cap of 0"],
      link: { command: "/reviews", ref: "rev_41" },
    },
    {
      id: "a3", kind: "decision", title: "Choose how a coupon stacks with a sale price", project: "shop-web", since: NOW - 1 * DAY - 3 * HOUR,
      why: "agent stopped on two options",
      explain: "The checkout summary needs one rule for a coupon on an item that is already on sale. The agent described both options and waited instead of picking one.",
      next: "Pick the rule in the session: coupon on the sale price, or coupon on the list price.",
      history: [
        { at: NOW - 1 * DAY - 3 * HOUR, text: "stopped with two options and no choice" },
        { at: NOW - 1 * DAY - 4 * HOUR, text: "read the pricing rules in docs/pricing.md" },
      ],
      evidence: ["docs/pricing.md is silent about sale items", "src/checkout/summary.ts:28 assumes list price"],
      link: { command: "session", ref: "ses_c21d" },
    },
    {
      id: "a4", kind: "contradiction", title: "Two memories name different test runners", project: "shop-api", since: NOW - 4 * DAY,
      why: "two saved memories disagree",
      explain: "One memory says tests run with bun test, another says pnpm vitest. Agents in shop-api follow whichever they read first.",
      next: "Keep the right one and archive the other from the Saved tab in /memory.",
      history: [{ at: NOW - 4 * DAY, text: "the second memory was saved from session ses_0b77" }],
      evidence: ["mem_18 \"Run tests with bun test\"", "mem_52 \"Run tests with pnpm vitest\"", "package.json scripts.test is \"bun test\""],
      link: { command: "/memory", ref: "mem_18, mem_52" },
    },
  ],
  pickup: [
    {
      sessionId: "ses_5d90", title: "Coupon preview endpoint", project: "shop-api", state: "interrupted", leftAt: NOW - 5 * HOUR,
      why: "stopped while the tests were running",
      leftOff: "Wrote src/api/coupons.ts and its test. bun test test/api was running when the session ended.",
      next: "Re-run bun test test/api, then check that the preview rounds the same way as totals().",
      history: [
        { at: NOW - 5 * HOUR, text: "started bun test test/api" },
        { at: NOW - 5 * HOUR - 20 * MIN, text: "wrote test/api/coupons.test.ts" },
        { at: NOW - 6 * HOUR, text: "read src/cart/totals.ts" },
      ],
      evidence: ["2 files changed, 41 additions, not committed", "no test result was recorded"],
      link: { command: "session", ref: "ses_5d90" },
    },
    {
      sessionId: "ses_a410", title: "Rotate backup bucket policy", project: "ops-scripts", state: "blocked", leftAt: NOW - 3 * DAY,
      why: "no credentials for the bucket",
      leftOff: "Drafted the new policy in policy/backup.json. Applying it needs BACKUP_BUCKET, which is not set.",
      next: "Set BACKUP_BUCKET for ops-scripts, then resume. The policy has not been applied anywhere.",
      history: [
        { at: NOW - 3 * DAY, text: "stopped: BACKUP_BUCKET is not set" },
        { at: NOW - 3 * DAY - 25 * MIN, text: "drafted policy/backup.json" },
      ],
      evidence: ["policy/backup.json, 31 lines, not applied", "environment check: BACKUP_BUCKET missing"],
      link: { command: "session", ref: "ses_a410" },
    },
    {
      sessionId: "ses_e3c8", title: "Capped badge in the checkout summary", project: "shop-web", state: "awaiting-review", leftAt: NOW - 1 * DAY,
      why: "done, not reviewed or committed",
      leftOff: "The summary shows a capped badge when the coupon hit its cap. Two files changed and the snapshot tests pass.",
      next: "Review the diff in /changes, then commit or ask for changes.",
      history: [
        { at: NOW - 1 * DAY, text: "finished, snapshot tests pass" },
        { at: NOW - 1 * DAY - 40 * MIN, text: "edited src/checkout/summary.tsx" },
      ],
      evidence: ["2 files changed, 18 additions, 3 deletions", "bun test: 41 passed"],
      link: { command: "/changes", ref: "ses_e3c8" },
    },
    {
      sessionId: "ses_71bf", title: "Update test snapshots after bun upgrade", project: "shop-api", state: "finished", leftAt: NOW - 9 * HOUR,
      why: "finished, changes not reviewed",
      leftOff: "All 41 snapshots were updated. The diff only touches snapshot files.",
      next: "Skim the snapshot diff and commit it, or discard it.",
      history: [{ at: NOW - 9 * HOUR, text: "finished, 41 snapshots updated" }],
      evidence: ["41 files changed, all under test/__snapshots__"],
      link: { command: "/changes", ref: "ses_71bf" },
    },
  ],
  memory: [
    {
      id: "p1", kind: "merge", title: "Merge 3 memories about test data", at: NOW - 6 * HOUR,
      why: "three saved memories say the same thing",
      run: "dream_0412",
      before: ["Tests need fixed dates, not Date.now()", "Use a frozen clock in tests", "Never read the real clock in a test, freeze it"],
      after: "Tests freeze the clock and use fixed dates; never read the real time.",
      next: "Accept the merge in the Pending tab of /memory, or reject it to keep all three.",
      evidence: ["same wording seen in 5 sessions", "the three memories were saved on different days"],
      link: { command: "/memory", ref: "pending" },
    },
    {
      id: "p2", kind: "fix", title: "Fix the dev server port", at: NOW - 6 * HOUR,
      why: "package.json now says another port",
      run: "dream_0412",
      before: ["The dev server runs on localhost:3000"],
      after: "The dev server runs on localhost:4000.",
      next: "Accept the fix in /memory if 4000 is right.",
      evidence: ["package.json scripts.dev uses --port 4000, changed 8 days ago"],
      link: { command: "/memory", ref: "pending" },
    },
    {
      id: "p3", kind: "drop", title: "Drop the staging upload bucket", at: NOW - 6 * HOUR,
      why: "the bucket no longer appears anywhere",
      run: "dream_0412",
      before: ["Uploads in development go to the staging bucket"],
      next: "Archive it from /memory. It stays restorable from the Archived tab.",
      evidence: ["no mention in code or config in 30 days", "last used in a session 6 weeks ago"],
      link: { command: "/memory", ref: "pending" },
    },
  ],
}

if (import.meta.main) {
  const width = Number(process.argv[2] ?? 120)
  const height = Number(process.argv[3] ?? 34)
  const tab = TODAY_TABS[Number(process.argv[4] ?? 0)] ?? "attention"
  const selected = Number(process.argv[5] ?? 0)
  const depth = colorDepth({ COLORTERM: "truecolor" })
  for (const line of renderTodayPage({ data: TODAY_DEMO, state: { ...createTodayState(), tab, selected }, width, height, now: NOW })) {
    let out = ""
    for (const span of line) {
      const style = sgr(span, depth)
      out += style ? `${style}${span.text}\x1b[0m` : span.text
    }
    process.stdout.write(`${out}\n`)
  }
}
