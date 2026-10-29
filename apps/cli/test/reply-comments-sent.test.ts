import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { glyphs, type Line } from "../src/ui/theme"
import { sentRows } from "../src/view/reply-comments-sent"
import { buildCommentMessage, commentsOf, parseCommentMessage, type ReplyComment } from "../src/view/reply-comments"
import { COMMENT_SENT_LAYOUTS, DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { createTranscript } from "../src/view/transcript"
import { lineWidth, textWidth } from "../src/view/wrap"
import { budgetMs } from "../../../scripts/test-budget"

const g = glyphs({})
const style = { layout: "quiet", icon: "", lead: "›", label: "", tint: true } as const
const text = (line: Line) => line.map((span) => span.text).join("")
const comment = (id: number, quote: string, words: string, itemId = "a"): ReplyComment => ({ id, quote, text: words, itemId })
const LAYOUTS = COMMENT_SENT_LAYOUTS
type Layout = (typeof LAYOUTS)[number]

const MAIN = [comment(1, "I help you", "testing"), comment(2, "you with?", "test2"), comment(3, "at can I help y", "test")]
const LONG_QUOTE = "Use Opus 5 for the planner and keep the executor on codex. It starts slower, but the plan is checked once before anything runs, and a failed check stops the batch."
const CODE_QUOTE = "const plan = await migrate({\n  dryRun: true,\n  batch: 200,\n})"
const LONG_WORDS = "This is the part I do not follow: who checks the plan, and what happens to the rows that already moved when the check fails halfway?"
const NINE = Array.from({ length: 9 }, (_, index) => comment(index + 1, `passage number ${index + 1} of the answer`, `words ${index + 1}`))

/** The parts of a sent message as the transcript hands them to the view, with the layout setting and the collapse setting. */
function model(comments: ReplyComment[], note: string, layout: Layout | undefined, collapse = 14) {
  const parsed = parseCommentMessage(buildCommentMessage({ comments, general: note, lastItemId: "a" }))!
  return { ...parsed, ...(layout ? { layout } : {}), collapse }
}
const draw = (comments: ReplyComment[], note: string, layout: Layout | undefined, width: number, expanded = false, collapse = 14) => sentRows({ parsed: model(comments, note, layout, collapse), width, style, expanded }, g)
/** The rows as the text they are, without the tint's padding. */
const plain = (comments: ReplyComment[], note: string, layout: Layout, width: number, expanded = false, collapse = 14) => draw(comments, note, layout, width, expanded, collapse).map((row) => text(row).trimEnd())

describe("every layout", () => {
  for (const layout of LAYOUTS) {
    describe(layout, () => {
      test("keeps every row inside the width at 30, 60, 80 and 120 columns, for one, three and nine comments, long and opened", () => {
        for (const width of [30, 60, 80, 120]) {
          for (const comments of [[MAIN[1]!], MAIN, NINE, [comment(1, LONG_QUOTE, LONG_WORDS), comment(2, CODE_QUOTE, "too big")]]) {
            for (const note of ["", "vez los comentarios? and a longer note that has to wrap at the narrow widths"]) {
              for (const expanded of [false, true]) {
                for (const row of draw(comments, note, layout, width, expanded)) expect(lineWidth(row)).toBeLessThanOrEqual(width)
              }
            }
          }
        }
      })

      test("numbers each quote and its comment as one pair, in order, with the numbers of the chips", () => {
        const rows = plain(NINE, "", layout, 80)
        for (let n = 1; n <= 9; n++) {
          const at = rows.findIndex((row) => new RegExp(`(^|\\s)${n} “passage number ${n} of the answer”`).test(row))
          expect(at).toBeGreaterThanOrEqual(0)
          expect(rows.slice(at, at + 3).join("\n")).toContain(`words ${n}`)
        }
      })

      test("the typed message comes first, as plain text on the lead row, with no label word", () => {
        const rows = plain(MAIN, "vez los comentarios?", layout, 80)
        expect(rows[0]).toBe("› vez los comentarios?")
        expect(rows.join("\n")).not.toMatch(/\bnote\b/)
      })

      test("without a note the lead row starts the block, and without comments nothing is drawn but the text around them", () => {
        expect(plain([MAIN[1]!], "", layout, 80)[0]!.startsWith("› ")).toBe(true)
      })

      test("the message is a role-coloured line, the quote a quote-coloured one, the comment a text-coloured one, the number a bold mark", () => {
        const rows = draw(MAIN, "vez los comentarios?", layout, 80)
        const span = (needle: string) => rows.flat().find((one) => one.text.includes(needle))!
        expect(span("vez los comentarios?")).toMatchObject({ fg: "text" })
        expect(span("“I help you”")).toMatchObject({ fg: "commentQuote" })
        expect(span("testing")).toMatchObject({ fg: "text" })
        expect(rows.flat().filter((one) => one.fg === "commentMark")).toHaveLength(3)
        expect(rows.flat().filter((one) => one.fg === "commentMark").every((one) => one.bold === true)).toBe(true)
        // Theme roles only: nothing is coloured by a literal.
        for (const one of rows.flat()) {
          expect(one.fgHex).toBeUndefined()
          expect(one.bgHex).toBeUndefined()
        }
      })

      test("the user tint covers the whole block, the folded and the opened", () => {
        for (const expanded of [false, true]) for (const row of draw(MAIN, "hello", layout, 60, expanded)) expect(row.every((one) => one.bg === "promptBg")).toBe(true)
      })

      test("a quote is cut to its row with an ellipsis, and the hint to open it is muted and at the right", () => {
        const rows = draw([comment(1, LONG_QUOTE, "slow")], "", layout, 80)
        const shown = rows.map(text)
        expect(shown.some((row) => row.includes("…”"))).toBe(true)
        const hint = shown.findIndex((row) => row.trimEnd().endsWith("ctrl+o quotes"))
        expect(hint).toBeGreaterThanOrEqual(0)
        expect(rows[hint]!.at(-1)).toMatchObject({ text: expect.stringContaining("ctrl+o quotes"), fg: "muted" })
        expect(textWidth(shown[hint]!)).toBe(80)
      })

      test("with nothing to open there is no hint", () => {
        expect(plain(MAIN, "vez los comentarios?", layout, 80).join("\n")).not.toContain("ctrl+o")
        expect(plain(NINE, "", layout, 80).join("\n")).not.toContain("ctrl+o")
      })

      test("a quote that is several lines is a reason to open, and a cut one says by how much when opened", () => {
        expect(plain([comment(1, CODE_QUOTE, "big")], "", layout, 80).join("\n")).toContain("ctrl+o quotes")
        const cut = parseCommentMessage(buildCommentMessage({ comments: [comment(1, "x".repeat(2500), "big")], lastItemId: "a" }))!
        expect(sentRows({ parsed: { ...cut, layout }, width: 60, style, expanded: true }, g).map(text).join("\n")).toContain("more characters not sent")
      })

      test("opened, it shows every line of a quote behind a bar, in full, and drops the hint", () => {
        const rows = plain([comment(1, CODE_QUOTE, "big"), comment(2, LONG_QUOTE, "slow")], "", layout, 60, true)
        const bar = layout === "rail" ? "│" : "┃"
        for (const line of ["const plan = await migrate({", "dryRun: true,", "batch: 200,", "})"]) expect(rows.some((row) => row.includes(`${bar} `) && row.includes(line))).toBe(true)
        // Wrapped behind the bars, the whole quote still reads in order.
        expect(rows.join(" ").replace(/[┃│]/g, " ").replace(/\s+/g, " ")).toContain(LONG_QUOTE)
        expect(rows.join("\n")).not.toContain("ctrl+o")
      })

      test("a long comment wraps with a hanging indent under the first word of the comment", () => {
        const rows = plain([comment(1, "short", LONG_WORDS)], "", layout, 40)
        const first = rows.findIndex((row) => row.includes("This is the"))
        const column = rows[first]!.indexOf("This")
        expect(first).toBeGreaterThan(0)
        const wrapped = rows.slice(first + 1).filter((row) => row.trim() && !row.includes("ctrl+o"))
        expect(wrapped.length).toBeGreaterThan(1)
        for (const row of wrapped) expect(row.slice(0, column).trim() === "" || row.slice(0, column).trim() === "┃" || row.slice(0, column).trim() === "→").toBe(true)
      })

      test("a comment on an older answer carries an arrow after its number and the count says so", () => {
        const older = parseCommentMessage(buildCommentMessage({ comments: [comment(1, "old passage", "was this", "b"), comment(2, "new passage", "and this", "a")], lastItemId: "a" }))!
        const rows = sentRows({ parsed: { ...older, layout }, width: 80, style, expanded: false }, g).map(text)
        expect(rows.join("\n")).toMatch(/1↑ “old passage”/)
        expect(rows.join("\n")).not.toMatch(/2↑/)
      })

      test("text before and after the comments is kept, muted", () => {
        const wrapped = `@src/a.ts selected\n\n${buildCommentMessage({ comments: MAIN, general: "go", lastItemId: "a" })}\n\nthanks`
        const parsed = { ...commentsOf(wrapped).comments!, layout }
        const rows = sentRows({ parsed, width: 80, style, expanded: false }, g)
        expect(rows.map(text).join("\n")).toContain("@src/a.ts selected")
        expect(rows.map(text).join("\n")).toContain("thanks")
        expect(rows.flat().find((one) => one.text.includes("thanks"))).toMatchObject({ fg: "muted" })
      })

      test("an unstyled message (no tint, an icon and a label) keeps the lead on the first row and aligns the rest under it", () => {
        const rows = sentRows({ parsed: model(MAIN, "hi", layout), width: 60, style: { layout: "quiet", icon: "◆", lead: "›", label: "me", tint: false }, expanded: false }, g).map(text)
        expect(rows[0]!.startsWith("◆ › me hi")).toBe(true)
        expect(rows.slice(1).every((row) => row.startsWith("       "))).toBe(true)
      })
    })
  }
})

describe("rail", () => {
  test("the count line sits under the message and the pairs hang from a rail, the hint on the count line", () => {
    const rows = plain([comment(1, LONG_QUOTE, "slow"), comment(2, "short", "ok")], "check it", "rail", 80)
    expect(rows[0]).toBe("› check it")
    expect(rows[1]).toMatch(/^ {2}2 comments +ctrl\+o quotes$/)
    expect(rows[2]!.startsWith("  ┃ 1 “")).toBe(true)
    expect(rows[3]).toBe("  ┃   slow")
    expect(rows[4]).toBe("  ┃ 2 “short”")
  })

  test("with no message the count line takes the lead", () => {
    expect(plain(MAIN, "", "rail", 80).slice(0, 2)).toEqual(["› 3 comments", "  ┃ 1 “I help you”"])
    expect(plain([MAIN[0]!], "", "rail", 80)[0]).toBe("› 1 comment")
  })

  test("the rail is drawn in the comment rule role, the count muted", () => {
    const rows = draw(MAIN, "hi", "rail", 80)
    expect(rows[2]!.find((one) => one.text === "┃ ")).toMatchObject({ fg: "commentRule" })
    expect(rows[1]!.find((one) => one.text === "3 comments")).toMatchObject({ fg: "muted" })
  })
})

describe("stack", () => {
  test("a blank row separates the message from the pairs, which hang at its column", () => {
    expect(plain(MAIN, "vez los comentarios?", "stack", 80)).toEqual(["› vez los comentarios?", "", "  1 “I help you”", "    testing", "  2 “you with?”", "    test2", "  3 “at can I help y”", "    test"])
  })

  test("the hint goes on the last row when it fits, with the count, else on a row of its own", () => {
    const beside = plain([comment(1, LONG_QUOTE, "slow")], "", "stack", 80)
    expect(beside.at(-1)).toMatch(/^ {4}slow +1 comment · ctrl\+o quotes$/)
    const own = plain([comment(1, LONG_QUOTE, "this comment fills its whole row so the hint cannot ride on it at all")], "", "stack", 60)
    expect(own.at(-1)!.trim()).toMatch(/ctrl\+o quotes$/)
    expect(own.at(-2)).not.toContain("ctrl+o")
  })
})

describe("inline", () => {
  test("a pair is one row while it fits, the arrows lined up, and the pairs sit two cells in under a message", () => {
    expect(plain(MAIN, "vez los comentarios?", "inline", 80)).toEqual(["› vez los comentarios?", "    1 “I help you”      → testing", "    2 “you with?”       → test2", "    3 “at can I help y” → test"])
    expect(plain(MAIN, "", "inline", 80)[0]).toBe("› 1 “I help you”      → testing")
  })

  test("a pair that does not fit takes two rows: the quote, then the comment behind an arrow with a hanging indent", () => {
    const rows = plain([comment(1, "short quote", LONG_WORDS)], "", "inline", 50)
    expect(rows[0]).toBe("› 1 “short quote”")
    expect(rows[1]!.startsWith("    → This is the part")).toBe(true)
    expect(rows[2]!.startsWith("      ")).toBe(true)
  })

  test("a quote keeps at least the collapse setting's cells on the row, else the pair takes two", () => {
    const quote = "a quote of exactly thirty chars"
    const words = "twenty-some chars of words"
    // 56 cells of room after the lead and the number: 3 for the arrow and 26 for the words leave 27 for a 33-cell quote.
    const kept = plain([comment(1, quote, words)], "", "inline", 60, false, 14)
    expect(kept[0]).toMatch(/^› 1 “a quote of exactly .*…” → twenty-some chars of words$/)
    const wanted = plain([comment(1, quote, words)], "", "inline", 60, false, 40)
    expect(wanted[0]).toBe("› 1 “a quote of exactly thirty chars”")
    expect(wanted[1]).toBe("    → twenty-some chars of words")
  })

  test("the key hint stays even when the arrows do not line up", () => {
    const rows = plain([comment(1, LONG_QUOTE, "slow"), comment(2, "short", "ok")], "", "inline", 80)
    expect(rows.join("\n")).toContain("ctrl+o quotes")
  })
})

describe("the setting reaches the view", () => {
  test("the model carries the layout and the collapse, and the default is the rail", () => {
    expect(commentsOf(buildCommentMessage({ comments: MAIN, lastItemId: "a" }), { layout: "inline", collapse: 20 }).comments).toMatchObject({ layout: "inline", collapse: 20 })
    expect(commentsOf(buildCommentMessage({ comments: MAIN, lastItemId: "a" })).comments?.layout).toBeUndefined()
    expect(DEFAULT_TUI_PROFILE.commentSentLayout).toBe("rail")
    expect(plain(MAIN, "", "rail", 80)).toEqual(draw(MAIN, "", undefined, 80).map((row) => text(row).trimEnd()))
  })
})

describe("in the transcript", () => {
  const ids = createIdFactory()
  const sessionId = ids("session")
  function transcriptOf(messages: string[], layout?: Layout) {
    const t = createTranscript({ appearance: { ...(layout ? { commentSentLayout: layout } : {}) } })
    let seq = 0
    const push = (event: Record<string, unknown>) => t.apply({ sessionId, seq: ++seq, at: 0, ...event } as SessionEvent)
    const turnId = ids("turn")
    push({ type: "turn.started", turnId, queueId: ids("queue") })
    for (const message of messages) {
      const itemId = ids("item")
      push({ type: "item.started", turnId, itemId, kind: "user_message" })
      push({ type: "item.completed", itemId, status: "ok", text: message })
    }
    return t
  }
  const envelope = buildCommentMessage({ comments: MAIN, general: "vez los comentarios?", lastItemId: "a" })
  const rowsOf = (t: ReturnType<typeof transcriptOf>, width = 80) => t.viewport(width, 20, 0).map((row) => row.text.trimEnd()).filter(Boolean)

  test("each layout setting draws its own form, and the stored text is the envelope in all of them", () => {
    const forms = LAYOUTS.map((layout) => rowsOf(transcriptOf([envelope], layout)).join("\n"))
    expect(new Set(forms).size).toBe(3)
    for (const form of forms) {
      expect(form).toContain("vez los comentarios?")
      expect(form).not.toContain("<mendcode_comments")
    }
    expect(transcriptOf([envelope]).blocks()[0]!.text).toBe(envelope)
  })

  test("changing the setting redraws the block", () => {
    const t = transcriptOf([envelope], "rail")
    const before = rowsOf(t).join("\n")
    t.setAppearance({ ...DEFAULT_TUI_PROFILE, commentSentLayout: "inline", reasoning: "auto", toolOutput: "auto" })
    expect(rowsOf(t).join("\n")).not.toBe(before)
    expect(rowsOf(t).join("\n")).toContain("→ testing")
  })

  test("commentFolded off draws the envelope as the text it is, whatever the layout", () => {
    const t = createTranscript({ appearance: { commentFolded: false, commentSentLayout: "inline" } })
    const turnId = ids("turn")
    t.apply({ sessionId, seq: 1, at: 0, type: "turn.started", turnId, queueId: ids("queue") } as SessionEvent)
    const itemId = ids("item")
    t.apply({ sessionId, seq: 2, at: 0, type: "item.started", turnId, itemId, kind: "user_message" } as SessionEvent)
    t.apply({ sessionId, seq: 3, at: 0, type: "item.completed", itemId, status: "ok", text: envelope } as SessionEvent)
    expect(rowsOf(t).join("\n")).toContain('<comment n="1" of="last answer">')
  })

  test("a plain message is not touched by the setting", () => {
    for (const layout of LAYOUTS) expect(rowsOf(transcriptOf(["just a message"], layout))).toEqual(rowsOf(transcriptOf(["just a message"])))
  })

  test("drawn rows are kept: scrolling over 400 sent messages re-parses nothing and costs numbers, not layouts", () => {
    const t = transcriptOf(Array.from({ length: 400 }, () => envelope))
    const first = t.viewport(80, 40, 0)
    const again = t.viewport(80, 40, 0)
    expect(again.every((row, index) => row === first[index])).toBe(true)
    const start = performance.now()
    for (let offset = 0; offset < 200; offset++) t.viewport(80, 40, offset * 2)
    expect((performance.now() - start) / 200).toBeLessThan(budgetMs(2))
  })

  test("ctrl+o opens the quotes of every sent message and the hint goes away", () => {
    const long = buildCommentMessage({ comments: [comment(1, LONG_QUOTE, "slow")], lastItemId: "a" })
    const t = transcriptOf([long], "rail")
    expect(rowsOf(t).join("\n")).toContain("ctrl+o quotes")
    t.toggleTools()
    const opened = rowsOf(t).join("\n")
    expect(opened).toContain("failed check stops the batch.")
    expect(opened).not.toContain("ctrl+o")
  })
})

describe("the narrow end", () => {
  test("a width below the number column and a rail still draws something that fits", () => {
    for (const layout of LAYOUTS) for (const width of [8, 12, 20]) for (const row of draw(MAIN, "hi", layout, width)) expect(textWidth(text(row))).toBeLessThanOrEqual(width)
  })
})
