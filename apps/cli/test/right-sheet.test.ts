import { afterAll, expect, test } from "bun:test"
import { ui4Harness } from "./ui-4-harness"
import { cleanTemps, ids, NOW } from "./session-ui-harness"
import { SIDEBAR_PRESETS } from "../src/view/sidebar-spec"
import { textWidth } from "../src/view/wrap"

afterAll(cleanTemps)

test("by default a terminal under 110 columns hides the panel and gives the chat its rows back; widening brings it back", async () => {
  const h = ui4Harness(100, 30, structuredClone(SIDEBAR_PRESETS.pulse), "hide")
  await Bun.sleep(5)
  h.chat.exchange("Latest request", "LATEST ANSWER")
  h.app.render()
  expect(h.text().join("\n")).not.toContain("/panel")
  expect(h.text().join("\n")).toContain("LATEST ANSWER")
  h.size.width = 180
  h.app.render()
  expect(h.text().join("\n")).toContain("/panel")
})

for (const [width, height] of [[60, 20], [100, 30], [180, 50]]) {
  test(`pulse preserves the latest answer and prompt at ${width}x${height}`, async () => {
    const h = ui4Harness(width, height, structuredClone(SIDEBAR_PRESETS.pulse))
    await Bun.sleep(5)
    h.chat.exchange("Latest request", "LATEST ANSWER")
    await h.type("next prompt")
    const rows = h.text()
    expect(rows.join("\n")).toContain("LATEST ANSWER")
    expect(rows.join("\n")).toContain("next prompt")
    expect(rows).toHaveLength(height)
    expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
    expect(rows[h.cursors.at(-1)!.row]).toContain("next prompt")
    await h.type("\x15")

    const turnId = ids("turn")
    const requestId = ids("request")
    h.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    h.chat.emit({ type: "server.request", requestId, turnId, kind: "approval", title: "Run command", detail: "APPROVAL DETAIL" })
    h.app.render()
    expect(h.text().join("\n")).toContain("APPROVAL DETAIL")
    const approvalRow = h.text().findIndex((row) => row.includes("Allow once"))
    expect(approvalRow).toBeGreaterThanOrEqual(0)
    await h.type(`\x1b[<0;${h.text()[approvalRow]!.indexOf("Allow once") + 1};${approvalRow + 1}M`)
    expect(h.sentOf("request.resolve").at(-1)).toMatchObject({ requestId, decision: { kind: "approve" } })
    h.chat.emit({ type: "server.request.resolved", requestId })
    h.chat.emit({ type: "usage.limit", turnId, state: "scheduled", provider: "faux", message: "limit", resetsAt: NOW + 3_600_000 })
    h.app.render()
    expect(h.text().join("\n")).toContain("resume at reset (armed)")
    const cancelRow = h.text().findIndex((row) => row.includes("CANCEL"))
    expect(cancelRow).toBeGreaterThanOrEqual(0)
    await h.type(`\x1b[<0;${h.text()[cancelRow]!.indexOf("CANCEL") + 1};${cancelRow + 1}M`)
    expect(h.sentOf("usage.limit").at(-1)).toMatchObject({ action: "cancel" })
  })
}

test("the collapsed side chat keeps its cursor in its own prompt and the main answer visible", async () => {
  const h = ui4Harness(100, 30)
  await h.type("/btw question\r")
  await h.type("\x1d")
  await h.type("side draft")
  expect(h.text().join("\n")).toContain("Main answer")
  expect(h.text()[h.cursors.at(-1)!.row]).toContain("side draft")
  // The cursor is the cell after the last character typed, not the character itself.
  const cursor = h.cursors.at(-1)!
  expect(textWidth(h.text()[cursor.row]!.slice(0, h.text()[cursor.row]!.indexOf("side draft") + "side draft".length))).toBe(cursor.col)
  expect(h.text()).toHaveLength(30)
})

test("the 60x20 pulse sheet exposes its retained Agent card when scrolled", async () => {
  const h = ui4Harness(60, 20, structuredClone(SIDEBAR_PRESETS.pulse))
  await Bun.sleep(5)
  h.app.render()
  expect(h.text().join("\n")).toContain("PgUp/PgDn scroll")
  await h.type("\x1b}")
  await h.type("\x1b[6~")
  expect(h.text().join("\n")).toContain("Billing")
  expect(h.text().join("\n")).toContain("Subscription")
  expect(h.text()).toHaveLength(20)
})
