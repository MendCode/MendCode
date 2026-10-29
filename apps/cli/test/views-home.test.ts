import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

/** The Agent View rows of the home screen are clickable, in the built-in look and in a custom `home` view. */

function homeApp(options: { view?: string } = {}) {
  const dataDir = tempDir()
  if (options.view) {
    mkdirSync(path.join(dataDir, "extensions"), { recursive: true })
    writeFileSync(path.join(dataDir, "extensions", "home.ts"), `export default { name: "home", tui(api) {\n${options.view}\n} }\n`)
  }
  const current = ids("session")
  const other = ids("session")
  const h = appHarness({ width: 100, height: 40, mode: "balanced", sessionId: current, dataDir, directory: "/work/app" })
  h.app.applySettings({ onboarded: true })
  h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: other, directory: "/work/app", title: "Cache key bug", state: "generating", updatedAt: NOW } as never)
  return { ...h, other, current }
}

const rowOf = (h: ReturnType<typeof homeApp>, text: string) => h.text().findIndex((row) => row.includes(text))

describe("home clicks", () => {
  test("a click on a session row of the Agent View switches to it", async () => {
    const h = homeApp()
    await h.app.extensionsReady
    h.app.render()
    const row = rowOf(h, "Cache key bug")
    expect(row).toBeGreaterThanOrEqual(0)
    const col = h.text()[row]!.indexOf("Cache key bug")
    await h.type(`\x1b[<0;${col + 1};${row + 1}M`)
    expect(h.subscriptions.some((entry) => entry.sessionId === h.other)).toBe(true)
  })

  test("a click on a finished session under Completed switches to it", async () => {
    const h = homeApp()
    const done = ids("session")
    await h.app.extensionsReady
    h.app.onGlobal({ type: "session.activity", gseq: 2, at: NOW, sessionId: done, directory: "/work/app", title: "Mejoras y DMG", state: "idle", updatedAt: NOW - 86_400_000 } as never)
    h.app.render()
    const row = rowOf(h, "Mejoras y DMG")
    expect(row).toBeGreaterThan(rowOf(h, "Completed"))
    const col = h.text()[row]!.indexOf("Mejoras y DMG")
    await h.type(`\x1b[<0;${col + 1};${row + 1}M`)
    expect(h.subscriptions.some((entry) => entry.sessionId === done)).toBe(true)
  })

  test("the row under the mouse is highlighted like the selected one and the pointer becomes a hand, until the mouse leaves", async () => {
    const h = homeApp()
    await h.app.extensionsReady
    h.app.render()
    const row = rowOf(h, "Cache key bug")
    const col = h.text()[row]!.indexOf("Cache key bug")
    const lit = () => h.frames.at(-1)![row]!.some((span) => span.bg === "element" && span.text.includes("Cache key bug"))
    expect(lit()).toBe(false)
    await h.app.onKey(`\x1b[<35;${col + 1};${row + 1}M`)
    h.app.render()
    expect(lit()).toBe(true)
    expect(h.written.at(-1)).toBe("\x1b]22;pointer\x1b\\")
    await h.app.onKey("\x1b[<35;1;1M")
    h.app.render()
    expect(lit()).toBe(false)
    expect(h.written.at(-1)).toBe("\x1b]22;default\x1b\\")
  })

  test("a click beside the Agent View does nothing", async () => {
    const h = homeApp()
    await h.app.extensionsReady
    h.app.render()
    await h.type("\x1b[<0;1;1M")
    expect(h.subscriptions.some((entry) => entry.sessionId === h.other)).toBe(false)
  })

  test("a custom home view names its clickable rows with action open and a listed session", async () => {
    const h = homeApp({ view: `api.view("home", (m) => [[{ text: "pick -> " }, ...m.sessions.map((s) => ({ text: s.title, action: "open", arg: s.id }))]])` })
    await h.app.extensionsReady
    h.app.render()
    const row = rowOf(h, "pick -> Cache key bug")
    expect(row).toBeGreaterThanOrEqual(0)
    const col = h.text()[row]!.indexOf("Cache key bug")
    await h.type(`\x1b[<0;${col + 1};${row + 1}M`)
    expect(h.subscriptions.some((entry) => entry.sessionId === h.other)).toBe(true)
  })

  test("a custom home view that names a session that is not listed is invalid output", async () => {
    const h = homeApp({ view: `api.view("home", () => [[{ text: "ZZZ", action: "open", arg: "nope" }]])` })
    await h.app.extensionsReady
    h.app.render()
    expect(h.text().join("\n")).not.toContain("ZZZ")
    expect(h.text().join("\n")).toContain("Cache key bug")
  })
})
