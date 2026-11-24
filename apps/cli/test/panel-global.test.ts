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

describe("switching to a session of another project", () => {
  test("the cards of the project's own panel are asked for, not the other project's cards already read", async () => {
    const here = "/work/app", there = "/other/api", dataDir = tempDir(), sessionId = ids("session"), next = ids("session")
    const specs = new Map<string, SidebarWidget[]>([[here, [{ type: "loops", options: {} }, { type: "jobs", options: {} }]], [there, [{ type: "clock", options: {} }]]])
    const row = (id: string, title: string, directory: string, age: number) => ({ sessionId: id, title, directory, createdAt: Date.now() - age, updatedAt: Date.now() - age, lastSeq: 0, state: "idle", queued: 0 })
    const sessions = [row(sessionId, "Chrome", here, 1000), row(next, "Other project", there, 2000)]
    const clock = { at: Date.now() }
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", sidebarWidgets: specs.get(here)!, rightSidebar: true, sidebarProjectsFrom: "all" })
    const h = appHarness({ width: 200, height: 40, directory: here, dataDir, sessionId, mode: "full", now: () => clock.at, inspectProject: async () => ({ git: true }), reply: (command) => {
      if (command.type === "bot.list") return { ok: true, result: { bots: [], external: [], problems: [] } }
      if (command.type === "session.list") return { ok: true, result: { sessions } }
      if (command.type === "session.get") return { ok: true, result: { session: sessions.find((session) => session.sessionId === (command as { sessionId: string }).sessionId) } }
      if (command.type === "sidebar.get") return { ok: true, result: { widgets: specs.get(command.directory) ?? [], scope: "user" } }
      if (command.type === "git.status") return { ok: true, result: { branch: "main", ahead: 0, behind: 0, dirty: 0 } }
      return { ok: true }
    } })
    h.app.applySettings({ onboarded: true, tier: "full", experimental: { bots: true } })
    for (let turn = 0; turn < 100 && !h.text().some((line) => line.includes("Other project")); turn++) { h.app.render(); await Bun.sleep(5) }
    // The spec of this project is read once; the session then chooses its own panel, and leaving it must show the next project's cards.
    await h.type("/panel\r")
    await h.type("/panel\r")
    await h.type("/panel pulse\r")
    await settle()
    const asked = h.sentOf("sidebar.get").map((command) => (command as { directory: string }).directory)
    expect(asked.length).toBeGreaterThan(0)
    expect(new Set(asked)).toEqual(new Set([here]))
    clock.at += 600
    h.app.render()
    const at = h.text().findIndex((line) => line.includes("Other project"))
    expect(at).toBeGreaterThanOrEqual(0)
    await h.type(`\x1b[<0;${h.text()[at]!.indexOf("Other project") + 2};${at + 1}M`)
    await settle()
    h.app.render()
    expect(h.app.sessionId).toBe(next)
    expect(h.app.accessibility.profile.sidebarWidgets.map((widget) => widget.type)).toEqual(["clock"])
  })
})
