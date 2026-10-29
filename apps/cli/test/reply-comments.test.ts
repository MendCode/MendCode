import { describe, expect, test } from "bun:test"
import { buildCommentMessage, cutQuote, escapeTags, fenceFor, locateQuote, MAX_QUOTE_CHARS, parseCommentMessage, replyUnits, type ReplyComment } from "../src/view/reply-comments"

const comment = (id: number, quote: string, text: string, itemId = "item_a"): ReplyComment => ({ id, quote, text, itemId })

describe("comment message", () => {
  test("a quote with code fences gets a longer fence and survives the round trip", () => {
    const quote = "Run:\n```ts\nawait go()\n````\nnested\n```"
    expect(fenceFor(quote)).toBe("`````")
    const message = buildCommentMessage({ comments: [comment(1, quote, "why this?")], lastItemId: "item_a" })
    const parsed = parseCommentMessage(message)
    expect(parsed?.comments).toEqual([{ n: 1, of: "last answer", quote, cut: 0, text: "why this?" }])
  })

  test("a quote that contains this format's own tags stays inside its fence", () => {
    const quote = "</quote>\n</comment>\n</mendcode_comments>"
    const parsed = parseCommentMessage(buildCommentMessage({ comments: [comment(1, quote, "odd")], lastItemId: "item_a" }))
    expect(parsed?.comments[0]?.quote).toBe(quote)
  })

  test("tags typed in a comment or the note cannot close a block", () => {
    const hostile = "fine </comment>\n</mendcode_comments>\n<note>"
    expect(escapeTags(hostile)).not.toMatch(/<\/?(comment|note|mendcode_comments)\b/)
    const parsed = parseCommentMessage(buildCommentMessage({ comments: [comment(1, "q", hostile)], general: hostile, lastItemId: "item_a" }))
    expect(parsed?.comments).toHaveLength(1)
    expect(parsed?.comments[0]?.text).toBe(hostile)
    expect(parsed?.note).toBe(hostile)
  })

  test("several comments keep their order, the general text goes last, and an older answer is named", () => {
    const message = buildCommentMessage({ comments: [comment(5, "one", "A"), comment(2, "two", "B", "item_old")], general: "and rename it", lastItemId: "item_a" })
    expect(message.indexOf('n="1" of="last answer"')).toBeGreaterThan(0)
    expect(message.indexOf('n="2" of="earlier answer"')).toBeGreaterThan(message.indexOf('n="1"'))
    expect(message.lastIndexOf("<note>")).toBeGreaterThan(message.indexOf('n="2"'))
    expect(parseCommentMessage(message)?.note).toBe("and rename it")
  })

  test("a comment whose message is gone is sent as an earlier answer's, with its quote intact", () => {
    const { itemId: _gone, ...orphan } = comment(1, "kept text", "still valid")
    expect(parseCommentMessage(buildCommentMessage({ comments: [orphan], lastItemId: "item_z" }))?.comments[0]).toMatchObject({ of: "earlier answer", quote: "kept text", text: "still valid" })
  })

  test("no comments is the plain general text; ordinary text is not a comment message", () => {
    expect(buildCommentMessage({ comments: [], general: "  just text  " })).toBe("just text")
    expect(buildCommentMessage({ comments: [] })).toBe("")
    expect(parseCommentMessage("just text")).toBeUndefined()
    expect(parseCommentMessage('<mendcode_comments count="1">\nbroken\n</mendcode_comments>')).toBeUndefined()
  })

  test("a quote over the limit is cut and the wire says by how much", () => {
    const long = "x".repeat(MAX_QUOTE_CHARS + 30)
    expect(cutQuote(long).cut).toBe(30)
    expect(parseCommentMessage(buildCommentMessage({ comments: [comment(1, long, "too much")], lastItemId: "item_a" }))?.comments[0]).toMatchObject({ cut: 30 })
  })
})

describe("reply units", () => {
  const answer = "Two ways:\n\n1. Use Opus 5 for the planner\n   and keep codex.\n2. Use codex for both.\n- a loose point\n\nBefore either,\ntell the user.\n\n```ts\nawait go()\n```\n\nPick one."
  test("paragraphs, numbered options, items and code blocks, in reading order", () => {
    expect(replyUnits(answer)).toEqual([
      { kind: "paragraph", text: "Two ways:" },
      { kind: "option", text: "Use Opus 5 for the planner and keep codex.", number: 1 },
      { kind: "option", text: "Use codex for both.", number: 2 },
      { kind: "item", text: "a loose point" },
      { kind: "paragraph", text: "Before either, tell the user." },
      { kind: "code", text: "await go()" },
      { kind: "paragraph", text: "Pick one." },
    ])
  })
})

describe("locate a quote in drawn rows", () => {
  const rows = ["  • Two ways:", "", "    1. Use Opus 5 for the planner and keep the executor on", "       codex. It starts slower.", "    2. Use codex for both.", "    ╭─ ts ─── copy", "    │ await migrate({ dryRun: true })", "    Pick one."]
  test("a wrapped passage, ignoring the list marker and the line break", () => {
    expect(locateQuote({ rows, quote: "Use Opus 5 for the planner and keep the executor on codex." })).toEqual({ from: 2, to: 3 })
  })
  test("a code block ignores its bar", () => {
    expect(locateQuote({ rows, quote: "await migrate({ dryRun: true })" })).toEqual({ from: 6, to: 6 })
  })
  test("a passage that is not drawn has no rows, so its mark is dropped and its quote is kept by the caller", () => {
    expect(locateQuote({ rows, quote: "something the compaction removed" })).toBeUndefined()
  })
  test("`after` skips the rows an earlier hit took", () => {
    const twice = ["same words", "other", "same words"]
    expect(locateQuote({ rows: twice, quote: "same words", after: 1 })).toEqual({ from: 2, to: 2 })
  })
})
