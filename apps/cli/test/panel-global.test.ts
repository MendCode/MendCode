import { afterAll, describe, expect, test } from "bun:test"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"
import { readSidebar, sidebarScope } from "../../../packages/daemon/src/sidebar"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { readSessionLook } from "../src/ui/app/session-look"
import { SIDEBAR_PRESETS } from "../src/view/sidebar-spec"
import type { SidebarWidget } from "@mendcode/protocol"

afterAll(cleanTemps)
const settle = () => Bun.sleep(15)

/** A terminal on a profile with the given cards; `/new` answers with a different session each time. */
function terminal({ widgets = structuredClone(SIDEBAR_PRESETS.pulse) as SidebarWidget[], shown = true }: { widgets?: SidebarWidget[]; shown?: boolean } = {}) {
  const dataDir = tempDir(), directory = tempDir(), sessionId = ids("session")
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", sidebarWidgets: widgets, rightSidebar: shown })
  const h = appHarness({ width: 200, height: 40, directory, dataDir, sessionId, mode: "full", reply: (command) => {
    if (command.type === "session.create") return { ok: true, result: { sessionId: ids("session") } }
    if (command.type === "sidebar.get") return { ok: true, result: { widgets: readSidebar(dataDir, directory), scope: sidebarScope(dataDir, directory) } }
    if (command.type === "git.status") return { ok: true, result: { branch: "main", ahead: 0, behind: 0, dirty: 0 } }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true, tier: "full" })
  return { ...h, dataDir }
}

describe("the right panel's visibility is the user's, in every session", () => {
  test("hiding or showing it holds in the next session and is saved in the profile, not in the session", async () => {
    const h = terminal()
    await settle()
    const first = h.app.sessionId
    await h.type("/panel\r")
    await settle()
    expect(h.app.accessibility.profile.rightSidebar).toBe(false)
    expect(readTuiProfile(h.dataDir).rightSidebar).toBe(false)
    await h.type("/new\r")
    expect(h.app.sessionId).not.toBe(first)
    expect(h.app.accessibility.profile.rightSidebar).toBe(false)
    await h.type("/panel\r")
    await settle()
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    const second = h.app.sessionId
    await h.type("/new\r")
    expect(h.app.sessionId).not.toBe(second)
    expect(h.app.accessibility.profile.rightSidebar).toBe(true)
    expect(readTuiProfile(h.dataDir).rightSidebar).toBe(true)
    for (const look of readSessionLook(h.dataDir).values()) expect("rightSidebar" in look).toBe(false)
  })
})

describe("switching sessions draws the panel at once", () => {
  const cards: SidebarWidget[] = [{ type: "loops", options: {} }, { type: "jobs", options: {} }, { type: "clock", options: {} }]

  test("leaving a session's own panel shows the profile's cards from the spec already read, without asking the daemon", async () => {
    const h = terminal({ widgets: cards })
    h.app.render()
    // The spec is read once (the app's start does it); a session's own panel is then chosen over it.
    await h.type("/panel\r")
    await h.type("/panel\r")
    await h.type("/panel pulse\r")
    expect(h.app.accessibility.profile.sidebarWidgets.map((widget) => widget.type)).not.toEqual(["loops", "jobs", "clock"])
    const before = h.sentOf("sidebar.get").length
    await h.type("/new\r")
    expect(h.app.accessibility.profile.sidebarWidgets.map((widget) => widget.type)).toEqual(["loops", "jobs", "clock"])
    expect(h.sentOf("sidebar.get").length - before).toBe(0)
  })

  test("a session of the same folder with the same cards does not ask for the folder-wide ones again", async () => {
    const h = terminal({ widgets: cards })
    h.app.render()
    await settle()
    h.app.render()
    expect(h.sentOf("loop.list").length).toBeGreaterThan(0)
    const before = { loops: h.sentOf("loop.list").length, jobs: h.sentOf("background.list").length }
    await h.type("/new\r")
    await settle()
    h.app.render()
    expect(h.sentOf("loop.list").length).toBe(before.loops)
    expect(h.sentOf("background.list").length).toBe(before.jobs)
  })
})
