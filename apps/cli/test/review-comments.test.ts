import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChangedFile, ChangesReport } from "@mendcode/protocol"
import { changesPageKey, changesReviewSent, createChangesPageState, renderChangesPage, type ChangesPageAction, type ChangesPageState } from "../src/view/changes-page"
import {
  createComment,
  locateComment,
  locationLabel,
  MAX_COMMENTS,
  normalizeComments,
  parseDiffRows,
  readReviewComments,
  reviewsPath,
  reviewTarget,
  writeReviewComments,
  type ReviewComment,
} from "../src/view/review-comments"
import { reviewMessage } from "../src/view/review-message"
import type { Line } from "../src/ui/theme"
import { textWidth } from "../src/view/wrap"

const DIFF = `@@ -10,4 +10,5 @@ function a() {
 context one
-removed line
+added line one
+added line two
 context two
@@ -40,2 +41,2 @@ function b() {
-old b
+new b`

const file = (input: Partial<ChangedFile> & { path: string }): ChangedFile => ({ status: "modified", additions: 0, deletions: 0, binary: false, diff: "", truncated: false, ...input })
const report = (files: ChangedFile[]): ChangesReport => ({ root: "/repo", branch: "main", files, omittedFiles: 0 })
const sample = report([
  file({ path: "src/a.ts", additions: 3, deletions: 2, diff: DIFF }),
  file({ path: "src/b.ts", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-one\n+two" }),
  file({ path: "logo.png", binary: true }),
])

const NOW = 1_800_000_000_000
const text = (line: Line) => line.map((span) => span.text).join("")

/** Feeds keys one by one; returns the last state and the last non-none action. */
function press(start: ChangesPageState, keys: string[], data: ChangesReport = sample, page = 10) {
  let state = start
  let action: ChangesPageAction = { type: "none" }
  for (const key of keys) {
    const result = changesPageKey(state, key, data, page, NOW)
    state = result.state
    if (result.action.type !== "none") action = result.action
  }
  return { state, action }
}
const typed = (value: string) => [...value]
const inDiff = () => ({ ...createChangesPageState(), focus: "diff" as const })
const dirs: string[] = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-review-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("diff rows and targets", () => {
  const rows = parseDiffRows(DIFF.split("\n"))

  test("rows carry hunk index and old/new line numbers", () => {
    expect(rows.map((row) => [row.kind, row.hunk, row.old, row.new])).toEqual([
      ["hunk", 0, undefined, undefined],
      ["context", 0, 10, 10],
      ["del", 0, 11, undefined],
      ["add", 0, undefined, 11],
      ["add", 0, undefined, 12],
      ["context", 0, 12, 13],
      ["hunk", 1, undefined, undefined],
      ["del", 1, 40, undefined],
      ["add", 1, undefined, 41],
    ])
  })

  test("a line target names its new line, a removed line its old line, a mixed range both", () => {
    const added = reviewTarget({ path: "src/a.ts", rows, from: 3, to: 3 })
    expect(added).toMatchObject({ kind: "line", hunk: 0, header: "@@ -10,4 +10,5 @@ function a() {", excerpt: ["+added line one"], newRange: { from: 11, to: 11 } })
    expect(added.oldRange).toBeUndefined()
    const removed = reviewTarget({ path: "src/a.ts", rows, from: 2, to: 2 })
    expect(removed).toMatchObject({ excerpt: ["-removed line"], oldRange: { from: 11, to: 11 } })
    expect(removed.newRange).toBeUndefined()
    const mixed = reviewTarget({ path: "src/a.ts", rows, from: 4, to: 2 })
    expect(mixed).toMatchObject({ excerpt: ["-removed line", "+added line one", "+added line two"], newRange: { from: 11, to: 12 }, oldRange: { from: 11, to: 11 } })
  })

  test("a lone hunk header, or hunk: true, targets the whole hunk", () => {
    const header = reviewTarget({ path: "src/a.ts", rows, from: 6, to: 6 })
    expect(header).toMatchObject({ kind: "hunk", hunk: 1, excerpt: ["@@ -40,2 +41,2 @@ function b() {", "-old b", "+new b"], newRange: { from: 41, to: 41 } })
    const inside = reviewTarget({ path: "src/a.ts", rows, from: 4, to: 4, hunk: true })
    expect(inside).toMatchObject({ kind: "hunk", hunk: 0 })
    expect(inside.excerpt).toHaveLength(6)
  })

  test("a file without rows is commented as a file", () => {
    expect(reviewTarget({ path: "logo.png", rows: [], from: 0, to: 0 })).toEqual({ path: "logo.png", kind: "file", hunk: -1, header: "", excerpt: [] })
  })

  test("labels: new lines, old lines, both, hunk and file", () => {
    const make = (from: number, to: number, hunk = false) => createComment({ target: reviewTarget({ path: "src/a.ts", rows, from, to, hunk }), body: "x", now: NOW })
    expect(locationLabel(make(3, 4))).toBe("src/a.ts:11-12")
    expect(locationLabel(make(3, 3))).toBe("src/a.ts:11")
    expect(locationLabel(make(2, 2))).toBe("src/a.ts:old 11")
    expect(locationLabel(make(2, 4))).toBe("src/a.ts:11-12, old 11")
    expect(locationLabel(make(7, 7, true))).toBe("src/a.ts hunk @@ -40,2 +41,2 @@")
    expect(locationLabel(createComment({ target: reviewTarget({ path: "logo.png", rows: [], from: 0, to: 0 }), body: "x", now: NOW }))).toBe("logo.png")
  })

  test("a comment is found again by its code, wherever the diff moved it", () => {
    const made = createComment({ target: reviewTarget({ path: "src/a.ts", rows, from: 3, to: 4 }), body: "x", now: NOW })
    expect(locateComment(made, rows)).toEqual({ start: 3, end: 4 })
    const shifted = parseDiffRows(["@@ -1,1 +1,2 @@", "+new first", ...DIFF.split("\n")])
    expect(locateComment(made, shifted)).toEqual({ start: 5, end: 6 })
    expect(locateComment(made, parseDiffRows(["@@ -1 +1 @@", "-x", "+y"]))).toBeUndefined()
  })
})

describe("comment keys", () => {
  test("c on a line opens the box, typing fills it and enter saves a line comment", () => {
    const { state } = press(inDiff(), ["j", "j", "j", "c"])
    expect(state).toMatchObject({ mode: "compose", cursor: 3 })
    const saved = press(state, [...typed("Why add this?"), "\r"]).state
    expect(saved.mode).toBe("browse")
    expect(saved.notice).toBe("comment added")
    expect(saved.comments).toHaveLength(1)
    expect(saved.comments[0]).toMatchObject({ path: "src/a.ts", kind: "line", hunk: 0, body: "Why add this?", excerpt: ["+added line one"], newRange: { from: 11, to: 11 }, createdAt: NOW })
  })

  test("C comments the whole hunk the cursor is in, and c on a header does too", () => {
    const hunk = press(inDiff(), ["j", "j", "C", ...typed("split"), "\r"]).state
    expect(hunk.comments[0]).toMatchObject({ kind: "hunk", hunk: 0, body: "split" })
    expect(hunk.comments[0]!.excerpt).toHaveLength(6)
    const header = press(inDiff(), [..."jjjjjj", "c", ...typed("second"), "\r"]).state
    expect(header.comments[0]).toMatchObject({ kind: "hunk", hunk: 1 })
  })

  test("v or shift+arrows select rows and c comments the selection", () => {
    const viaV = press(inDiff(), ["j", "j", "v", "j", "j"])
    expect(viaV.state).toMatchObject({ anchor: 2, cursor: 4 })
    const saved = press(viaV.state, ["c", ...typed("three rows"), "\r"]).state
    expect(saved.comments[0]).toMatchObject({ kind: "line", excerpt: ["-removed line", "+added line one", "+added line two"], newRange: { from: 11, to: 12 }, oldRange: { from: 11, to: 11 } })
    expect(saved.anchor).toBeNull()
    const viaShift = press(inDiff(), ["j", "\x1b[1;2B", "\x1b[1;2B", "c"])
    expect(viaShift.state).toMatchObject({ mode: "compose", anchor: 1, cursor: 3 })
    expect(viaShift.state.target?.excerpt).toEqual([" context one", "-removed line", "+added line one"])
  })

  test("esc drops a selection first and only then leaves the page", () => {
    const selecting = press(inDiff(), ["v", "j"]).state
    expect(changesPageKey(selecting, "\x1b", sample).state.anchor).toBeNull()
    expect(changesPageKey(selecting, "\x1b", sample).action.type).toBe("none")
    expect(changesPageKey(inDiff(), "\x1b", sample).action.type).toBe("close")
  })

  test("esc cancels a comment in the making and an empty one is refused", () => {
    const composing = press(inDiff(), ["j", "c", ...typed("draft")]).state
    expect(composing.draft).toBe("draft")
    expect(press(composing, ["\x1b"]).state).toMatchObject({ mode: "browse", draft: "", comments: [] })
    const empty = press(inDiff(), ["j", "c", "  ", "\r"]).state
    expect(empty).toMatchObject({ mode: "compose", notice: "comment is empty · esc cancels" })
  })

  test("typing supports backspace, ctrl+u, ctrl+w, alt+enter and pasted text", () => {
    const base = press(inDiff(), ["j", "c"]).state
    expect(press(base, [...typed("abc"), "\x7f"]).state.draft).toBe("ab")
    expect(press(base, [...typed("abc"), "\x15"]).state.draft).toBe("")
    expect(press(base, [...typed("one two"), "\x17"]).state.draft).toBe("one ")
    expect(press(base, [...typed("a"), "\x1b\r", ...typed("b")]).state.draft).toBe("a\nb")
    expect(press(base, ["pasted text\r\nsecond"]).state.draft).toBe("pasted text\nsecond")
    expect(press(base, ["\x1b[A", "\x07"]).state.draft).toBe("")
  })

  test("the review holds at most MAX_COMMENTS comments", () => {
    const full = Array.from({ length: MAX_COMMENTS }, (_, index) => createComment({ target: reviewTarget({ path: "src/a.ts", rows: parseDiffRows(DIFF.split("\n")), from: 1, to: 1 }), body: `c${index}`, now: NOW + index }))
    const state = { ...inDiff(), comments: full }
    expect(press(state, ["c"]).state.notice).toContain("review is full")
  })

  test("e edits and d deletes the comment under the cursor", () => {
    const made = press(inDiff(), ["j", "j", "j", "c", ...typed("first"), "\r"]).state
    const editing = press(made, ["e"]).state
    expect(editing).toMatchObject({ mode: "compose", draft: "first", editing: made.comments[0]!.id })
    const edited = press(editing, ["\x15", ...typed("second"), "\r"]).state
    expect(edited.comments.map((entry) => entry.body)).toEqual(["second"])
    expect(edited.comments[0]!.id).toBe(made.comments[0]!.id)
    expect(press(edited, ["d"]).state.comments).toEqual([])
    expect(press({ ...edited, cursor: 0 }, ["d"]).state.notice).toBe("no comment on this row")
  })

  test("L lists the comments: arrows select, e edits, d deletes, X twice clears, enter opens the row", () => {
    const one = press(inDiff(), ["j", "j", "j", "c", ...typed("first"), "\r"]).state
    const both = press({ ...one, cursor: 0 }, [..."jjjjjjj", "c", ...typed("second"), "\r"]).state
    expect(both.comments.map((entry) => entry.body)).toEqual(["first", "second"])
    const list = press(both, ["L"]).state
    expect(list).toMatchObject({ mode: "list", listIndex: 0 })
    expect(press(list, ["j"]).state.listIndex).toBe(1)
    expect(press(list, ["j", "j"]).state.listIndex).toBe(1)
    const opened = press(list, ["j", "\r"]).state
    expect(opened).toMatchObject({ mode: "browse", cursor: 7, selected: 0, focus: "diff" })
    const edited = press(list, ["e", "\x15", ...typed("changed"), "\r"]).state
    expect(edited.comments.map((entry) => entry.body)).toEqual(["changed", "second"])
    const deleted = press(list, ["d"]).state
    expect(deleted.comments.map((entry) => entry.body)).toEqual(["second"])
    expect(press(deleted, ["d"]).state).toMatchObject({ comments: [], mode: "browse" })
    const once = press(list, ["X"]).state
    expect(once).toMatchObject({ confirmClear: true, notice: "press X again to clear the whole review" })
    expect(once.comments).toHaveLength(2)
    expect(press(once, ["j", "X"]).state.comments).toHaveLength(2)
    expect(press(once, ["X"]).state).toMatchObject({ comments: [], mode: "browse", notice: "review cleared" })
    expect(press(list, ["\x1b"]).state.mode).toBe("browse")
    expect(press(createChangesPageState(), ["L"]).state.notice).toBe("no comments yet · c adds one")
  })
})

describe("navigation keys", () => {
  test("] and [ move between hunks", () => {
    const first = press(inDiff(), ["]"]).state
    expect(first.cursor).toBe(6)
    expect(press(first, ["]"]).state.notice).toBe("last hunk")
    expect(press(first, ["j", "["]).state.cursor).toBe(6)
    expect(press(first, ["["]).state.cursor).toBe(0)
    expect(press(inDiff(), ["["]).state.notice).toBe("first hunk")
  })

  test("n and p move between files and reset the cursor", () => {
    const moved = press(inDiff(), ["j", "j", "n"]).state
    expect(moved).toMatchObject({ selected: 1, cursor: 0, scroll: 0 })
    expect(press(moved, ["p"]).state.selected).toBe(0)
    expect(press(moved, ["n", "n", "n"]).state.selected).toBe(2)
  })

  test("l jumps to a line number: the new side first, then the old side; unknown lines say so", () => {
    const asked = press(inDiff(), ["l"]).state
    expect(asked.mode).toBe("jump")
    expect(press(asked, [..."12", "\r"]).state).toMatchObject({ mode: "browse", cursor: 4 })
    expect(press(asked, [..."40", "\r"]).state.cursor).toBe(7)
    expect(press(asked, [..."999", "\r"]).state).toMatchObject({ mode: "browse", notice: "line 999 is not in this diff", cursor: 0 })
    expect(press(asked, ["a", "b", "1"]).state.draft).toBe("1")
    expect(press(asked, ["1", "\x7f"]).state.draft).toBe("")
    expect(press(asked, ["\x1b"]).state.mode).toBe("browse")
    expect(press({ ...createChangesPageState(), selected: 2 }, ["l"]).state.notice).toBe("no lines to jump to")
  })

  test("g and G go to the first and last row and scroll with them", () => {
    const end = press(inDiff(), ["G"], sample, 4).state
    expect(end).toMatchObject({ cursor: 8, scroll: 5 })
    expect(press(end, ["g"], sample, 4).state).toMatchObject({ cursor: 0, scroll: 0 })
  })

  test("page keys scroll and keep the cursor inside the window", () => {
    const down = press(inDiff(), ["\x1b[6~"], sample, 4).state
    expect(down).toMatchObject({ scroll: 4, cursor: 4 })
    expect(press(down, ["\x1b[5~"], sample, 4).state).toMatchObject({ scroll: 0, cursor: 3 })
  })

  test("the cursor stays inside the diff even when the report shrank", () => {
    const small = report([file({ path: "src/a.ts", diff: "@@ -1 +1 @@\n+x" })])
    expect(press({ ...inDiff(), cursor: 50, scroll: 50 }, ["j"], small).state.cursor).toBe(1)
  })
})

describe("persistence", () => {
  const made = (body: string, from = 3) => createComment({ target: reviewTarget({ path: "src/a.ts", rows: parseDiffRows(DIFF.split("\n")), from, to: from }), body, now: NOW })

  test("comments are kept in <dataDir>/tui/reviews/<sessionId>.json and read back", () => {
    const dir = tmp()
    const comments = [made("one"), made("two", 4)]
    expect(writeReviewComments(dir, "session_abc123", comments)).toEqual({ ok: true })
    const file = path.join(dir, "tui", "reviews", "session_abc123.json")
    expect(reviewsPath(dir, "session_abc123")).toBe(file)
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ version: 1, sessionId: "session_abc123" })
    expect(readReviewComments(dir, "session_abc123")).toEqual(comments)
    expect(readReviewComments(dir, "session_other")).toEqual([])
  })

  test("an empty review removes the file, and a broken or hostile file reads as empty", () => {
    const dir = tmp()
    writeReviewComments(dir, "s1", [made("one")])
    expect(writeReviewComments(dir, "s1", [])).toEqual({ ok: true })
    expect(fs.existsSync(reviewsPath(dir, "s1"))).toBe(false)
    fs.mkdirSync(path.dirname(reviewsPath(dir, "s1")), { recursive: true })
    fs.writeFileSync(reviewsPath(dir, "s1"), "{ not json")
    expect(readReviewComments(dir, "s1")).toEqual([])
    expect(reviewsPath(dir, "../../etc/passwd")).toBe(path.join(dir, "tui", "reviews", "______etc_passwd.json"))
  })

  test("normalizing drops entries that are not comments and caps the list", () => {
    const good = made("keep")
    const list = normalizeComments({ comments: [good, { id: "x" }, null, 7, { ...good, id: "b", body: "  " }, { ...good, id: "c", kind: "weird" }, { ...good }] })
    expect(list).toEqual([good])
    expect(normalizeComments([])).toEqual([])
    expect(normalizeComments({ comments: Array.from({ length: 100 }, (_, index) => ({ ...good, id: `id${index}` })) })).toHaveLength(MAX_COMMENTS)
  })

  test("the session's file is what the page state starts from, and sending empties it", () => {
    const dir = tmp()
    const comments = [made("one")]
    writeReviewComments(dir, "s1", comments)
    const state = createChangesPageState(readReviewComments(dir, "s1"))
    expect(state.comments).toEqual(comments)
    expect(changesReviewSent(state)).toMatchObject({ comments: [], notice: "review sent", mode: "browse" })
  })
})

