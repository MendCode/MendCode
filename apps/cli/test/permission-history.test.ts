import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, NOW, tempDir } from "./session-ui-harness"
import { permissionHistoryFixture } from "./permission-history-fixture"
import { permissionsPageKey, renderPermissionsPage } from "../src/view/permissions-page"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("permissions history opens from the app, selects causal reviews and refreshes revoked grants", async () => {
  let revoked = false
  const h = appHarness({ width: 100, height: 30, dataDir: tempDir(), reply(command) {
    const history = permissionHistoryFixture(h.sessionId, NOW)
    if (revoked) history.grants[0] = { ...history.grants[0]!, active: false, revokedAt: NOW }
    if (command.type === "permissions.list") return { ok: true, result: { grants: revoked ? [] : [history.grants[0]!.grant] } }
    if (command.type === "permissions.history") return { ok: true, result: history }
    if (command.type === "permissions.revoke") { revoked = true; return { ok: true, result: { revoked: 1 } } }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true })
  await h.type("/permissions\r")
  expect(h.sentOf("permissions.history")).toHaveLength(1)
  await h.type("h")
  expect(h.text().join("\n")).toContain("Permissions · History")
  expect(h.text().join("\n")).toContain("user:local-check")
  expect(h.text().join("\n")).toContain("Frozen env")
  await h.type("j")
  expect(h.text().join("\n")).toContain("User approved")
  await h.type("h")
  await h.type("r")
  await h.type("h")
  expect(h.text().join("\n")).toContain("shell · revoked · now")
  expect(h.sentOf("permissions.history")).toHaveLength(2)
  await h.app.onKey("\x1b")
  expect(h.app.page).toBe("chat")
  await h.app.onKey("\x03")
})

test("history panels fit contracted sizes and compact history remains scrollable", () => {
  const h = appHarness({ dataDir: tempDir() })
  const history = permissionHistoryFixture(h.sessionId, NOW)
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
    const render = (scroll = 0) => renderPermissionsPage({ mode: "smart", grants: [], history, reviewer: { kind: "off" }, state: { selected: 0, historyView: true, historySelected: 0, scroll }, width, height, now: NOW }).map((line) => line.map((span) => span.text).join(""))
    const frame = render()
    expect(frame).toHaveLength(height)
    expect(frame.every((line) => textWidth(line) <= width)).toBe(true)
    expect(frame[0]).toContain("esc")
    if (width < 70) expect(render(20).join("\n")).toContain("Execution identity")
    else {
      expect(frame.join("\n")).toContain("Causal authority")
      expect(frame.join("\n")).toContain("Frozen env")
      expect(frame.join("\n")).toContain("Grant history")
    }
  }
})

test("history selection clamps; history ignores revoke keys and exposes loading, empty and failure states", () => {
  const state = { selected: 0, historyView: true, historySelected: 0, historyCount: 2 }
  expect(permissionsPageKey(state, "k", []).state.historySelected).toBe(0)
  expect(permissionsPageKey(state, "j", []).state.historySelected).toBe(1)
  expect(permissionsPageKey({ ...state, historySelected: 1 }, "j", []).state.historySelected).toBe(1)
  expect(permissionsPageKey(state, "R", []).action.type).toBe("none")
  const frame = (extra: Partial<Parameters<typeof renderPermissionsPage>[0]>) => renderPermissionsPage({ mode: "smart", grants: [], reviewer: { kind: "off" }, state, width: 100, height: 30, now: NOW, ...extra }).flat().map((span) => span.text).join("")
  expect(frame({})).toContain("loading history…")
  expect(frame({ history: { reviews: [], grants: [] } })).toContain("No reviews")
  expect(frame({ historyError: "daemon unavailable" })).toContain("daemon unavailable")
})
