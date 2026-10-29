import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

/** A compaction turn whose summary item carries `meta`, as the native engine reports it. */
function packed(width: number, height: number, meta: Record<string, string | number | boolean>) {
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/mendcode" })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  const turnId = ids("turn"), itemId = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue"), at: NOW - 1000 })
  chat.emit({ type: "compaction.updated", turnId, reason: "manual", state: "writing", followUp: "" })
  chat.emit({ type: "item.started", turnId, itemId, kind: "compaction", meta: { compactionMethod: "legacy", tailTurns: 2, tailTokens: 248, ...meta } })
  chat.emit({ type: "item.completed", itemId, status: "ok", text: "## Goal\n\nKeep the latest constraint." })
  chat.emit({ type: "compaction.updated", turnId, reason: "manual", state: "packed", followUp: "" })
  chat.emit({ type: "turn.completed", turnId })
  return h
}

for (const [width, height] of [[60, 20], [100, 30]] as const) test(`a summary read through the cached prefix says so on the memory stage of /compaction at ${width}x${height}`, async () => {
  const h = packed(width, height, { cachedPrefix: true })
  expect(h.app.transcript.compactions()[0]).toMatchObject({ method: "legacy", cachedPrefix: true })
  await h.type("/compaction\r")
  expect(h.text().join("\n")).toContain("Memory · legacy")
  expect(h.text().join("\n")).toContain("repeats the cached prefix")
  expect(h.text().every((line) => textWidth(line) <= width)).toBe(true)
})

test("a compaction that sent its own request shows the memory stage as before", async () => {
  const h = packed(100, 30, { cachedPrefixOff: "too-large" })
  expect(h.app.transcript.compactions()[0]).not.toHaveProperty("cachedPrefix")
  await h.type("/compaction\r")
  expect(h.text().join("\n")).toContain("Memory · legacy")
  expect(h.text().join("\n")).not.toContain("cached prefix")
})
