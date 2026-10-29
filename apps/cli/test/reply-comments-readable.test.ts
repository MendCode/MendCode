import { describe, expect, test } from "bun:test"
import { buildCommentDraft, buildCommentMessage, readableText, type ReplyComment } from "../src/view/reply-comments"
import { firstPlainLine } from "../src/view/history-page"
import { renderDraftsPage } from "../src/view/stash-page"
import { buildTree } from "../src/view/session-tree"
import { createTreeState, settle } from "../src/view/session-tree-keys"
import { renderTreePage } from "../src/view/session-tree-page"
import { plain } from "./session-ui-harness"

const COMMENTS: ReplyComment[] = [
  { id: 1, quote: "Use Opus 5 for the planner.\nIt starts slower.", text: "too slow, skip it", itemId: "item_1" },
  { id: 2, quote: "await migrate({ dryRun: true })", text: "keep dryRun on" },
]
const MESSAGE = buildCommentMessage({ comments: COMMENTS, general: "go with codex", lastItemId: "item_1" })

describe("an envelope in history, drafts and search reads as text", () => {
  test("the model sees a plain, labelled message (what other clients and headless runs get)", () => {
    expect(MESSAGE).toContain("<mendcode_comments")
    expect(MESSAGE).toContain("too slow, skip it")
    expect(MESSAGE).toContain("go with codex")
    expect(MESSAGE).toContain("Use Opus 5 for the planner.")
  })

  test("readableText turns a whole message into lines and a cut preview into one", () => {
    const whole = readableText(MESSAGE)
    expect(whole).toContain("2 comments")
    expect(whole).toContain("> Use Opus 5 for the planner. It starts slower.")
    expect(whole).toContain("too slow, skip it")
    expect(whole).toContain("note: go with codex")
    expect(whole).not.toContain("<")
    expect(readableText(MESSAGE, { quotes: false })).not.toContain("> Use Opus")
    const preview = MESSAGE.replace(/\s+/g, " ").slice(0, 160)
    const short = readableText(preview)
    expect(short).toContain("2 comments")
    expect(short).not.toContain("<")
    expect(readableText("plain words")).toBe("plain words")
    expect(readableText("a <mendcode_comments mention")).toBe("a <mendcode_comments mention")
  })

  test("the history list shows the first readable line, not the tag", () => {
    expect(firstPlainLine(MESSAGE)).toBe("2 comments · too slow, skip it")
  })

  test("the drafts page shows how many comments a draft holds", () => {
    const text = buildCommentDraft({ comments: COMMENTS, draft: "half a thought", parked: true, lastItemId: "item_1", limit: 65_536 })
    const rows = renderDraftsPage([{ sessionId: "session_1", title: "Migration", chars: text.length, attachments: 0, preview: text.replace(/\s+/g, " ").slice(0, 160), updatedAt: 1 }], { selected: 0 }, 2, 120, 20).map(plain).join("\n")
    expect(rows).toContain("2 comments")
    expect(rows).not.toContain("<mendcode_comments")
  })

  test("the tree shows the comments, not the envelope", () => {
    const entries = [{ turnId: "turn_1", itemId: "item_9", at: 1, preview: MESSAGE.replace(/\s+/g, " ").slice(0, 120), reverted: false }] as never
    const model = buildTree({ sessionId: "session_1" as never, entries, nodes: undefined, title: "Migration" })
    const rows = renderTreePage({ model, state: settle(createTreeState(), model), width: 120, height: 20, now: 5 }).map(plain).join("\n")
    expect(rows).toContain("2 comments")
    expect(rows).not.toContain("<mendcode_comments")
  })
})
