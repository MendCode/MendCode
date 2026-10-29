import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { SETUP_ROWS } from "../src/view/setup-page"
import { createApp } from "../src/ui/app"
import { activeTheme, glyphs, setTheme, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const sessionId = ids("session")

function harness() {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 160, height: 45 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const send = async (command: unknown) => {
    const c = command as Record<string, unknown>
    sent.push(c)
    if (c.type === "daemon.info") return { ok: true, result: { engine: "faux", dataDir: "/tmp/x", pid: 7, buildId: "deadbeefcafe" } }
    if (c.type === "mcp.status") return { ok: true, result: { servers: [{ name: "a" }, { name: "b" }], issues: [] } }
    if (c.type === "recipes.list" || c.type === "recipes.apply")
      return { ok: true, result: { recipes: [{ name: "balanced", file: "b", source: "builtin", description: "d", roles: {} }, { name: "deep", file: "d", source: "builtin", description: "d", roles: {} }, { name: "bad", file: "x", source: "user", description: "", roles: {}, problem: "invalid JSON" }], ...(c.type === "recipes.apply" ? { active: c.name } : {}) } }
    if (c.type === "memory.list") return { ok: true, result: { memories: [{ status: "saved" }, { status: "saved" }, { status: "pending" }, { status: "archived" }] } }
    return { ok: true }
  }
  const app = createApp({ sessionId, screen, directory: "/work/app", send: send as never, exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), daemonBuildId: "0123456789ab" })
  const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
  const sets = () => sent.filter((c) => c.type === "settings.set").map((c) => c.patch as Record<string, unknown>)
  return { app, text, sent, sets }
}

describe("first-run onboarding", () => {
  test("opens the setup page when settings are not onboarded, and loads the read-only checks", async () => {
    const { app, text, sent } = harness()
    await app.openSetup({ advanced: true })
    expect(app.page).toBe("setup")
    for (const type of ["daemon.info", "mcp.status", "memory.list"]) expect(sent.some((c) => c.type === type)).toBe(true)
    const rows = text().join("\n")
    expect(rows).toContain("welcome")
    expect(rows).toContain("connected")
    expect(rows).toContain("01234567")
    expect(rows).toContain("faux")
    expect(rows).toContain("2 servers configured")
    expect(rows).toContain("2 saved")
    expect(rows).toContain("1 to review")
  })
  test("does nothing once onboarded", async () => {
    const { app, sent } = harness()
    await app.openSetupIfFirstRun({ onboarded: true })
    expect(app.page).toBe("chat")
    expect(sent).toEqual([])
  })
  test("/setup reopens it without the welcome line after onboarding", async () => {
    const { app, text } = harness()
    app.applySettings({ onboarded: true })
    await app.onInput("/setup")
    await app.onInput("\r")
    expect(app.page).toBe("setup")
    expect(text().join("\n")).not.toContain("welcome")
  })
  test("choices save immediately and theme previews at once", async () => {
    const { app, sets, text } = harness()
    const before = activeTheme().name
    expect(before).toBe("mend")
    await app.openSetup({ advanced: true })
    await app.onKey("j")
    await app.onKey("\x1b[C")
    expect(sets()).toEqual([{ theme: "matrix" }])
    expect(activeTheme().name).toBe("matrix")
    const output = text().join("\n")
    expect(output).toContain("theme")
    expect(output).toContain("‹ matrix ›")
    await app.onKey("j")
    await app.onKey("\x1b[C")
    expect(sets().at(-1)).toEqual({ view: "full" })
    await app.onKey("j")
    await app.onKey("\x1b[C")
    expect(sets().at(-1)).toEqual({ defaultPermission: "edits" })
    await app.onKey("j")
    await app.onKey(" ")
    expect(sets().at(-1)).toEqual({ reducedMotion: true })
    setTheme(before)
  })
  test("dream accepts a typed time and rejects a bad one", async () => {
    const { app, sets, text } = harness()
    await app.openSetup({ advanced: true })
    for (let i = 0; i < 5; i++) await app.onKey("j")
    await app.onInput("2599")
    expect(sets().some((p) => "dreamAt" in p)).toBe(false)
    expect(text().join("\n")).toContain("time must be HH:MM")
    await app.onKey("\x1b")
    await app.onInput("0415")
    expect(sets().at(-1)).toEqual({ dreamAt: "04:15" })
  })
  test("done and esc mark onboarded and return to chat", async () => {
    const one = harness()
    await one.app.openSetup({ advanced: true })
    for (let i = 0; i < SETUP_ROWS.indexOf("done"); i++) await one.app.onKey("j")
    await one.app.onKey("\r")
    expect(one.app.page).toBe("chat")
    expect(one.sets().at(-1)).toEqual({ onboarded: true })
    const two = harness()
    await two.app.openSetup({ advanced: true })
    await two.app.onKey("\x1b")
    expect(two.app.page).toBe("chat")
    expect(two.sets().at(-1)).toEqual({ onboarded: true })
  })
  test("the first choice is the model recipe: arrows apply the next valid recipe, custom roles start at the first", async () => {
    const { app, sent, text } = harness()
    await app.openSetup({ advanced: true })
    await Bun.sleep(5)
    app.render()
    expect(text().join("\n")).toContain("‹ custom ›")
    await app.onKey("\x1b[C")
    expect(sent.filter((c) => c.type === "recipes.apply").map((c) => c.name)).toEqual(["balanced"])
    app.render()
    expect(text().join("\n")).toContain("‹ balanced ›")
    await app.onKey("\x1b[C")
    // The recipe with a problem is never offered.
    expect(sent.filter((c) => c.type === "recipes.apply").map((c) => c.name)).toEqual(["balanced", "deep"])
  })
})
