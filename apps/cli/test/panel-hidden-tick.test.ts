import { afterAll, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { chat, settle } from "./file-viewer-helpers"

afterAll(cleanTemps)

test("a panel hidden behind an open file stops its clock: no frame a second for cards nobody sees", async () => {
  const { h } = await chat({ width: 220, height: 50, tier: "full", profile: { rightSidebar: true, sidebarWidgets: [{ type: "clock", options: {} }] } })
  h.app.render()
  // Shown: the clock ticks once a second.
  let before = h.frames.length
  await Bun.sleep(1_150)
  expect(h.frames.length).toBeGreaterThan(before)
  await h.type("/open src/app.rs\r")
  await settle()
  h.app.render()
  expect(h.text().join("\n")).toContain("app.rs")
  expect(h.text().join("\n")).not.toContain("Clock")
  // A second after the last frame that drew it, the panel counts as hidden and its tick stops.
  await Bun.sleep(2_100)
  before = h.frames.length
  await Bun.sleep(1_200)
  expect(h.frames.length).toBe(before)
}, 15_000)
