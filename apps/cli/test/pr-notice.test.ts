import { expect, test } from "bun:test"
import { glyphSet } from "../src/ui/theme"
import { userRows } from "../src/view/message-views"
import { renderQueuePanel } from "../src/view/queue-panel"
import { isPrNotice, noticeSpans, shortenJobs } from "../src/view/pr-notice"

const JOB = "prj_mw10dbjub573e874f568"
const model = (text: string, width: number) => ({ itemId: "i", turnId: "t", text, mode: "balanced", style: {}, variant: "notice", images: 0, username: "u", expanded: false, width }) as never
const links = (rows: ReturnType<typeof userRows>) => rows.flatMap((row) => row.filter((span) => span.link).map((span) => [span.text, span.link]))
const plain = (rows: ReturnType<typeof userRows>) => rows.map((row) => row.map((span) => span.text).join(""))

test("a PR review notice links the pull request, and a review named after it links into it", () => {
  const rows = userRows(model("PR review of Eden-sudo/Symbex-1#22: published (posted review 987654 with 2 comments)", 100), glyphSet("unicode"))
  expect(links(rows)).toEqual([
    ["Eden-sudo/Symbex-1#22", "https://github.com/Eden-sudo/Symbex-1/pull/22"],
    ["987654", "https://github.com/Eden-sudo/Symbex-1/pull/22#pullrequestreview-987654"],
  ])
})

test("a waiting command notice shows the job by its tail and hints how to open it, at 80 columns", () => {
  const text = `@mendcode review from Eden-sudo on Eden-sudo/Symbex-1#22 waits: job ${JOB} reviews this head now; the comment is answered by that review.\nfull details`
  const rows = plain(userRows(model(text, 80), glyphSet("unicode"))).map((row) => row.trimEnd())
  const flat = rows.join(" ").replace(/\s+/g, " ")
  expect(flat).toContain("job …e874f568 reviews this head now")
  expect(flat).toContain("/reviews open e874f568")
  expect(flat).not.toContain(JOB)
  expect(rows.every((row) => row.length <= 80)).toBe(true)
  expect(links(userRows(model(text, 80), glyphSet("unicode")))[0]).toEqual(["Eden-sudo/Symbex-1#22", "https://github.com/Eden-sudo/Symbex-1/pull/22"])
})

test("other notices are left as they are", () => {
  expect(isPrNotice("[background task done] see /tmp/a/b#3")).toBe(false)
  expect(links(userRows(model("[background task done] a/b#3", 80), glyphSet("unicode")))).toEqual([])
  expect(noticeSpans("PR review of a/b#1: published", {}).map((span) => span.text).join("")).toBe("PR review of a/b#1: published")
})

test("the queue keeps the end of a PR notice readable by showing the job short", () => {
  const preview = `@mendcode review from Eden on a/b#22 waits: job ${JOB} reviews this head now`
  const queued = (width: number) => renderQueuePanel({ previews: [preview], width, held: false, paused: false } as never).rows.map((row) => row.map((span) => span.text).join("")).join("\n")
  expect(shortenJobs(preview)).toContain("job …e874f568 reviews")
  expect(queued(100)).toContain("@mendcode review a/b#22 waits: job …e874f568")
  expect(queued(100)).not.toContain("prj_")
  expect(queued(80)).toContain("@mendcode review a/b#22 waits")
})