describe("send review", () => {
  const rows = parseDiffRows(DIFF.split("\n"))
  const at = (from: number, to: number, body: string, path = "src/a.ts", hunk = false): ReviewComment =>
    createComment({ target: reviewTarget({ path, rows, from, to, hunk }), body, now: NOW + from })

  test("the message is the exact review context v1's tag wraps: file, line range, diff excerpt and comment", () => {
    const message = reviewMessage({ comments: [at(2, 4, "Why drop this?\nAnd why twice?"), at(6, 6, "Split this hunk", "src/b.ts")], branch: "main" })
    expect(message).toBe(
      [
        "<mendcode_review_context>",
        "MendCode review workspace:",
        "- Comments: 2 on 2 files (branch main)",
        "",
        "1. user comment src/a.ts:11-12, old 11",
        "   ```diff",
        "   -removed line",
        "   +added line one",
        "   +added line two",
        "   ```",
        "   comment: Why drop this?",
        "            And why twice?",
        "2. user comment src/b.ts hunk @@ -40,2 +41,2 @@",
        "   ```diff",
        "   @@ -40,2 +41,2 @@ function b() {",
        "   -old b",
        "   +new b",
        "   ```",
        "   comment: Split this hunk",
        "</mendcode_review_context>",
      ].join("\n"),
    )
  })

  test("a file comment has no excerpt; no comments is no message", () => {
    const file = createComment({ target: reviewTarget({ path: "logo.png", rows: [], from: 0, to: 0 }), body: "Is the new logo final?", now: NOW })
    expect(reviewMessage({ comments: [file] })).toBe(["<mendcode_review_context>", "MendCode review workspace:", "- Comments: 1 on 1 file", "", "1. user comment logo.png", "   comment: Is the new logo final?", "</mendcode_review_context>"].join("\n"))
    expect(reviewMessage({ comments: [] })).toBe("")
  })

  test("a big review shrinks its excerpts to stay under the message limit", () => {
    const big = parseDiffRows(["@@ -1,60 +1,60 @@", ...Array.from({ length: 60 }, (_, index) => `+${"x".repeat(200)}${index}`)])
    const comments = Array.from({ length: 50 }, (_, index) => createComment({ target: reviewTarget({ path: `f${index}.ts`, rows: big, from: 1, to: 60 }), body: "b".repeat(500), now: NOW + index }))
    const message = reviewMessage({ comments })
    expect(message.length).toBeLessThanOrEqual(60_000)
    expect(message).toStartWith("<mendcode_review_context>")
    expect(message).toEndWith("</mendcode_review_context>")
    expect(message.match(/comment: b+/g)).toHaveLength(50)
  })

  test("s sends the review as one action and keeps the comments until the app clears them", () => {
    const made = press(inDiff(), ["j", "j", "j", "c", ...typed("Why add this?"), "\r", "n", "j", "c", ...typed("rename"), "\r"]).state
    expect(made.comments).toHaveLength(2)
    const sent = changesPageKey(made, "s", sample, 10, NOW)
    expect(sent.action).toMatchObject({ type: "send", count: 2 })
    const action = sent.action as Extract<ChangesPageAction, { type: "send" }>
    expect(action.text).toBe(reviewMessage({ comments: made.comments, branch: "main" }))
    expect(action.text).toContain("1. user comment src/a.ts:11\n   ```diff\n   +added line one\n   ```\n   comment: Why add this?")
    expect(action.text).toContain("2. user comment src/b.ts:old 1\n   ```diff\n   -one\n   ```\n   comment: rename")
    expect(sent.state.comments).toHaveLength(2)
    expect(changesReviewSent(sent.state).comments).toEqual([])
    expect(changesPageKey(createChangesPageState(), "s", sample).state.notice).toBe("no comments to send")
  })
})

