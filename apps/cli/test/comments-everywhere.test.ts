import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { renderMessageActions } from "../src/view/transcript-actions-page"
import { appHarness as extensionHarness, extension, scratch } from "./extensions-harness"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"

/** A message with comments is a card wherever the transcript draws it: a custom user view that knows nothing of comments, the pinned prompt row, the message list. */

afterAll(cleanTemps)
const temporary: Array<ReturnType<typeof scratch>> = []
afterEach(() => { for (const temp of temporary.splice(0)) temp.cleanup() })

const SENT = `<mendcode_comments count="1">
Comments on your answer. Each <comment> has a verbatim <quote> and my comment on it: answer each by number. A <note> is general.

<comment n="1" of="last answer">
<quote>
\`\`\`
Lo que necesito de ti para seguir:
1. T13, la repetición del lote
4. Si traemos verification-skill-example y "Loops You Can Trust".
\`\`\`
</quote>
lo necesitas todo esto ya? o se puede seguir?
</comment>
</mendcode_comments>`
const RAW = /mendcode_comments|<\/?quote>|<\/?comment/

async function withView(body: string, mode: "minimal" | "balanced" | "full" = "balanced") {
  const temp = scratch()
  temporary.push(temp)
  temp.write("data/extensions/look.ts", extension("look", body))
  const h = await extensionHarness({ dataDir: temp.dataDir, directory: temp.project, width: 100, height: 30, mode })
  await h.start({ onboarded: true } as never)
  return h
}

describe("a custom message.user view", () => {
  for (const mode of ["balanced", "full"] as const) {
    test(`that ignores comments leaves the card to the built-in (${mode})`, async () => {
      const h = await withView(`api.view("message.user", (m) => [[{ text: "USER<" + m.text.replace(/\\n/g, " | ") + ">" }]])`, mode)
      h.message(SENT, "ok")
      h.message("plain words", "ok")
      const text = h.text()
      expect(text).not.toMatch(RAW)
      expect(text).toContain("lo necesitas todo esto ya?")
      expect(text).toContain("USER<plain words>")
    })
  }

  test("that reads comments but does not declare them still gets the terminal's card", async () => {
    const h = await withView(`api.view("message.user", (m) => m.comments ? [[{ text: "OWN " + m.comments.comments.length }]] : undefined)`)
    h.message(SENT, "ok")
    expect(h.text()).not.toContain("OWN 1")
    expect(h.text()).toContain("lo necesitas todo esto ya?")
  })

  test("that declares handles: [\"comments\"] draws them its own way", async () => {
    const h = await withView(`api.view("message.user", (m) => m.comments ? [[{ text: "OWN " + m.comments.comments.length }]] : undefined, { handles: ["comments"] })`)
    h.message(SENT, "ok")
    expect(h.text()).toContain("OWN 1")
  })
})

describe("the pinned prompt row", () => {
  test("reads the comment count and the comment, never the tags", () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
    const h = appHarness({ width: 100, height: 30, mode: "balanced", dataDir })
    const script = conversation(h.sessionId, (event) => h.app.onEvent(event))
    script.exchange(SENT, Array.from({ length: 60 }, (_, n) => `line ${n + 1} of the answer`).join("\n\n"))
    h.app.render()
    const rows = h.text()
    expect(rows.join("\n")).not.toMatch(RAW)
    expect(rows.some((row) => row.includes("› 1 comment"))).toBe(true)
  })
})

describe("the message list", () => {
  test("shows a comments message readable in the list and the preview", () => {
    const entry = { kind: "user_message", text: SENT, at: 0, itemId: "i", turnId: "t", anchorId: "i", prompt: SENT, promptImages: [], promptTruncated: false }
    const state = { entries: [entry], selected: 0, loading: false, menu: false, action: 0, scroll: 0, pick: false, backtrack: false } as never
    const rows = renderMessageActions({ state, width: 120, height: 20, now: 1 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(rows).not.toMatch(RAW)
    expect(rows).toContain("lo necesitas todo esto ya?")
  })
})
