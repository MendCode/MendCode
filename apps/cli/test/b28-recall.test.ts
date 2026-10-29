import { afterEach, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { sessionRecallCard } from "../src/view/session-recall-card"
import { textWidth } from "../src/view/wrap"
import { b28Harness } from "./b28-harness"
import { cleanTemps, plain } from "./session-ui-harness"

afterEach(cleanTemps)

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
  test(`B28 app draws real recall results and revisions within ${width}x${height}`, async () => {
    const harness = await b28Harness("session_notes", { action: "read" }, { width, height })
    try {
      expect(harness.result.isError).toBe(false)
      const text = harness.text().join("\n")
      expect(text).toContain("Session notes · v1")
      expect(text).toContain("Decision: preserve the project boundary.")
      expect(text).not.toContain('"current_version"')
      expect(harness.frames.at(-1)).toHaveLength(height)
      for (const row of harness.text()) {
        expect(textWidth(row)).toBeLessThanOrEqual(width)
        expect(row).not.toContain("\x1b")
      }
      if (width >= 100) expect(text).toContain("┌─ Session notes")
      else expect(text).not.toContain("┌─ Session notes")
    } finally { await harness.type("\x03"); harness.history.store.close(); rmSync(harness.history.dir, { recursive: true, force: true }) }
  })
}

test("B28 transcript errors show disabled recall and stale revision without hiding the prompt", async () => {
  for (const options of [{ disabled: true }, {}]) {
    const harness = await b28Harness("session_notes", { action: "write", version: 0, text: "Stale" }, { width: 100, height: 30, ...options })
    try {
      expect(harness.result.isError).toBe(true)
      expect(harness.text().join("\n")).toContain(options.disabled ? "Session recall is disabled" : "current version 1")
      expect(harness.frames.at(-1)).toHaveLength(30)
      expect(harness.text().some((row) => row.includes("›") || row.includes("❯"))).toBe(true)
    } finally { await harness.type("\x03"); harness.history.store.close(); rmSync(harness.history.dir, { recursive: true, force: true }) }
  }
})

test("B28 cards adapt long Unicode text, revision metadata and older-page cursors", () => {
  const page = { session_id: "ses_example", messages: [{ message_id: "itm_example", role: "assistant", text: "漢字 🙂 ".repeat(200), truncated: true }], more: true, next_cursor: "itm_example" }
  for (const width of [42, 96, 176]) {
    const rows = sessionRecallCard({ name: "session_search", text: JSON.stringify(page), width, expanded: true, failed: false })!
    expect(rows.map(plain).join("\n")).toContain("Before itm_example")
    for (const row of rows) expect(textWidth(plain(row))).toBeLessThanOrEqual(width)
  }
  const notes = sessionRecallCard({ name: "session_notes", text: JSON.stringify({ version: 1, current_version: 2, text: "Earlier notes" }), width: 96, expanded: true, failed: false })!
  expect(notes.map(plain).join("\n")).toContain("current v2")
  expect(sessionRecallCard({ name: "session_notes", text: "null", width: 96, expanded: true, failed: false })).toBeUndefined()
  expect(sessionRecallCard({ name: "other", text: "{}", width: 96, expanded: true, failed: false })).toBeUndefined()
})

test("B28 notes preserve line breaks and expose the full body with Ctrl+O", async () => {
  const notes = { version: 1, current_version: 1, text: "Decision: preserve the project boundary.\n\nNext: verify the daemon and client." }
  const rows = sessionRecallCard({ name: "session_notes", text: JSON.stringify(notes), width: 96, expanded: false, failed: false })!.map(plain)
  expect(rows.findIndex((row) => row.includes("Next:")) - rows.findIndex((row) => row.includes("Decision:"))).toBe(2)
  const harness = await b28Harness("session_notes", { action: "read" }, { width: 100, height: 30, long: true })
  try {
    expect(harness.text().join("\n")).toContain("more lines")
    expect(harness.app.transcript.toolsExpanded).toBe(false)
    await harness.type("\x0f")
    expect(harness.app.transcript.toolsExpanded).toBe(true)
    expect(harness.text().join("\n")).not.toContain("more lines")
    await harness.type("\x0f")
    expect(harness.text().join("\n")).toContain("more lines")
  } finally { await harness.type("\x03"); harness.history.store.close(); rmSync(harness.history.dir, { recursive: true, force: true }) }
})