describe("render", () => {
  const made = press(inDiff(), ["j", "j", "j", "c", ...typed("Why add this line?"), "\r"]).state

  test("a comment shows under its row, the file row counts it and the title says how many", () => {
    const rows = renderChangesPage({ report: sample, state: made, width: 100, height: 24 }).map(text)
    const at = rows.findIndex((row) => row.includes("+added line one"))
    expect(at).toBeGreaterThan(0)
    expect(rows[at + 1]).toContain("◆ Why add this line?")
    expect(rows.find((row) => row.includes("3 files"))).toContain("3 files +4 −3 · 1 comment")
    const files = renderChangesPage({ report: sample, state: { ...made, focus: "files" }, width: 100, height: 24 }).map(text)
    expect(files.find((row) => row.includes("src/a.ts"))).toContain("◆1")
  })

  test("the cursor row is tinted only while the diff has focus, and a selection tints every row", () => {
    const tinted = (state: ChangesPageState) =>
      renderChangesPage({ report: sample, state, width: 100, height: 24 })
        .filter((line) => line.some((span) => span.bg === "element" && span.text.trim() !== "" && !["Files", "Diff"].some((tab) => span.text.includes(tab))))
        .map(text)
    expect(tinted({ ...made, cursor: 4 }).filter((row) => row.includes("added line two"))).toHaveLength(1)
    expect(tinted({ ...made, focus: "files", cursor: 4 }).filter((row) => row.includes("added line two"))).toHaveLength(0)
    expect(tinted({ ...made, cursor: 4, anchor: 2 }).filter((row) => /removed line|added line one|added line two/.test(row))).toHaveLength(3)
  })

  test("the box, the line prompt and the list take the diff's place with their own hints", () => {
    const composing = renderChangesPage({ report: sample, state: press(inDiff(), ["j", "c", ...typed("hel")]).state, width: 100, height: 24 }).map(text)
    expect(composing.some((row) => row.includes("Comment · src/a.ts:10"))).toBe(true)
    expect(composing.some((row) => row.includes("hel█"))).toBe(true)
    expect(composing.join("\n")).toContain("enter save")
    const jumping = renderChangesPage({ report: sample, state: press(inDiff(), ["l", "4"]).state, width: 100, height: 24 }).map(text)
    expect(jumping.some((row) => row.includes("Go to line: 4█"))).toBe(true)
    const listing = renderChangesPage({ report: sample, state: press(made, ["L"]).state, width: 100, height: 24 }).map(text)
    expect(listing.some((row) => row.includes("Review comments · 1"))).toBe(true)
    expect(listing.some((row) => row.includes("src/a.ts:11") && row.includes("Why add this line?"))).toBe(true)
    expect(listing.join("\n")).toContain("X clear all")
  })

  test("a comment whose code is gone is counted as outdated and listed as such", () => {
    const gone = report([file({ path: "src/a.ts", diff: "@@ -1 +1 @@\n-x\n+y" })])
    const rows = renderChangesPage({ report: gone, state: made, width: 100, height: 24 }).map(text)
    expect(rows.some((row) => row.includes("1 outdated comment · L lists them"))).toBe(true)
    const listing = renderChangesPage({ report: gone, state: press(made, ["L"]).state, width: 100, height: 24 }).map(text)
    expect(listing.some((row) => row.includes("(outdated)"))).toBe(true)
  })

  test.each([[60, 20], [100, 24], [120, 30], [160, 40]])("every mode fits exactly %ix%i", (width, height) => {
    const states = [made, press(made, ["j", "c", ...typed("typing a longer comment that wraps across the small box ".repeat(3))]).state, press(made, ["L"]).state, press(made, ["l", "1"]).state, press(made, ["]", "v", "j", "\x1b[1;2B"]).state]
    for (const state of states) {
      const lines = renderChangesPage({ report: sample, state, width, height })
      expect(lines).toHaveLength(height)
      for (const line of lines) expect(textWidth(text(line))).toBeLessThanOrEqual(width)
    }
  })

  test("the cursor stays visible when wrapped lines and comments push it down", () => {
    const long = report([file({ path: "a.ts", diff: `@@ -1,9 +1,9 @@\n${Array.from({ length: 9 }, (_, index) => `+${"word ".repeat(30)}${index}`).join("\n")}` })])
    const state = { ...inDiff(), cursor: 6, scroll: 0 }
    const lines = renderChangesPage({ report: long, state, width: 60, height: 14 })
    const tintedRow = lines.find((line) => line.some((span) => span.bg === "element" && span.text.includes("word") && !span.text.includes("Diff")))
    expect(tintedRow).toBeDefined()
  })

  test("the 100-column page with a comment, row by row", () => {
    const rows = renderChangesPage({ report: sample, state: made, width: 100, height: 24 }).map((line) => text(line).trimEnd())
    expect(rows).toHaveLength(24)
    expect(rows[0]).toStartWith(" Changes · branch main")
    expect(rows[0]).toContain("s send")
    expect(rows[1]!.trim()).toBe("3 files +4 −3 · 1 comment")
    const at = rows.findIndex((row) => row.includes("+added line one"))
    expect(rows.slice(at - 2, at + 4).map((row) => row.split("│")[3]!.trimEnd())).toEqual([" 10 10  context one", " 11    -removed line", "    11 +added line one", "       ◆ Why add this line?", "    12 +added line two", " 12 13  context two"])
  })
})
