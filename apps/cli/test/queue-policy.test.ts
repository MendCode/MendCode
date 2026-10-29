import { afterEach, expect, test } from "bun:test"
import { createSettingsPageState, SETTINGS_GROUPS, settingsPageKey } from "../src/view/settings-page"
import { renderQueuePanel } from "../src/view/queue-panel"
import { textWidth } from "../src/view/wrap"
import { b51Harness } from "./b51-harness"
import { appHarness, cleanTemps, NOW } from "./session-ui-harness"

afterEach(cleanTemps)

test("/queue Tab only completes; Enter persists an explicit mode and live changes update the panel", async () => {
  const h = b51Harness()
  await h.type("/que\t")
  expect(h.app.editor.text).toBe("/queue ")
  expect(h.sentOf("settings.set")).toHaveLength(0)
  await h.type("after-tools\r")
  expect(h.sentOf("settings.set")).toEqual([{ type: "settings.set", patch: { queue: { mode: "after-tools" } } }])
  expect(h.text().join("\n")).toContain("After tools")
  await h.type("/queue after-turn\r")
  expect(h.sentOf("settings.set")).toHaveLength(1)
  expect(h.text().join("\n")).toContain("usage: /queue")
  h.app.onGlobal({ type: "settings.changed", gseq: 2, at: NOW, settings: { queue: { mode: "immediate" } } })
  expect(h.text().join("\n")).toContain("Sending")
})

test("/queue reads daemon state and a failed write reports the actual error", async () => {
  const h = appHarness({ reply: (command) => command.type === "settings.get" ? { ok: true, result: { settings: { queue: { mode: "after-tools" } } } } : command.type === "settings.set" ? { ok: false, error: { code: "invalid_command", message: "Queue change rejected" } } : undefined })
  await h.type("/queue\r")
  // Bare /queue opens the manager, whose header shows the daemon's policy.
  expect(h.text().join("\n")).toContain("queue: after-tools")
  await h.app.onKey("\x1b")
  await h.type("/queue immediate\r")
  expect(h.text().join("\n")).toContain("Queue change rejected")
})

test("/settings cycles queue policy without changing prior row order", () => {
  const row = SETTINGS_GROUPS.flatMap((group) => group.rows).findIndex((row) => row.id === "queue")
  const state = { ...createSettingsPageState(), row }
  const values = { settings: {}, theme: "mend", view: "balanced", reducedMotion: false }
  expect(settingsPageKey(state, "\x1b[C", values, { themes: ["mend"] }).action).toEqual({ type: "set", patch: { queue: { mode: "after-tools" } } })
  expect(settingsPageKey(state, "\x1b[D", values, { themes: ["mend"] }).action).toEqual({ type: "set", patch: { queue: { mode: "immediate" } } })
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`queue panel and chip coordinates fit ${width}x${height}`, async () => {
  const h = b51Harness(width, height, "after-tools", true)
  h.app.render()
  const rows = h.text()
  expect(rows).toHaveLength(height)
  expect(rows.every((line) => textWidth(line) <= width && !/[\x00-\x1f]/.test(line))).toBe(true)
  expect(rows.join("\n")).toContain("Held")
  expect(rows.join("\n")).toContain("$ git status")
  const at = rows.findIndex((row) => row.includes("↗ SEND"))
  expect(at).toBeGreaterThan(0)
  const col = rows[at]!.indexOf("SEND")
  await h.app.onKey(`\x1b[<0;${col + 1};${at + 1}M`)
  expect(h.sentOf("queue.promote").at(-1)).toMatchObject({ queueId: h.first })
  await h.app.onKey("\x0b")
  expect(h.sentOf("queue.remove").at(-1)).toMatchObject({ queueId: h.last })
})

test("queue header has key hints above a bordered panel and hides itself when empty", () => {
  expect(renderQueuePanel({ width: 100, previews: [], held: false })).toEqual({ rows: [] })
  const panel = renderQueuePanel({ width: 100, previews: ["first", "second", "third", "fourth"], held: false })
  const rows = panel.rows.map((line) => line.map((span) => span.text).join(""))
  expect(rows[0]).toContain("ctrl+s send now · ctrl+k drop last")
  expect(rows[1]).toContain("┌")
  expect(rows.at(-1)).toContain("┘")
  expect(rows.join("\n")).toContain("+1 more")
  expect(panel.sendChip?.row).toBe(rows.findIndex((row) => row.includes("SEND")))
})
