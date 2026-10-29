import { afterEach, expect, test } from "bun:test"
import { b40Harness, B40_REPORT } from "./b40-harness"
import { cleanTemps, NOW } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("B40 release page inspects without checking; keys save channel, check and persist update policy", async () => {
  const h = b40Harness()
  await h.type("/release-channel\r")
  expect(h.sentOf("release.inspect")).toHaveLength(1)
  expect(h.sentOf("release.check")).toHaveLength(0)
  expect(h.text().join("\n")).toContain("stable · saved")
  await h.app.onKey("\x1b[B")
  await h.app.onKey("\r")
  expect(h.report().channel).toBe("beta")
  expect(h.sentOf("release.set").at(-1)).toMatchObject({ channel: "beta" })
  await h.app.onKey("c")
  expect(h.text().join("\n")).toContain("v0.0.2")
  for (const autoupdate of ["notify", true, false]) {
    await h.app.onKey("a")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { autoupdate } })
  }
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).not.toContain("Release channel")
}, 20_000)

test("B40 Tab only completes release-channel; explicit args use the same daemon boundary", async () => {
  const h = b40Harness()
  await h.type("/release-\t")
  expect(h.sentOf("release.inspect")).toHaveLength(0)
  expect(h.sentOf("release.set")).toHaveLength(0)
  await h.app.onKey("\x1b")
  await h.app.onKey("\x15")
  await h.type("/release-channel nightly\r")
  expect(h.report().channel).toBe("nightly")
  await h.app.onKey("\x1b")
  await h.type("/release-channel autoupdate notify\r")
  expect(h.report().autoupdate).toBe("notify")
})

test("B40 remote read-only can inspect, refuses check/channel/policy keys", async () => {
  const h = b40Harness(100, 30, true)
  await h.type("/release-channel\r")
  for (const key of ["c", "a", "\r"]) await h.app.onKey(key)
  expect(h.sentOf("release.inspect")).toHaveLength(1)
  expect(h.sentOf("release.check")).toHaveLength(0)
  expect(h.sentOf("release.set")).toHaveLength(0)
  expect(h.sentOf("settings.set")).toHaveLength(0)
})

test("B40 page fits small/medium/wide grids with header hints and usable compact scrolling", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b40Harness(width, height)
    await h.type("/release-channel\r")
    h.app.render()
    expect(h.text()).toHaveLength(height!)
    expect(h.text().every((row) => textWidth(row) <= width!)).toBe(true)
    expect(h.text()[1]).toContain("esc")
    expect(h.text().join("\n")).toContain("┌─ Release channel")
    if (width! < 70) {
      await h.app.onKey("\x1b[6~")
      await h.app.onKey("\x1b[6~")
      expect(h.text().join("\n")).toContain("Verification")
    }
    await h.app.onKey("\x03")
  }
}, 20_000)

test("B40 errors remain on the release page and update events show availability/restart notification", async () => {
  const h = b40Harness()
  h.setReport({ ...B40_REPORT, recovery: { current: "v0.0.1", previous: "v1.9.9" } })
  await h.type("/release-channel\r")
  expect(h.text().join("\n")).toContain("upgrade --rollback")
  h.error("Release provenance verification failed; install blocked")
  await h.app.onKey("c")
  expect(h.text().join("\n")).toContain("provenance verification failed")
  expect(h.text().join("\n")).toContain("install blocked")
  await h.app.onKey("\x1b")
  h.app.onGlobal({ type: "release.available", version: "v0.0.2", channel: "stable", installed: false, at: NOW, gseq: 1 })
  expect(h.text().join("\n")).toContain("Update v0.0.2")
  h.app.onGlobal({ type: "release.available", version: "v0.0.2", channel: "stable", installed: true, at: NOW, gseq: 2 })
  expect(h.text().join("\n")).toContain("restart MendCode")
})
